/**
 * Inventory / product catalog business logic for Harvestlink.
 *
 * Store scope: cashiers and store admins may only touch products for req.user.storeId.
 * COOP_ADMIN may target any store via an explicit storeId argument (from query/body).
 *
 * SKU identity (sku/name/category/taxExempt) lives on CatalogItem. Location Products hold
 * local price/cost/stock. Retail price must stay ≤ CatalogItem.maxShelfPrice.
 *
 * /// The co-op owns the stock under the percentage-of-sales model, so a store pricing below the
 * /// ceiling lowers the co-op's revenue as well as its own. The audit trail shows who and when.
 *
 * Manual stock adjustments always require a logged reason — shrink, damage, and recount
 * deltas must be auditable so settlement and shrinkage reports stay trustworthy.
 */
import { LocationType, LotStatus, Prisma, Role, type Product } from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import {
  lockCatalogItemById,
  lockCatalogItemBySku,
  lockLots,
  lockProducts,
} from "../lib/locks.js";
import { moneyDec, unitCostDec } from "../lib/money.js";
import { prisma } from "../lib/prisma.js";
import { resolveStoreScope } from "../lib/storeScope.js";
import type { AuthUser } from "../types/auth.js";
import { addLot, createProductRow, leaveSellableRollup, setLotRemaining } from "./stockEngine.js";

const BLOCKED_ADJUST_STATUSES: LotStatus[] = [
  LotStatus.QUARANTINED,
  LotStatus.RECALLED,
  LotStatus.EXPIRED,
];

export { resolveStoreScope };

/** True when the role may see cost / unitCost / supplier pricing on inventory DTOs. */
function roleSeesCost(role: Role): boolean {
  return role === Role.STORE_ADMIN || role === Role.COOP_ADMIN;
}

/**
 * CASHIER product DTO — price + stock/availability for POS; never cost.
 * Identity fields stay so the till can ring and display the line.
 */
export type ProductCashierView = {
  id: string;
  storeId: string;
  catalogItemId: string | null;
  sku: string;
  name: string;
  category: string;
  price: Prisma.Decimal;
  stock: number;
  reserved: number;
  /** Sellable units = stock - reserved (what POS / UI should show). */
  available: number;
  reorderAt: number;
  taxExempt: boolean;
  createdAt: Date;
  updatedAt: Date;
  lowStock: boolean;
  /**
   * When available is 0 but QUARANTINED/RECALLED lots still hold units,
   * POS must show a recall message — not a generic out-of-stock cue.
   */
  blockedByQuarantineOrRecall: boolean;
};

/** STORE_ADMIN / COOP_ADMIN product DTO — includes unit cost. */
export type ProductAdminView = ProductCashierView & {
  cost: Prisma.Decimal;
};

export type ProductView = ProductCashierView | ProductAdminView;

/** @deprecated Prefer ProductView — kept as alias for admin mutation return typing. */
export type ProductWithLowStock = ProductAdminView;

export type ExpiringLotCashierView = {
  id: string;
  lotNumber: string;
  productId: string;
  sku: string;
  productName: string;
  quantityRemaining: number;
  quantityReserved: number;
  expiryDate: Date;
  daysUntilExpiry: number;
};

export type ExpiringLotAdminView = ExpiringLotCashierView & {
  unitCost: string;
};

export type ExpiringLotView = ExpiringLotCashierView | ExpiringLotAdminView;

export type CreateProductInput = {
  /** Preferred: link to an existing network CatalogItem. */
  catalogItemId?: string;
  /** Used to resolve CatalogItem when catalogItemId omitted. */
  sku?: string;
  /** Ignored when catalogItemId/sku resolves — identity comes from CatalogItem. */
  name?: string;
  category?: string;
  taxExempt?: boolean;
  /** Retail price (≤ ceiling). Ignored at WAREHOUSE — set to ceiling. */
  price?: number;
  cost: number;
  stock: number;
  reorderAt: number;
};

export type UpdateProductInput = Partial<{
  sku: string;
  name: string;
  category: string;
  price: number;
  cost: number;
  reorderAt: number;
  taxExempt: boolean;
}>;

