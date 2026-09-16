/**
 * Inventory / product catalog business logic for Harvestlink.
 *
 * Store scope: cashiers and store admins may only touch products for req.user.storeId.
 * COOP_ADMIN may target any store via an explicit storeId argument (from query/body).
 *
 * Manual stock adjustments always require a logged reason — shrink, damage, and recount
 * deltas must be auditable so settlement and shrinkage reports stay trustworthy.
 */
import { LotStatus, Prisma, Role, type Product } from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { resolveStoreScope } from "../lib/storeScope.js";
import type { AuthUser } from "../types/auth.js";

export { resolveStoreScope };

export type ProductWithLowStock = Product & {
  /** Sellable units = stock - reserved (what POS / UI should show). */
  available: number;
  lowStock: boolean;
};

export type ExpiringLotView = {
  id: string;
  lotNumber: string;
  productId: string;
  sku: string;
  productName: string;
  quantityRemaining: number;
  quantityReserved: number;
  expiryDate: Date;
  unitCost: string;
  daysUntilExpiry: number;
};

export type CreateProductInput = {
  sku: string;
  name: string;
  category: string;
  price: number;
  cost: number;
  stock: number;
  reorderAt: number;
  taxExempt?: boolean;
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

export type AdjustStockInput = {
  /** Absolute on-hand quantity to set after the adjustment. */
  newStock: number;
  /** Required audit explanation (shrinkage, cycle count, receiving fix, etc.). */
  reason: string;
  /** Client IP for the platform AuditLog (in addition to StockAdjustment.reason). */
  ipAddress?: string | null;
};

function toProductView(product: Product): ProductWithLowStock {
  const available = product.stock - product.reserved;
  return {
    ...product,
    available,
    // Reorder alerts use available stock so reserved holds do not hide a true low-stock state.
    lowStock: available <= product.reorderAt,
  };
}

/**
 * Lists products for one store.
 * UI-facing available qty is stock - reserved; lowStock compares available to reorderAt.
 */
export async function listProducts(storeId: string): Promise<ProductWithLowStock[]> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new AppError(404, "Store not found");
  }

  const products = await prisma.product.findMany({
    where: { storeId },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  return products.map(toProductView);
}

/**
 * ACTIVE lots whose expiryDate falls on or before (now + days).
 * Includes overdue lots still ACTIVE (expiry job not yet run) so stores can act.
 */
export async function listExpiringLots(
  storeId: string,
  days: number,
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
  return lots.map((lot) => {
    const expiryDate = lot.expiryDate!;
    return {
      id: lot.id,
      lotNumber: lot.lotNumber,
      productId: lot.productId,
      sku: lot.product.sku,
      productName: lot.product.name,
      quantityRemaining: lot.quantityRemaining,
      quantityReserved: lot.quantityReserved,
      expiryDate,
      unitCost: lot.unitCost.toFixed(2),
      daysUntilExpiry: Math.ceil((expiryDate.getTime() - now.getTime()) / msPerDay),
    };
  });
}

/**
 * Creates a catalog product for a store. SKU must be unique within that store only.
 */
export async function createProduct(
  storeId: string,
  input: CreateProductInput,
): Promise<ProductWithLowStock> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store || !store.isActive) {
    throw new AppError(400, "Store not found or inactive");
  }

  try {
    const product = await prisma.product.create({
      data: {
        storeId,
        sku: input.sku,
        name: input.name,
        category: input.category,
        price: new Prisma.Decimal(input.price),
        cost: new Prisma.Decimal(input.cost),
        stock: input.stock,
        reorderAt: input.reorderAt,
        taxExempt: input.taxExempt ?? false,
      },
    });
    return toProductView(product);
  } catch (error) {
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
 * Updates catalog fields (not stock). Stock changes go through adjustStock so every
 * quantity change outside of POS sales is explicitly reasoned and audited.
 */
export async function updateProduct(
  productId: string,
  storeId: string,
  input: UpdateProductInput,
): Promise<ProductWithLowStock> {
  await getScopedProduct(productId, storeId);

  try {
    const product = await prisma.product.update({
      where: { id: productId },
      data: {
        ...(input.sku !== undefined ? { sku: input.sku } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.price !== undefined ? { price: new Prisma.Decimal(input.price) } : {}),
        ...(input.cost !== undefined ? { cost: new Prisma.Decimal(input.cost) } : {}),
        ...(input.reorderAt !== undefined ? { reorderAt: input.reorderAt } : {}),
        ...(input.taxExempt !== undefined ? { taxExempt: input.taxExempt } : {}),
      },
    });
    return toProductView(product);
  } catch (error) {
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
 * Applies a manual stock adjustment to an absolute newStock value and writes an audit row.
 *
 * Why a reason is required and logged:
 * - POS sales already explain inventory going down (tied to a Sale/SaleItem).
 * - Manual changes (shrinkage, damage, cycle-count recounts, receiving corrections) are
 *   otherwise invisible — without a reason, co-op settlement and shrinkage reports cannot
 *   distinguish theft/spoilage from a data-entry fix.
 * - The StockAdjustment row freezes previousStock, newStock, delta, actor, and reason so
 *   historical audits remain accurate even if the product is later renamed or restocked.
 *
 * Stock is updated in the same transaction as the audit insert so a failed write never
 * leaves quantity changed without a logged reason (or vice versa).
 */
export async function adjustStock(
  productId: string,
  storeId: string,
  actor: AuthUser,
  input: AdjustStockInput,
): Promise<{ product: ProductWithLowStock; adjustment: { id: string; delta: number; reason: string } }> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(400, "A non-empty reason is required for manual stock adjustments");
  }

  if (!Number.isInteger(input.newStock) || input.newStock < 0) {
    throw new AppError(400, "newStock must be a non-negative integer");
  }

  const result = await prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, storeId },
    });

    if (!product) {
      throw new AppError(404, "Product not found for this store");
    }

    if (input.newStock < product.reserved) {
      throw new AppError(
        400,
        "newStock cannot be below reserved units held by PENDING sales",
        { reserved: product.reserved, newStock: input.newStock },
      );
    }

    const previousStock = product.stock;
    const newStock = input.newStock;
    const delta = newStock - previousStock;

    if (delta === 0) {
      throw new AppError(400, "newStock matches current stock; no adjustment needed");
    }

    const updated = await tx.product.update({
      where: { id: productId },
      data: { stock: newStock },
    });

    const adjustment = await tx.stockAdjustment.create({
      data: {
        productId,
        storeId,
        adjustedById: actor.id,
        previousStock,
        newStock,
        delta,
        reason,
      },
    });

    // Platform audit trail mirrors StockAdjustment (reason + before/after stock).
    await writeAuditLog(
      {
        userId: actor.id,
        storeId,
        action: AuditAction.STOCK_ADJUSTMENT,
        entityType: "Product",
        entityId: productId,
        before: { stock: previousStock },
        after: {
          stock: newStock,
          delta,
          reason,
          stockAdjustmentId: adjustment.id,
        },
        ipAddress: input.ipAddress ?? null,
      },
      { tx },
    );

    return { product: updated, adjustment };
  });

  return {
    product: toProductView(result.product),
    adjustment: {
      id: result.adjustment.id,
      delta: result.adjustment.delta,
      reason: result.adjustment.reason,
    },
  };
}