export type AdjustLotInput = {
  lotId: string;
  /** Absolute quantityRemaining to set on the lot after the adjustment. */
  newQuantity: number;
  /** Required audit explanation (shrinkage, damage, receiving fix, etc.). */
  reason: string;
  /**
   * Required (COOP_ADMIN only) when adjusting a QUARANTINED / RECALLED / EXPIRED lot —
   * same gate as stock-count `overrideBlockedLots`.
   */
  overrideBlockedLot?: boolean;
  /** Required when overrideBlockedLot is true. */
  overrideReason?: string;
  /** Client IP for the platform AuditLog. */
  ipAddress?: string | null;
};

function toProductView(
  product: Product,
  role: Role,
  blockedByQuarantineOrRecall = false,
): ProductView {
  const available = product.stock - product.reserved;
  const base: ProductCashierView = {
    id: product.id,
    storeId: product.storeId,
    catalogItemId: product.catalogItemId,
    sku: product.sku,
    name: product.name,
    category: product.category,
    price: product.price,
    stock: product.stock,
    reserved: product.reserved,
    available,
    // Reorder alerts use available stock so reserved holds do not hide a true low-stock state.
    reorderAt: product.reorderAt,
    taxExempt: product.taxExempt,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    lowStock: available <= product.reorderAt,
    blockedByQuarantineOrRecall: available <= 0 && blockedByQuarantineOrRecall,
  };
  if (roleSeesCost(role)) {
    return { ...base, cost: product.cost };
  }
  return base;
}

/**
 * Lists products for one store.
 * UI-facing available qty is stock - reserved; lowStock compares available to reorderAt.
 * Cost fields are omitted for CASHIER — mapped here, not stripped in the route.
 */
export async function listProducts(storeId: string, actor: AuthUser): Promise<ProductView[]> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new AppError(404, "Store not found");
  }

  const products = await prisma.product.findMany({
    where: { storeId },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  const blockedLots = await prisma.lot.groupBy({
    by: ["productId"],
    where: {
      storeId,
      status: { in: [LotStatus.QUARANTINED, LotStatus.RECALLED] },
      quantityRemaining: { gt: 0 },
    },
    _sum: { quantityRemaining: true },
  });
  const blockedProductIds = new Set(
    blockedLots
      .filter((row) => (row._sum.quantityRemaining ?? 0) > 0)
      .map((row) => row.productId),
  );

  return products.map((p) => toProductView(p, actor.role, blockedProductIds.has(p.id)));
}

/**
 * ACTIVE lots whose expiryDate falls on or before (now + days).
 * Includes overdue lots still ACTIVE (expiry job not yet run) so stores can act.
 * CASHIER sees expiry/qty only — never unitCost.
 */
export async function listExpiringLots(
  storeId: string,
  days: number,
  actor: AuthUser,
): Promise<ExpiringLotView[]> {
  if (!Number.isInteger(days) || days < 0) {
    throw new AppError(400, "days must be a non-negative integer");
  }

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new AppError(404, "Store not found");
  }

  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const lots = await prisma.lot.findMany({
    where: {
      storeId,
      status: LotStatus.ACTIVE,
      expiryDate: { not: null, lte: until },
    },
    include: {
      product: { select: { sku: true, name: true } },
    },
    orderBy: [{ expiryDate: "asc" }, { receivedAt: "asc" }],
  });

  const msPerDay = 24 * 60 * 60 * 1000;
  const includeCost = roleSeesCost(actor.role);
  return lots.map((lot) => {
    const expiryDate = lot.expiryDate!;
    const base: ExpiringLotCashierView = {
      id: lot.id,
      lotNumber: lot.lotNumber,
      productId: lot.productId,
      sku: lot.product.sku,
      productName: lot.product.name,
      quantityRemaining: lot.quantityRemaining,
      quantityReserved: lot.quantityReserved,
      expiryDate,
      daysUntilExpiry: Math.ceil((expiryDate.getTime() - now.getTime()) / msPerDay),
    };
    if (includeCost) {
      return { ...base, unitCost: lot.unitCost.toFixed(4) };
    }
    return base;
  });
}

/**
 * Creates a location Product linked to a CatalogItem. SKU uniqueness remains per store.
 */
export async function createProduct(
  storeId: string,
  input: CreateProductInput,
  actor: AuthUser,
  ipAddress?: string | null,
): Promise<ProductView> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store || !store.isActive) {
    throw new AppError(400, "Store not found or inactive");
  }

  if (store.locationType !== LocationType.WAREHOUSE && input.price === undefined) {
    throw new AppError(400, "price is required at a retail store");
  }

  try {
    // LOCK ORDER: CatalogItem (rule 0) FOR UPDATE, then Product — serialises with updateCatalogItem.
    const product = await prisma.$transaction(async (tx) => {
      const catalog = input.catalogItemId
        ? await lockCatalogItemById(tx, input.catalogItemId)
        : input.sku
          ? await lockCatalogItemBySku(tx, input.sku.trim())
          : null;
      if (!catalog || !catalog.isActive) {
        throw new AppError(
          400,
          "Product must link to an active CatalogItem (pass catalogItemId or a known sku)",
        );
      }

      let price: Prisma.Decimal;
      if (store.locationType === LocationType.WAREHOUSE) {
        // Warehouse products are never sold at a till — store the catalog ceiling as price.
        price = catalog.maxShelfPrice;
      } else {
        price = moneyDec(input.price!);
        if (price.gt(catalog.maxShelfPrice)) {
          throw new AppError(400, "Price exceeds the co-op shelf ceiling for this SKU", {
            maxShelfPrice: catalog.maxShelfPrice.toFixed(2),
            price: price.toFixed(2),
            sku: catalog.sku,
          });
        }
      }

      // Product.stock always starts at 0; opening units live in an OPENING lot (addLot).
      const created = await createProductRow(tx, {
        storeId,
        catalogItemId: catalog.id,
        sku: catalog.sku,
        name: catalog.name,
        category: catalog.category,
        price,
        cost: unitCostDec(input.cost),
        stock: 0,
        reorderAt: input.reorderAt,
        taxExempt: catalog.taxExempt,
      });

      if (input.stock > 0) {
        if (!(input.cost >= 0) || Number.isNaN(input.cost)) {
          throw new AppError(400, "cost is required when opening stock is greater than zero");
        }
        const [locked] = await lockProducts(tx, [created.id]);
        if (!locked) throw new AppError(500, "Failed to lock newly created product");
        const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const openingLot = await addLot(tx, locked, {
          lotNumber: `OPENING-${catalog.sku}-${yyyymmdd}`,
          storeId,
          supplierId: null,
          quantity: input.stock,
          unitCost: unitCostDec(input.cost),
        });
        await tx.stockAdjustment.create({
          data: {
            productId: created.id,
            storeId,
            adjustedById: actor.id,
            previousStock: 0,
            newStock: input.stock,
            delta: input.stock,
            reason: "OPENING_STOCK",
            lotId: openingLot.id,
            lotPreviousQty: 0,
            lotNewQty: input.stock,
          },
        });
      }

      await writeAuditLog(
        {
          userId: actor.id,
          storeId,
          action: AuditAction.PRODUCT_PRICE_CHANGE,
          entityType: "Product",
          entityId: created.id,
          before: null,
          after: {
            price: created.price.toFixed(2),
            reason: "PRODUCT_CREATE",
            catalogItemId: catalog.id,
            maxShelfPrice: catalog.maxShelfPrice.toFixed(2),
          },
          ipAddress: ipAddress ?? null,
        },
        { tx },
      );
      return tx.product.findUniqueOrThrow({ where: { id: created.id } });
    });
    return toProductView(product, actor.role);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "SKU already exists for this store");
    }
    throw error;
  }
}

/**
 * Ensures the product belongs to the resolved store scope before mutation/read-by-id.
 */
async function getScopedProduct(productId: string, storeId: string): Promise<Product> {
  const product = await prisma.product.findFirst({
    where: { id: productId, storeId },
  });

  if (!product) {
    throw new AppError(404, "Product not found for this store");
  }

  return product;
}