export type LotListItem = {
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
  unitCost: string;
  countryOfOrigin: string | null;
  supplier: { id: string; name: string } | null;
  daysUntilExpiry: number | null;
};

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
    product: { sku: string; name: string };
    supplier: { id: string; name: string } | null;
  },
  now = new Date(),
): LotListItem {
  const msPerDay = 24 * 60 * 60 * 1000;
  return {
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
    unitCost: lot.unitCost.toFixed(2),
    countryOfOrigin: lot.countryOfOrigin,
    supplier: lot.supplier,
    daysUntilExpiry: lot.expiryDate
      ? Math.ceil((lot.expiryDate.getTime() - now.getTime()) / msPerDay)
      : null,
  };
}

/**
 * Lots for one product (Inventory expand). Ordered FEFO.
 */
export async function listLotsForProduct(
  storeId: string,
  productId: string,
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
  return lots.map((l) => toLotListItem(l));
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
export async function listLots(filter: ListLotsFilter): Promise<LotListItem[]> {
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
  return lots.map((l) => toLotListItem(l));
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
    if (lot.quantityReserved > 0) {
      throw new AppError(
        409,
        "Cannot quarantine lot with open reservations — finalize or expire pending sales first",
        { quantityReserved: lot.quantityReserved },
      );
    }

    const writeOffQty = Math.max(0, lot.quantityRemaining);
    const next = await tx.lot.update({
      where: { id: lot.id },
      data: { status: LotStatus.QUARANTINED },
      include: {
        product: { select: { sku: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    if (writeOffQty > 0) {
      await tx.product.update({
        where: { id: lot.productId },
        data: { stock: { decrement: writeOffQty } },
      });
    }

    await writeAuditLog(
      {
        userId: actor.id,
        storeId,
        action: AuditAction.LOT_QUARANTINE,
        entityType: "Lot",
        entityId: lot.id,
        before: { status: LotStatus.ACTIVE, quantityRemaining: lot.quantityRemaining },
        after: { status: LotStatus.QUARANTINED, reason: trimmed },
        ipAddress: ipAddress ?? null,
      },
      { tx },
    );

    return next;
  });

  return toLotListItem(updated);
}