/**
 * Updates local fields (price/cost/reorderAt). Identity fields are owned by CatalogItem —
 * editing them here is rejected. Stock changes go through adjustLot.
 * Product.cost is COOP_ADMIN only (weighted average on receipt is the normal path).
 */
export async function updateProduct(
  productId: string,
  storeId: string,
  input: UpdateProductInput,
  actor: AuthUser,
  ipAddress?: string | null,
): Promise<ProductView> {
  const existing = await getScopedProduct(productId, storeId);
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });

  if (
    input.sku !== undefined ||
    input.name !== undefined ||
    input.category !== undefined ||
    input.taxExempt !== undefined
  ) {
    throw new AppError(
      400,
      "sku, name, category and taxExempt are owned by the CatalogItem — edit the catalog (COOP_ADMIN)",
      { catalogItemId: existing.catalogItemId },
    );
  }

  if (input.cost !== undefined && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only COOP_ADMIN may change product cost");
  }

  if (input.price !== undefined) {
    if (store.locationType === LocationType.WAREHOUSE && actor.role !== Role.COOP_ADMIN) {
      throw new AppError(403, "Only COOP_ADMIN may change a warehouse product price");
    }
  }

  try {
    // LOCK ORDER: CatalogItem (rule 0) FOR UPDATE, then Product — serialises with updateCatalogItem.
    const product = await prisma.$transaction(async (tx) => {
      let nextPrice: Prisma.Decimal | undefined;
      if (input.price !== undefined) {
        nextPrice = moneyDec(input.price);
        if (existing.catalogItemId) {
          const catalog = await lockCatalogItemById(tx, existing.catalogItemId);
          if (!catalog) {
            throw new AppError(404, "CatalogItem not found for product", {
              catalogItemId: existing.catalogItemId,
            });
          }
          if (
            store.locationType === LocationType.RETAIL_STORE &&
            nextPrice.gt(catalog.maxShelfPrice)
          ) {
            throw new AppError(400, "Price exceeds the co-op shelf ceiling for this SKU", {
              maxShelfPrice: catalog.maxShelfPrice.toFixed(2),
              price: nextPrice.toFixed(2),
              sku: catalog.sku,
            });
          }
        }
      }

      const nextCost =
        input.cost !== undefined ? unitCostDec(input.cost) : undefined;

      const updated = await tx.product.update({
        where: { id: productId },
        data: {
          ...(nextPrice !== undefined ? { price: nextPrice } : {}),
          ...(nextCost !== undefined ? { cost: nextCost } : {}),
          ...(input.reorderAt !== undefined ? { reorderAt: input.reorderAt } : {}),
        },
      });

      if (nextPrice !== undefined && !existing.price.equals(nextPrice)) {
        await writeAuditLog(
          {
            userId: actor.id,
            storeId,
            action: AuditAction.PRODUCT_PRICE_CHANGE,
            entityType: "Product",
            entityId: productId,
            before: { price: existing.price.toFixed(2) },
            after: { price: nextPrice.toFixed(2) },
            ipAddress: ipAddress ?? null,
          },
          { tx },
        );
      }

      if (nextCost !== undefined && !existing.cost.equals(nextCost)) {
        await writeAuditLog(
          {
            userId: actor.id,
            storeId,
            action: AuditAction.PRODUCT_COST_CHANGE,
            entityType: "Product",
            entityId: productId,
            before: { cost: existing.cost.toFixed(4) },
            after: { cost: nextCost.toFixed(4), reason: "MANUAL" },
            ipAddress: ipAddress ?? null,
          },
          { tx },
        );
      }
      return updated;
    });
    return toProductView(product, actor.role);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "SKU already exists for this store");
    }
    throw error;
  }
}

/**
 * Soft-removes a product from the catalog by deleting the row when no sale history
 * blocks it. Callers should prefer deactivating via future flags if sales reference it.
 */
export async function deleteProduct(productId: string, storeId: string): Promise<void> {
  await getScopedProduct(productId, storeId);

  try {
    await prisma.product.delete({ where: { id: productId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      throw new AppError(
        409,
        "Product cannot be deleted because it is referenced by existing sales",
      );
    }
    throw error;
  }
}

/**
 * Lot-level manual quantity adjustment via setLotRemaining.
 *
 * /// A stock change with no lot has no cost and no traceability. Every unit lives in a lot.
 *
 * Decrease → InventoryWriteOff at the lot's unitCost (reason MANUAL:<reason>) + StockAdjustment.
 * Increase → StockAdjustment (reason MANUAL:<reason>). StockAdjustment.delta is the LOT delta;
 * previousStock/newStock remain the product rollup; lotPreviousQty/lotNewQty record the lot.
 */
export async function adjustLot(
  productId: string,
  storeId: string,
  actor: AuthUser,
  input: AdjustLotInput,
): Promise<{
  product: ProductWithLowStock;
  lotId: string;
  previousQty: number;
  newQuantity: number;
  delta: number;
  reason: string;
}> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(400, "A non-empty reason is required for manual stock adjustments");
  }
  if (!Number.isInteger(input.newQuantity) || input.newQuantity < 0) {
    throw new AppError(400, "newQuantity must be a non-negative integer");
  }
  const overrideReason = input.overrideReason?.trim() ?? "";
  if (input.overrideBlockedLot && !overrideReason) {
    throw new AppError(400, "overrideReason is required when overriding a blocked lot");
  }
  if (input.overrideBlockedLot && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only COOP_ADMIN may override QUARANTINED, RECALLED or EXPIRED lots");
  }

  const result = await prisma.$transaction(async (tx) => {
    // LOCK ORDER: Product then Lot.
    const [product] = await lockProducts(tx, [productId]);
    if (!product || product.storeId !== storeId) {
      throw new AppError(404, "Product not found for this store");
    }
    const [lot] = await lockLots(tx, [input.lotId]);
    if (!lot || lot.productId !== productId || lot.storeId !== storeId) {
      throw new AppError(404, "Lot not found for this product");
    }

    const lotStatus = lot.status as LotStatus;
    const isBlocked = BLOCKED_ADJUST_STATUSES.includes(lotStatus);
    if (isBlocked && !input.overrideBlockedLot) {
      throw new AppError(
        409,
        "Cannot adjust a QUARANTINED, RECALLED or EXPIRED lot without an explicit override",
        { lotId: lot.id, lotNumber: lot.lotNumber, status: lotStatus },
      );
    }

    const productStockBefore = product.stock;
    const adjusted = await setLotRemaining(tx, product, lot, input.newQuantity);
    if (adjusted.delta === 0) {
      throw new AppError(400, "newQuantity matches current lot quantity; no adjustment needed");
    }

    const productStockAfter = productStockBefore + adjusted.rollupDelta;
    const ledgerReason = `MANUAL:${reason}`;
    let writeOffId: string | null = null;

    if (adjusted.delta < 0) {
      const qty = -adjusted.delta;
      const unitCost = lot.unitCost;
      const writeOff = await tx.inventoryWriteOff.create({
        data: {
          storeId,
          productId,
          lotId: lot.id,
          quantity: qty,
          reason: ledgerReason,
          unitCost,
          value: moneyDec(unitCost.mul(qty)),
        },
      });
      writeOffId = writeOff.id;
    }

    const adjustment = await tx.stockAdjustment.create({
      data: {
        productId,
        storeId,
        adjustedById: actor.id,
        previousStock: productStockBefore,
        newStock: productStockAfter,
        delta: adjusted.delta,
        reason: ledgerReason,
        lotId: lot.id,
        lotPreviousQty: adjusted.previousQty,
        lotNewQty: input.newQuantity,
      },
    });

    if (isBlocked) {
      await writeAuditLog(
        {
          userId: actor.id,
          storeId,
          action: AuditAction.STOCK_COUNT_BLOCKED_LOT_OVERRIDE,
          entityType: "Lot",
          entityId: lot.id,
          before: { status: lotStatus, quantityRemaining: adjusted.previousQty },
          after: {
            quantityRemaining: input.newQuantity,
            overrideReason,
            reason: ledgerReason,
            stockAdjustmentId: adjustment.id,
          },
          ipAddress: input.ipAddress ?? null,
        },
        { tx },
      );
    }

    await writeAuditLog(
      {
        userId: actor.id,
        storeId,
        action: AuditAction.STOCK_ADJUSTMENT,
        entityType: "Lot",
        entityId: lot.id,
        before: {
          quantityRemaining: adjusted.previousQty,
          productStock: productStockBefore,
        },
        after: {
          quantityRemaining: input.newQuantity,
          productStock: productStockAfter,
          delta: adjusted.delta,
          reason: ledgerReason,
          writeOffId,
          stockAdjustmentId: adjustment.id,
          overrideBlockedLot: isBlocked,
        },
        ipAddress: input.ipAddress ?? null,
      },
      { tx },
    );

    const updated = await tx.product.findUniqueOrThrow({ where: { id: productId } });
    return {
      product: updated,
      lotId: lot.id,
      previousQty: adjusted.previousQty,
      newQuantity: input.newQuantity,
      delta: adjusted.delta,
      reason: ledgerReason,
    };
  });

  return {
    ...result,
    product: toProductView(result.product, actor.role) as ProductWithLowStock,
  };
}

/** CASHIER lot DTO — identity, qty, expiry, status; never unitCost or supplier pricing. */
export type LotCashierView = {
  id: string;
  lotNumber: string;
  productId: string;
  sku: string;
  productName: string;
  storeId: string;
  status: LotStatus;
  quantityReceived: number;
  quantityRemaining: number;
  quantityReserved: number;
  expiryDate: Date | null;
  receivedAt: Date;
  countryOfOrigin: string | null;
  barcode: string | null;
  daysUntilExpiry: number | null;
};

export type LotAdminView = LotCashierView & {
  unitCost: string;
  supplier: { id: string; name: string } | null;
};

export type LotListItem = LotCashierView | LotAdminView;

function toLotListItem(
  lot: {
    id: string;
    lotNumber: string;
    productId: string;
    storeId: string;
    status: LotStatus;
    quantityReceived: number;
    quantityRemaining: number;
    quantityReserved: number;
    expiryDate: Date | null;
    receivedAt: Date;
    unitCost: Prisma.Decimal;
    countryOfOrigin: string | null;
    barcode: string | null;
    product: { sku: string; name: string };
    supplier: { id: string; name: string } | null;
  },
  role: Role,
  now = new Date(),
): LotListItem {
  const msPerDay = 24 * 60 * 60 * 1000;
  const base: LotCashierView = {
    id: lot.id,
    lotNumber: lot.lotNumber,
    productId: lot.productId,
    sku: lot.product.sku,
    productName: lot.product.name,
    storeId: lot.storeId,
    status: lot.status,
    quantityReceived: lot.quantityReceived,
    quantityRemaining: lot.quantityRemaining,
    quantityReserved: lot.quantityReserved,
    expiryDate: lot.expiryDate,
    receivedAt: lot.receivedAt,
    countryOfOrigin: lot.countryOfOrigin,
    barcode: lot.barcode,
    daysUntilExpiry: lot.expiryDate
      ? Math.ceil((lot.expiryDate.getTime() - now.getTime()) / msPerDay)
      : null,
  };
  if (roleSeesCost(role)) {
    return {
      ...base,
      unitCost: lot.unitCost.toFixed(4),
      supplier: lot.supplier,
    };
  }
  return base;
}

/**
 * Lots for one product (Inventory expand). Ordered FEFO.
 */
export async function listLotsForProduct(
  storeId: string,
  productId: string,
  actor: AuthUser,
): Promise<LotListItem[]> {
  await getScopedProduct(productId, storeId);
  const lots = await prisma.lot.findMany({
    where: { storeId, productId },
    include: {
      product: { select: { sku: true, name: true } },
      supplier: { select: { id: true, name: true } },
    },
    orderBy: [{ expiryDate: "asc" }, { receivedAt: "asc" }],
  });
  return lots.map((l) => toLotListItem(l, actor.role));
}

export type ListLotsFilter = {
  storeId: string;
  q?: string;
  status?: LotStatus;
  /** Only lots with expiryDate on or before this instant (near-expiry / overdue). */
  expiryBefore?: Date;
  /** Only lots with expiryDate on or after this instant. */
  expiryAfter?: Date;
  productId?: string;
};

/**
 * Store-scoped lot search for the Lots page.
 */
export async function listLots(filter: ListLotsFilter, actor: AuthUser): Promise<LotListItem[]> {
  const store = await prisma.store.findUnique({ where: { id: filter.storeId } });
  if (!store) throw new AppError(404, "Store not found");

  const q = filter.q?.trim();
  const lots = await prisma.lot.findMany({
    where: {
      storeId: filter.storeId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.productId ? { productId: filter.productId } : {}),
      ...(filter.expiryBefore || filter.expiryAfter
        ? {
            expiryDate: {
              ...(filter.expiryAfter ? { gte: filter.expiryAfter } : {}),
              ...(filter.expiryBefore ? { lte: filter.expiryBefore } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { lotNumber: { contains: q, mode: "insensitive" } },
              { barcode: { equals: q, mode: "insensitive" } },
              { product: { sku: { contains: q, mode: "insensitive" } } },
              { product: { name: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    include: {
      product: { select: { sku: true, name: true } },
      supplier: { select: { id: true, name: true } },
    },
    orderBy: [{ expiryDate: "asc" }, { lotNumber: "asc" }],
    take: 200,
  });
  return lots.map((l) => toLotListItem(l, actor.role));
}

/**
 * Standalone quarantine (STORE_ADMIN+). Leaves sellable rollup immediately.
 * Prefer a full Recall for regulatory campaigns — this is the ops "pull it now" action.
 */
export async function quarantineLot(
  actor: AuthUser,
  storeId: string,
  lotId: string,
  reason: string,
  ipAddress?: string | null,
): Promise<LotListItem> {
  if (actor.role !== Role.STORE_ADMIN && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only STORE_ADMIN or COOP_ADMIN can quarantine lots");
  }
  const trimmed = reason.trim();
  if (!trimmed) throw new AppError(400, "Quarantine reason is required");

  const updated = await prisma.$transaction(async (tx) => {
    const lot = await tx.lot.findFirst({
      where: { id: lotId, storeId },
      include: {
        product: { select: { sku: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    if (!lot) throw new AppError(404, "Lot not found for this store");
    if (lot.status === LotStatus.QUARANTINED) {
      return lot;
    }
    if (lot.status !== LotStatus.ACTIVE) {
      throw new AppError(409, "Only ACTIVE lots can be quarantined", {
        status: lot.status,
      });
    }

    // Product → Lot before leaving the sellable rollup (lib/locks.ts).
    const [lockedProduct] = await lockProducts(tx, [lot.productId]);
    const [lockedLot] = await lockLots(tx, [lot.id]);
    if (!lockedProduct || !lockedLot || lockedLot.status !== LotStatus.ACTIVE) {
      throw new AppError(409, "Only ACTIVE lots can be quarantined", {
        status: lockedLot?.status ?? lot.status,
      });
    }
    if (lockedLot.quantityReserved > 0) {
      throw new AppError(
        409,
        "Cannot quarantine lot with open reservations — finalize or expire pending sales first",
        { quantityReserved: lockedLot.quantityReserved },
      );
    }

    await leaveSellableRollup(tx, lockedProduct, lockedLot, LotStatus.QUARANTINED);
    const next = await tx.lot.findUniqueOrThrow({
      where: { id: lot.id },
      include: {
        product: { select: { sku: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog(
      {
        userId: actor.id,
        storeId,
        action: AuditAction.LOT_QUARANTINE,
        entityType: "Lot",
        entityId: lot.id,
        before: { status: LotStatus.ACTIVE, quantityRemaining: lockedLot.quantityRemaining },
        after: { status: LotStatus.QUARANTINED, reason: trimmed },
        ipAddress: ipAddress ?? null,
      },
      { tx },
    );

    return next;
  });

  return toLotListItem(updated, actor.role);
}

