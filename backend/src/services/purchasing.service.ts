/**
 * Procurement / purchasing for Harvestlink — suppliers, POs, goods receiving.
 *
 * Receiving creates a Lot for accepted units AND increments Product.stock in the same
 * transaction as StockAdjustment (reason RECEIPT) and GoodsReceipt rows.
 * Product.stock remains a cached rollup of ACTIVE lots for POS speed — any code that
 * changes one MUST change the other in the same transaction.
 * Over/short receipts require explicit acknowledgement — never silently accept a qty
 * mismatch vs the PO.
 *
 * When unitCostActual differs from Product.cost, product cost is updated with a weighted
 * average so margin reporting (Phase 21) reflects true landed cost. Lot.unitCost stores
 * the actual invoiced cost for THIS receipt (never averaged away).
 */
import {
  FpoLegalForm,
  ImportShipmentStatus,
  OrganicStatus,
  Prisma,
  PurchaseOrderStatus,
  Role,
  SupplierType,
  type FpoProfile,
  type GoodsReceipt,
  type PurchaseOrder,
  type Supplier,
  type SupplierProduct,
} from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { lockImportShipment, lockProducts } from "../lib/locks.js";
import { moneyDec, unitCostDec } from "../lib/money.js";
import { claimLotBarcode } from "./barcode.service.js";
import { findReceiveComplianceGaps } from "./compliance.service.js";
import { allocateShipmentCosts } from "./landedCost.service.js";
import { addLot } from "./stockEngine.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

/** Totals stay 2 dp. Prefer moneyDec at call sites for clarity. */
const money = moneyDec;

function assertAdmin(actor: AuthUser): void {
  if (actor.role !== Role.STORE_ADMIN && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Cashiers cannot access purchasing");
  }
}

function assertCoopAdmin(actor: AuthUser): void {
  if (actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only COOP_ADMIN may manage FPO profiles");
  }
}

/** STORE_ADMIN is locked to their store; COOP_ADMIN may target any store or co-op-level (null). */
function assertPoStoreAccess(actor: AuthUser, storeId: string | null): void {
  assertAdmin(actor);
  if (actor.role === Role.COOP_ADMIN) return;
  if (storeId === null) {
    throw new AppError(403, "Only COOP_ADMIN can create co-op-level purchase orders");
  }
  if (actor.storeId !== storeId) {
    throw new AppError(403, "Cannot manage purchase orders for another store");
  }
}

async function nextPoNumber(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT nextval('purchase_order_number_seq') AS n
  `;
  const n = Number(rows[0]?.n ?? 0);
  return `PO-${String(n).padStart(6, "0")}`;
}

function recomputePoTotals(
  lines: Array<{ orderedQty: number; unitCost: Prisma.Decimal }>,
  tax: Prisma.Decimal,
  shipping: Prisma.Decimal,
): { subtotal: Prisma.Decimal; total: Prisma.Decimal } {
  // Multiply at full unit precision, then round the line-sum to 2 dp.
  const subtotal = money(
    lines.reduce(
      (sum, line) => sum.add(line.unitCost.mul(line.orderedQty)),
      new Prisma.Decimal(0),
    ),
  );
  return { subtotal, total: money(subtotal.add(tax).add(shipping)) };
}

function lineIsComplete(line: {
  orderedQty: number;
  receivedQty: number;
  shortClosed: boolean;
}): boolean {
  return line.shortClosed || line.receivedQty >= line.orderedQty;
}

function derivePoStatus(
  lines: Array<{ orderedQty: number; receivedQty: number; shortClosed: boolean }>,
  current: PurchaseOrderStatus,
): PurchaseOrderStatus {
  if (
    current === PurchaseOrderStatus.CANCELLED ||
    current === PurchaseOrderStatus.DRAFT
  ) {
    return current;
  }
  if (!lines.length) return PurchaseOrderStatus.SUBMITTED;
  const anyReceived = lines.some((l) => l.receivedQty > 0 || l.shortClosed);
  const allComplete = lines.every(lineIsComplete);
  if (allComplete) return PurchaseOrderStatus.RECEIVED;
  if (anyReceived) return PurchaseOrderStatus.PARTIALLY_RECEIVED;
  return PurchaseOrderStatus.SUBMITTED;
}

// ─── Suppliers ───────────────────────────────────────────────────────────────

export type SupplierInput = {
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  paymentTerms?: string;
  leadTimeDays?: number;
  isActive?: boolean;
  notes?: string;
  supplierType?: SupplierType;
  country?: string;
};

export async function listSuppliers(activeOnly = false): Promise<Supplier[]> {
  return prisma.supplier.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    orderBy: { name: "asc" },
  });
}

export async function getSupplier(id: string): Promise<
  Supplier & { products: Array<SupplierProduct & { product: { id: string; sku: string; name: string; storeId: string } }> }
> {
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    include: {
      products: {
        include: {
          product: { select: { id: true, sku: true, name: true, storeId: true } },
        },
        orderBy: { updatedAt: "desc" },
      },
    },
  });
  if (!supplier) throw new AppError(404, "Supplier not found");
  return supplier;
}

export async function createSupplier(actor: AuthUser, input: SupplierInput): Promise<Supplier> {
  assertAdmin(actor);
  if (actor.role === Role.STORE_ADMIN) {
    // Store admins may create vendors they buy from; co-op still owns the network catalog.
  }
  const name = input.name.trim();
  if (!name) throw new AppError(400, "Supplier name is required");

  return prisma.supplier.create({
    data: {
      name,
      contactName: input.contactName?.trim() ?? "",
      email: input.email?.trim() ?? "",
      phone: input.phone?.trim() ?? "",
      address: input.address?.trim() ?? "",
      paymentTerms: input.paymentTerms?.trim() || "NET30",
      leadTimeDays: input.leadTimeDays ?? 7,
      isActive: input.isActive ?? true,
      notes: input.notes?.trim() ?? "",
      supplierType: input.supplierType ?? SupplierType.DOMESTIC_VENDOR,
      country: (input.country?.trim() || "US").toUpperCase(),
    },
  });
}

export async function updateSupplier(
  actor: AuthUser,
  id: string,
  input: Partial<SupplierInput>,
): Promise<Supplier> {
  assertAdmin(actor);
  await getSupplier(id);
  return prisma.supplier.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.contactName !== undefined ? { contactName: input.contactName.trim() } : {}),
      ...(input.email !== undefined ? { email: input.email.trim() } : {}),
      ...(input.phone !== undefined ? { phone: input.phone.trim() } : {}),
      ...(input.address !== undefined ? { address: input.address.trim() } : {}),
      ...(input.paymentTerms !== undefined ? { paymentTerms: input.paymentTerms.trim() } : {}),
      ...(input.leadTimeDays !== undefined ? { leadTimeDays: input.leadTimeDays } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
      ...(input.supplierType !== undefined ? { supplierType: input.supplierType } : {}),
      ...(input.country !== undefined ? { country: input.country.trim().toUpperCase() || "US" } : {}),
    },
  });
}

// ─── FPO profiles (COOP_ADMIN) ───────────────────────────────────────────────

export type FpoProfileInput = {
  supplierId: string;
  legalForm?: FpoLegalForm;
  registrationNumber?: string;
  state?: string;
  district?: string;
  block?: string | null;
  memberFarmerCount: number;
  memberFarmerCountAsOf?: Date | string;
  womenFarmerCount?: number | null;
  primaryCrops?: string[];
  exportsViaSupplierId?: string | null;
  notes?: string;
  onboardedAt?: Date | string;
};

export async function upsertFpoProfile(
  actor: AuthUser,
  input: FpoProfileInput,
): Promise<FpoProfile> {
  assertCoopAdmin(actor);
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw new AppError(404, "Supplier not found");
  if (supplier.supplierType !== SupplierType.FPO) {
    throw new AppError(400, "FpoProfile requires a supplier with supplierType FPO", {
      supplierId: supplier.id,
      supplierType: supplier.supplierType,
    });
  }
  if (!Number.isInteger(input.memberFarmerCount) || input.memberFarmerCount < 0) {
    throw new AppError(400, "memberFarmerCount must be a non-negative integer");
  }
  if (input.exportsViaSupplierId) {
    const exporter = await prisma.supplier.findUnique({
      where: { id: input.exportsViaSupplierId },
    });
    if (!exporter) throw new AppError(404, "exportsViaSupplierId not found");
  }

  const asOf = input.memberFarmerCountAsOf
    ? new Date(input.memberFarmerCountAsOf)
    : new Date();
  if (Number.isNaN(asOf.getTime())) {
    throw new AppError(400, "memberFarmerCountAsOf is not a valid date");
  }
  const onboardedAt = input.onboardedAt ? new Date(input.onboardedAt) : new Date();

  return prisma.fpoProfile.upsert({
    where: { supplierId: input.supplierId },
    create: {
      supplierId: input.supplierId,
      legalForm: input.legalForm ?? FpoLegalForm.OTHER,
      registrationNumber: input.registrationNumber?.trim() ?? "",
      state: input.state?.trim() ?? "",
      district: input.district?.trim() ?? "",
      block: input.block?.trim() || null,
      memberFarmerCount: input.memberFarmerCount,
      memberFarmerCountAsOf: asOf,
      womenFarmerCount: input.womenFarmerCount ?? null,
      primaryCrops: input.primaryCrops?.map((c) => c.trim()).filter(Boolean) ?? [],
      exportsViaSupplierId: input.exportsViaSupplierId ?? null,
      notes: input.notes?.trim() ?? "",
      onboardedAt,
    },
    update: {
      ...(input.legalForm !== undefined ? { legalForm: input.legalForm } : {}),
      ...(input.registrationNumber !== undefined
        ? { registrationNumber: input.registrationNumber.trim() }
        : {}),
      ...(input.state !== undefined ? { state: input.state.trim() } : {}),
      ...(input.district !== undefined ? { district: input.district.trim() } : {}),
      ...(input.block !== undefined ? { block: input.block?.trim() || null } : {}),
      memberFarmerCount: input.memberFarmerCount,
      memberFarmerCountAsOf: asOf,
      ...(input.womenFarmerCount !== undefined
        ? { womenFarmerCount: input.womenFarmerCount }
        : {}),
      ...(input.primaryCrops !== undefined
        ? { primaryCrops: input.primaryCrops.map((c) => c.trim()).filter(Boolean) }
        : {}),
      ...(input.exportsViaSupplierId !== undefined
        ? { exportsViaSupplierId: input.exportsViaSupplierId }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
      ...(input.onboardedAt !== undefined ? { onboardedAt } : {}),
    },
  });
}

export async function getFpoProfile(actor: AuthUser, supplierId: string): Promise<FpoProfile> {
  assertCoopAdmin(actor);
  const profile = await prisma.fpoProfile.findUnique({ where: { supplierId } });
  if (!profile) throw new AppError(404, "FPO profile not found");
  return profile;
}

/**
 * FPOs the co-op has actually RECEIVED goods from in the last 12 months —
 * the number for the website / flyer. Onboarded-but-never-supplied FPOs don't count.
 */
export async function getSourcingSummary(actor: AuthUser): Promise<{
  activeFpoCount: number;
  totalMemberFarmers: number;
  states: string[];
  asOfDates: string[];
}> {
  assertCoopAdmin(actor);
  const since = new Date();
  since.setUTCFullYear(since.getUTCFullYear() - 1);

  const origins = await prisma.sourcingOrigin.findMany({
    where: { goodsReceiptLine: { receipt: { receivedAt: { gte: since } } } },
    select: {
      fpoSupplierId: true,
      state: true,
      fpoSupplier: {
        select: {
          fpoProfile: {
            select: { memberFarmerCount: true, memberFarmerCountAsOf: true },
          },
        },
      },
    },
  });

  const fpoIds = new Set<string>();
  const states = new Set<string>();
  let totalMemberFarmers = 0;
  const asOfDates = new Set<string>();
  const countedFarmers = new Set<string>();

  for (const row of origins) {
    fpoIds.add(row.fpoSupplierId);
    if (row.state.trim()) states.add(row.state.trim());
    const profile = row.fpoSupplier.fpoProfile;
    if (profile && !countedFarmers.has(row.fpoSupplierId)) {
      countedFarmers.add(row.fpoSupplierId);
      totalMemberFarmers += profile.memberFarmerCount;
      asOfDates.add(profile.memberFarmerCountAsOf.toISOString());
    }
  }

  return {
    activeFpoCount: fpoIds.size,
    totalMemberFarmers,
    states: [...states].sort(),
    asOfDates: [...asOfDates].sort(),
  };
}

export type SupplierProductInput = {
  supplierId: string;
  productId: string;
  supplierSku?: string;
  caseSize?: number;
  caseCost: number;
  unitCost: number;
  minOrderQty?: number;
  isPreferred?: boolean;
};

export async function upsertSupplierProduct(
  actor: AuthUser,
  input: SupplierProductInput,
): Promise<SupplierProduct> {
  assertAdmin(actor);
  const product = await prisma.product.findUnique({ where: { id: input.productId } });
  if (!product) throw new AppError(404, "Product not found");
  if (actor.role === Role.STORE_ADMIN && actor.storeId !== product.storeId) {
    throw new AppError(403, "Cannot link suppliers to another store's products");
  }
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw new AppError(404, "Supplier not found");

  const caseSize = input.caseSize ?? 1;
  const minOrderQty = input.minOrderQty ?? 1;
  if (!Number.isInteger(caseSize) || caseSize < 1) {
    throw new AppError(400, "caseSize must be a positive integer");
  }
  if (!Number.isInteger(minOrderQty) || minOrderQty < 1) {
    throw new AppError(400, "minOrderQty must be a positive integer");
  }

  return prisma.$transaction(async (tx) => {
    if (input.isPreferred) {
      await tx.supplierProduct.updateMany({
        where: { productId: input.productId, isPreferred: true },
        data: { isPreferred: false },
      });
    }
    return tx.supplierProduct.upsert({
      where: {
        supplierId_productId: {
          supplierId: input.supplierId,
          productId: input.productId,
        },
      },
      create: {
        supplierId: input.supplierId,
        productId: input.productId,
        supplierSku: input.supplierSku?.trim() ?? "",
        caseSize,
        caseCost: money(input.caseCost),
        unitCost: unitCostDec(input.unitCost),
        minOrderQty,
        isPreferred: input.isPreferred ?? false,
      },
      update: {
        supplierSku: input.supplierSku?.trim() ?? "",
        caseSize,
        caseCost: money(input.caseCost),
        unitCost: unitCostDec(input.unitCost),
        minOrderQty,
        ...(input.isPreferred !== undefined ? { isPreferred: input.isPreferred } : {}),
      },
    });
  });
}

// ─── Purchase orders ─────────────────────────────────────────────────────────

export type PoLineInput = {
  productId: string;
  orderedQty: number;
  /** USD unit cost. Required when currency is USD; otherwise derived from unitCostForeign × rate. */
  unitCost?: number;
  /** Foreign-currency unit cost when PO currency ≠ USD. */
  unitCostForeign?: number | null;
};

export type CreatePoInput = {
  supplierId: string;
  /** null = co-op-level PO (COOP_ADMIN only). */
  storeId?: string | null;
  expectedDate?: string | null;
  tax?: number;
  shipping?: number;
  /** ISO 4217; default USD. */
  currency?: string;
  /** FX rate to USD; must be 1 when currency is USD. */
  fxRateToUsd?: number;
  lines: PoLineInput[];
  ipAddress?: string | null;
};

export type UpdatePoInput = {
  expectedDate?: string | null;
  tax?: number;
  shipping?: number;
  currency?: string;
  fxRateToUsd?: number;
  lines?: PoLineInput[];
  ipAddress?: string | null;
};

function normalizeCurrency(raw: string | undefined): string {
  const currency = (raw ?? "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AppError(400, "currency must be a 3-letter ISO 4217 code");
  }
  return currency;
}

function resolvePoLineCosts(
  line: PoLineInput,
  currency: string,
  fxRateToUsd: Prisma.Decimal,
): { unitCost: Prisma.Decimal; unitCostForeign: Prisma.Decimal | null } {
  if (currency === "USD") {
    if (line.unitCost === undefined || line.unitCost === null) {
      throw new AppError(400, "unitCost is required for USD purchase orders");
    }
    return { unitCost: unitCostDec(line.unitCost), unitCostForeign: null };
  }
  if (line.unitCostForeign === undefined || line.unitCostForeign === null) {
    throw new AppError(400, "unitCostForeign is required when currency is not USD");
  }
  const unitCostForeign = unitCostDec(line.unitCostForeign);
  return {
    unitCost: unitCostDec(unitCostForeign.mul(fxRateToUsd)),
    unitCostForeign,
  };
}

const poInclude = {
  supplier: true,
  store: true,
  lines: {
    include: {
      product: { select: { id: true, sku: true, name: true, storeId: true, stock: true } },
    },
  },
  receipts: {
    include: { lines: true },
    orderBy: { receivedAt: "desc" as const },
  },
};

async function loadPo(id: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: poInclude,
  });
  if (!po) throw new AppError(404, "Purchase order not found");
  return po;
}

function assertCanAccessPo(actor: AuthUser, po: { storeId: string | null }): void {
  assertPoStoreAccess(actor, po.storeId);
}

export async function listPurchaseOrders(
  actor: AuthUser,
  filter: { storeId?: string | null; status?: PurchaseOrderStatus; includeCoop?: boolean },
): Promise<PurchaseOrder[]> {
  assertAdmin(actor);
  const where: Prisma.PurchaseOrderWhereInput = {};

  if (actor.role === Role.STORE_ADMIN) {
    where.storeId = actor.storeId!;
  } else if (filter.storeId !== undefined) {
    where.storeId = filter.storeId;
  } else if (!filter.includeCoop) {
    // default: all POs for coop admin
  }

  if (filter.status) where.status = filter.status;

  return prisma.purchaseOrder.findMany({
    where,
    include: {
      supplier: { select: { id: true, name: true } },
      store: { select: { id: true, name: true } },
      lines: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getPurchaseOrder(actor: AuthUser, id: string) {
  const po = await loadPo(id);
  assertCanAccessPo(actor, po);

  const link = await prisma.importShipmentPurchaseOrder.findFirst({
    where: {
      poId: id,
      shipment: { status: { not: ImportShipmentStatus.CANCELLED } },
    },
    include: {
      shipment: {
        select: {
          id: true,
          shipmentNumber: true,
          status: true,
          containerNumber: true,
          eta: true,
          lines: true,
          costs: true,
        },
      },
    },
  });

  let importShipment: {
    id: string;
    shipmentNumber: string;
    status: ImportShipmentStatus;
    containerNumber: string | null;
    eta: Date | null;
    costCount: number;
  } | null = null;
  const landedPreviewByPoLineId: Record<
    string,
    { landedAddOnPerUnit: string; quantity: number }
  > = {};
  let complianceGaps: Array<{ code: string; message: string }> = [];
  let requiresLandedCostAck = false;

  if (link) {
    const ship = link.shipment;
    const activeCosts = ship.costs.filter((c) => {
      const superseded = new Set(
        ship.costs.filter((x) => x.supersedesCostId).map((x) => x.supersedesCostId!),
      );
      return !superseded.has(c.id);
    });
    importShipment = {
      id: ship.id,
      shipmentNumber: ship.shipmentNumber,
      status: ship.status,
      containerNumber: ship.containerNumber,
      eta: ship.eta,
      costCount: activeCosts.length,
    };
    requiresLandedCostAck = activeCosts.length === 0;

    if (ship.lines.length > 0 && activeCosts.length > 0) {
      const allocations = allocateShipmentCosts(
        ship.lines.map((l) => ({
          id: l.id,
          customsValueUsd: l.customsValueUsd,
          grossWeightKg: l.grossWeightKg,
          volumeCbm: l.volumeCbm,
          quantity: l.quantity,
          dutyAmountUsd: l.dutyAmountUsd,
        })),
        ship.costs,
      );
      const byShipLine = new Map(allocations.map((a) => [a.lineId, a]));
      for (const sl of ship.lines) {
        const alloc = byShipLine.get(sl.id);
        if (!alloc) continue;
        landedPreviewByPoLineId[sl.poLineId] = {
          landedAddOnPerUnit: alloc.landedAddOnPerUnit.toFixed(4),
          quantity: sl.quantity,
        };
      }
    }

    complianceGaps = (
      await findReceiveComplianceGaps({
        supplierId: po.supplierId,
        supplierType: po.supplier.supplierType,
        shipmentId: ship.id,
      })
    ).map((g) => ({ code: g.code, message: g.message }));
  }

  return {
    ...po,
    importShipment,
    landedPreviewByPoLineId,
    complianceGaps,
    requiresLandedCostAck,
  };
}

export async function createPurchaseOrder(actor: AuthUser, input: CreatePoInput) {
  const storeId = input.storeId === undefined ? actor.storeId : input.storeId;
  assertPoStoreAccess(actor, storeId ?? null);

  if (!input.lines?.length) throw new AppError(400, "PO must include at least one line");
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier || !supplier.isActive) {
    throw new AppError(400, "Supplier not found or inactive");
  }

  const currency = normalizeCurrency(input.currency);
  const fxRateToUsd =
    currency === "USD" ? new Prisma.Decimal(1) : new Prisma.Decimal(input.fxRateToUsd ?? NaN);
  if (currency === "USD" && input.fxRateToUsd !== undefined && Number(input.fxRateToUsd) !== 1) {
    throw new AppError(400, "USD purchase orders must use fxRateToUsd = 1");
  }
  if (!fxRateToUsd.isFinite() || fxRateToUsd.lte(0)) {
    throw new AppError(400, "fxRateToUsd must be a positive number");
  }

  const tax = money(input.tax ?? 0);
  const shipping = money(input.shipping ?? 0);
  const lineDrafts = input.lines.map((line) => {
    if (!Number.isInteger(line.orderedQty) || line.orderedQty <= 0) {
      throw new AppError(400, "orderedQty must be a positive integer");
    }
    const { unitCost, unitCostForeign } = resolvePoLineCosts(line, currency, fxRateToUsd);
    return {
      productId: line.productId,
      orderedQty: line.orderedQty,
      unitCost,
      unitCostForeign,
      lineTotal: money(unitCost.mul(line.orderedQty)),
    };
  });

  // Validate products belong to the PO store (when store-scoped).
  const products = await prisma.product.findMany({
    where: { id: { in: lineDrafts.map((l) => l.productId) } },
  });
  if (products.length !== lineDrafts.length) {
    throw new AppError(404, "One or more products were not found");
  }
  if (storeId) {
    for (const p of products) {
      if (p.storeId !== storeId) {
        throw new AppError(400, "All PO lines must be products of the destination store", {
          productId: p.id,
        });
      }
    }
  }

  const { subtotal, total } = recomputePoTotals(lineDrafts, tax, shipping);
  const expectedDate = input.expectedDate
    ? new Date(input.expectedDate)
    : new Date(Date.now() + supplier.leadTimeDays * 24 * 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    const poNumber = await nextPoNumber(tx);
    return tx.purchaseOrder.create({
      data: {
        poNumber,
        supplierId: input.supplierId,
        storeId,
        status: PurchaseOrderStatus.DRAFT,
        expectedDate,
        createdByUserId: actor.id,
        currency,
        fxRateToUsd,
        subtotal,
        tax,
        shipping,
        total,
        lines: { create: lineDrafts },
      },
      include: poInclude,
    });
  });
}

export async function updatePurchaseOrder(
  actor: AuthUser,
  id: string,
  input: UpdatePoInput,
) {
  const po = await loadPo(id);
  assertCanAccessPo(actor, po);
  if (po.status !== PurchaseOrderStatus.DRAFT) {
    throw new AppError(409, "Only DRAFT purchase orders can be edited");
  }

  const tax = input.tax !== undefined ? money(input.tax) : po.tax;
  const shipping = input.shipping !== undefined ? money(input.shipping) : po.shipping;
  const currency =
    input.currency !== undefined ? normalizeCurrency(input.currency) : po.currency;
  let fxRateToUsd = po.fxRateToUsd;
  if (currency === "USD") {
    fxRateToUsd = new Prisma.Decimal(1);
    if (input.fxRateToUsd !== undefined && Number(input.fxRateToUsd) !== 1) {
      throw new AppError(400, "USD purchase orders must use fxRateToUsd = 1");
    }
  } else if (input.fxRateToUsd !== undefined) {
    fxRateToUsd = new Prisma.Decimal(input.fxRateToUsd);
  }
  if (!fxRateToUsd.isFinite() || fxRateToUsd.lte(0)) {
    throw new AppError(400, "fxRateToUsd must be a positive number");
  }

  let lineDrafts = po.lines.map((l) => ({
    productId: l.productId,
    orderedQty: l.orderedQty,
    unitCost: l.unitCost,
    unitCostForeign: l.unitCostForeign,
    lineTotal: l.lineTotal,
  }));

  if (input.lines) {
    if (!input.lines.length) throw new AppError(400, "PO must include at least one line");
    lineDrafts = input.lines.map((line) => {
      if (!Number.isInteger(line.orderedQty) || line.orderedQty <= 0) {
        throw new AppError(400, "orderedQty must be a positive integer");
      }
      const { unitCost, unitCostForeign } = resolvePoLineCosts(line, currency, fxRateToUsd);
      return {
        productId: line.productId,
        orderedQty: line.orderedQty,
        unitCost,
        unitCostForeign,
        lineTotal: money(unitCost.mul(line.orderedQty)),
      };
    });
  } else if (input.currency !== undefined || input.fxRateToUsd !== undefined) {
    lineDrafts = po.lines.map((l) => {
      if (currency === "USD") {
        return {
          productId: l.productId,
          orderedQty: l.orderedQty,
          unitCost: l.unitCost,
          unitCostForeign: null,
          lineTotal: money(l.unitCost.mul(l.orderedQty)),
        };
      }
      if (l.unitCostForeign == null) {
        throw new AppError(400, "unitCostForeign is required when currency is not USD");
      }
      const unitCost = unitCostDec(l.unitCostForeign.mul(fxRateToUsd));
      return {
        productId: l.productId,
        orderedQty: l.orderedQty,
        unitCost,
        unitCostForeign: l.unitCostForeign,
        lineTotal: money(unitCost.mul(l.orderedQty)),
      };
    });
  }

  const { subtotal, total } = recomputePoTotals(lineDrafts, tax, shipping);

  return prisma.$transaction(async (tx) => {
    if (input.lines || input.currency !== undefined || input.fxRateToUsd !== undefined) {
      await tx.purchaseOrderLine.deleteMany({ where: { poId: id } });
      await tx.purchaseOrderLine.createMany({
        data: lineDrafts.map((l) => ({
          poId: id,
          productId: l.productId,
          orderedQty: l.orderedQty,
          unitCost: l.unitCost,
          unitCostForeign: l.unitCostForeign,
          lineTotal: l.lineTotal,
        })),
      });
    }
    return tx.purchaseOrder.update({
      where: { id },
      data: {
        tax,
        shipping,
        subtotal,
        total,
        currency,
        fxRateToUsd,
        ...(input.expectedDate !== undefined
          ? { expectedDate: input.expectedDate ? new Date(input.expectedDate) : null }
          : {}),
      },
      include: poInclude,
    });
  });
}

export async function submitPurchaseOrder(
  actor: AuthUser,
  id: string,
  ipAddress?: string | null,
) {
  const po = await loadPo(id);
  assertCanAccessPo(actor, po);
  if (po.status !== PurchaseOrderStatus.DRAFT) {
    throw new AppError(409, "Only DRAFT purchase orders can be submitted");
  }
  if (!po.lines.length) throw new AppError(400, "Cannot submit an empty PO");

  const updated = await prisma.purchaseOrder.update({
    where: { id },
    data: {
      status: PurchaseOrderStatus.SUBMITTED,
      submittedAt: new Date(),
    },
    include: poInclude,
  });

  await writeAuditLog({
    userId: actor.id,
    storeId: po.storeId,
    action: AuditAction.PO_SUBMIT,
    entityType: "PurchaseOrder",
    entityId: po.id,
    before: { status: po.status },
    after: { status: updated.status, poNumber: po.poNumber },
    ipAddress: ipAddress ?? null,
  });

  return updated;
}

export async function cancelPurchaseOrder(
  actor: AuthUser,
  id: string,
  ipAddress?: string | null,
) {
  const po = await loadPo(id);
  assertCanAccessPo(actor, po);
  if (
    po.status !== PurchaseOrderStatus.DRAFT &&
    po.status !== PurchaseOrderStatus.SUBMITTED
  ) {
    throw new AppError(409, "Only DRAFT or SUBMITTED POs can be cancelled");
  }
  if (po.lines.some((l) => l.receivedQty > 0)) {
    throw new AppError(409, "Cannot cancel a PO that already has receipts");
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id },
    data: { status: PurchaseOrderStatus.CANCELLED },
    include: poInclude,
  });

  await writeAuditLog({
    userId: actor.id,
    storeId: po.storeId,
    action: AuditAction.PO_CANCEL,
    entityType: "PurchaseOrder",
    entityId: po.id,
    before: { status: po.status },
    after: { status: updated.status },
    ipAddress: ipAddress ?? null,
  });

  return updated;
}

// ─── Receiving ───────────────────────────────────────────────────────────────

/** Cluster-level growing origin for one receipt line (never named farmers). */
export type SourcingOriginInput = {
  /** Growing FPO. Defaults to the PO supplier when that supplier is FPO. */
  fpoSupplierId?: string;
  state: string;
  district: string;
  village?: string | null;
  crop: string;
  variety?: string | null;
  harvestSeason?: string | null;
  harvestDate?: Date | string | null;
  contributingFarmerCount?: number | null;
  organicStatus?: OrganicStatus;
};

export type ReceiveLineInput = {
  poLineId: string;
  quantityReceived: number;
  quantityRejected?: number;
  rejectionReason?: string;
  unitCostActual: number;
  /** Dock / supplier lot number; when omitted, auto-generated as {SKU}-{YYYYMMDD}-{receiptId short}. */
  lotNumber?: string | null;
  /** Scannable label on the case (supplier GS1-128 or a store label) — lets counts scan the lot. */
  lotBarcode?: string | null;
  /** Sell-by / use-by for the received lot. */
  expiryDate?: Date | string | null;
  /** Harvest date for produce lots. */
  harvestDate?: Date | string | null;
  /** Country of origin (COOL). */
  countryOfOrigin?: string | null;
  /**
   * Required when the PO supplier is FPO or EXPORTER.
   * When an exporter invoices, Lot.supplierId stays the exporter; origin.fpoSupplierId is the FPO.
   */
  origin?: SourcingOriginInput | null;
  /**
   * Required when quantityReceived exceeds remaining ordered qty on the line.
   * Over-receipt is allowed only with this explicit flag — never silently.
   */
  acknowledgeOverReceipt?: boolean;
  /**
   * When true, closes the line even if receivedQty < orderedQty after this receipt.
   * Requires acknowledgeShortReceipt — short-receipt is never silent.
   */
  closeShort?: boolean;
  acknowledgeShortReceipt?: boolean;
};

export type ReceiveGoodsInput = {
  invoiceNumber?: string | null;
  notes?: string | null;
  lines: ReceiveLineInput[];
  ipAddress?: string | null;
  /**
   * COOP_ADMIN only. When the PO is on a shipment with zero cost rows, receive at invoice
   * cost (add-on 0). Audited — silently receiving an import at invoice cost is forbidden.
   */
  acknowledgeNoLandedCost?: boolean;
  /**
   * COOP_ADMIN only. Override FSVP / FDA prior-notice gaps on import receive.
   * Audited — a warning with a recorded override, not a silent skip.
   */
  acknowledgeComplianceGaps?: boolean;
};

/**
 * Records a goods receipt against a PO.
 *
 * Accepted units (qtyIn > 0), in the SAME transaction:
 *   1. Create GoodsReceiptLine (+ optional lot metadata)
 *   2. Create Lot (quantityRemaining = qtyIn, unitCost = unitCostActual + landedAddOnPerUnit)
 *   3. Increment Product.stock by qtyIn
 *      /// Product.stock remains a cached rollup of its ACTIVE lots, kept for POS speed. Lots are the
 *      /// source of truth. Any code that changes one MUST change the other in the same transaction.
 *   4. Write StockAdjustment (reason RECEIPT) with lotId
 *
 * When the PO is on an ImportShipment: claim the shipment (rule 0) before Product locks, then
 * allocate shipment costs inside the same transaction. Client landed values are ignored.
 * Domestic POs keep landedAddOnPerUnit = 0.
 *
 * Rejected units create no lot — they never entered sellable stock.
 *
 * Weighted-average Product.cost uses the landed unit cost (invoice + add-on).
 */
export async function receiveGoods(
  actor: AuthUser,
  poId: string,
  input: ReceiveGoodsInput,
) {
  assertAdmin(actor);
  if (!input.lines?.length) throw new AppError(400, "Receipt must include at least one line");

  const result = await prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: poId },
      include: { lines: true, supplier: true },
    });
    if (!po) throw new AppError(404, "Purchase order not found");
    assertCanAccessPo(actor, po);

    if (
      po.status !== PurchaseOrderStatus.SUBMITTED &&
      po.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw new AppError(409, "PO is not open for receiving", { status: po.status });
    }

    const originRequired =
      po.supplier.supplierType === SupplierType.FPO ||
      po.supplier.supplierType === SupplierType.EXPORTER;

    const lineById = new Map(po.lines.map((l) => [l.id, l]));
    const costChanges: Array<{
      productId: string;
      before: string;
      after: string;
      quantityReceived: number;
      unitCostActual: string;
      landedUnitCost: string;
    }> = [];

    // ── Import shipment: rule-0 document lock BEFORE Product locks ──
    let shipmentId: string | null = null;
    let shipmentNumber: string | null = null;
    let acknowledgedNoLandedCost = false;
    let complianceGapsAcknowledged: Array<{
      code: string;
      message: string;
    }> | null = null;
    /** poLineId → landedAddOnPerUnit from shipment allocation (ignore client). */
    const addOnByPoLineId = new Map<string, Prisma.Decimal>();

    const shipmentLink = await tx.importShipmentPurchaseOrder.findFirst({
      where: {
        poId,
        shipment: { status: { not: ImportShipmentStatus.CANCELLED } },
      },
      select: { shipmentId: true },
    });

    if (shipmentLink) {
      const lockedShipment = await lockImportShipment(tx, shipmentLink.shipmentId);
      if (!lockedShipment) throw new AppError(404, "Shipment not found");
      if (
        lockedShipment.status === ImportShipmentStatus.CLOSED ||
        lockedShipment.status === ImportShipmentStatus.CANCELLED
      ) {
        throw new AppError(409, "Cannot receive against a closed or cancelled shipment", {
          shipmentNumber: lockedShipment.shipmentNumber,
          status: lockedShipment.status,
        });
      }

      shipmentId = lockedShipment.id;
      shipmentNumber = lockedShipment.shipmentNumber;

      const gaps = await findReceiveComplianceGaps({
        supplierId: po.supplierId,
        supplierType: po.supplier.supplierType,
        shipmentId: lockedShipment.id,
      });
      if (gaps.length) {
        if (!input.acknowledgeComplianceGaps) {
          throw new AppError(
            409,
            "Compliance gaps on this shipment — attach missing paperwork or set acknowledgeComplianceGaps",
            {
              shipmentNumber: lockedShipment.shipmentNumber,
              gaps,
              requireAcknowledgeComplianceGaps: true,
            },
          );
        }
        if (actor.role !== Role.COOP_ADMIN) {
          throw new AppError(403, "acknowledgeComplianceGaps is COOP_ADMIN only");
        }
        complianceGapsAcknowledged = gaps.map((g) => ({
          code: g.code,
          message: g.message,
        }));
      }

      const [shipLines, shipCosts] = await Promise.all([
        tx.importShipmentLine.findMany({ where: { shipmentId } }),
        tx.shipmentCost.findMany({ where: { shipmentId } }),
      ]);

      if (shipCosts.length === 0) {
        if (!input.acknowledgeNoLandedCost) {
          throw new AppError(
            409,
            `${lockedShipment.shipmentNumber} has no landed costs. Enter estimates, or receive at invoice cost only with acknowledgeNoLandedCost.`,
            { shipmentId, shipmentNumber: lockedShipment.shipmentNumber },
          );
        }
        if (actor.role !== Role.COOP_ADMIN) {
          throw new AppError(
            403,
            "acknowledgeNoLandedCost is COOP_ADMIN only",
          );
        }
        acknowledgedNoLandedCost = true;
        for (const pl of po.lines) {
          addOnByPoLineId.set(pl.id, unitCostDec(0));
        }
      } else {
        if (!shipLines.length) {
          throw new AppError(
            409,
            `${lockedShipment.shipmentNumber} has costs but no shipment lines — upsert lines before receiving`,
            { shipmentId },
          );
        }
        const allocations = allocateShipmentCosts(
          shipLines.map((l) => ({
            id: l.id,
            customsValueUsd: l.customsValueUsd,
            grossWeightKg: l.grossWeightKg,
            volumeCbm: l.volumeCbm,
            quantity: l.quantity,
            dutyAmountUsd: l.dutyAmountUsd,
          })),
          shipCosts,
        );
        const allocByShipLine = new Map(allocations.map((a) => [a.lineId, a]));
        for (const sl of shipLines) {
          const alloc = allocByShipLine.get(sl.id)!;
          addOnByPoLineId.set(sl.poLineId, alloc.landedAddOnPerUnit);
        }
        for (const raw of input.lines) {
          if (raw.quantityReceived > 0 && !addOnByPoLineId.has(raw.poLineId)) {
            throw new AppError(
              409,
              "PO line is not on the shipment — upsert shipment lines before receiving",
              { poLineId: raw.poLineId, shipmentNumber: lockedShipment.shipmentNumber },
            );
          }
        }
      }
    }

    // Product before Lot create / Product.stock write (lib/locks.ts). New lots have no prior row.
    const lockedProducts = await lockProducts(
      tx,
      input.lines
        .map((raw) => lineById.get(raw.poLineId)?.productId)
        .filter((id): id is string => !!id),
    );
    const lockedProductById = new Map(lockedProducts.map((p) => [p.id, p]));

    const receipt = await tx.goodsReceipt.create({
      data: {
        poId,
        receivedByUserId: actor.id,
        invoiceNumber: input.invoiceNumber?.trim() || null,
        notes: input.notes?.trim() || null,
      },
    });

    const receivedAt = receipt.receivedAt;
    const yyyymmdd = receivedAt.toISOString().slice(0, 10).replace(/-/g, "");

    for (const raw of input.lines) {
      const poLine = lineById.get(raw.poLineId);
      if (!poLine) {
        throw new AppError(400, "poLineId is not on this purchase order", {
          poLineId: raw.poLineId,
        });
      }
      if (poLine.shortClosed) {
        throw new AppError(409, "PO line was already closed short", { poLineId: poLine.id });
      }

      const qtyIn = raw.quantityReceived;
      const qtyReject = raw.quantityRejected ?? 0;
      if (!Number.isInteger(qtyIn) || qtyIn < 0) {
        throw new AppError(400, "quantityReceived must be a non-negative integer");
      }
      if (!Number.isInteger(qtyReject) || qtyReject < 0) {
        throw new AppError(400, "quantityRejected must be a non-negative integer");
      }
      if (qtyIn === 0 && qtyReject === 0 && !raw.closeShort) {
        throw new AppError(400, "Receipt line must receive, reject, or close short");
      }
      if (qtyReject > 0 && !raw.rejectionReason?.trim()) {
        throw new AppError(400, "rejectionReason is required when rejecting units");
      }

      const remaining = Math.max(0, poLine.orderedQty - poLine.receivedQty);
      if (qtyIn > remaining) {
        if (!raw.acknowledgeOverReceipt) {
          throw new AppError(
            409,
            "Over-receipt: quantityReceived exceeds outstanding ordered qty — set acknowledgeOverReceipt to proceed",
            {
              poLineId: poLine.id,
              orderedQty: poLine.orderedQty,
              alreadyReceived: poLine.receivedQty,
              remaining,
              quantityReceived: qtyIn,
            },
          );
        }
      }

      const nextReceived = poLine.receivedQty + qtyIn;
      let shortClosed: boolean = poLine.shortClosed;
      if (raw.closeShort) {
        if (nextReceived >= poLine.orderedQty) {
          throw new AppError(400, "closeShort is only valid when the line remains short");
        }
        if (!raw.acknowledgeShortReceipt) {
          throw new AppError(
            409,
            "Short-receipt: closing a line below orderedQty requires acknowledgeShortReceipt",
            {
              poLineId: poLine.id,
              orderedQty: poLine.orderedQty,
              willHaveReceived: nextReceived,
            },
          );
        }
        shortClosed = true;
      }

      const unitCostActual = unitCostDec(raw.unitCostActual);
      const landedAddOnPerUnit =
        shipmentId != null
          ? (addOnByPoLineId.get(poLine.id) ?? unitCostDec(0))
          : unitCostDec(0);
      const landedUnitCost = unitCostDec(unitCostActual.add(landedAddOnPerUnit));
      const receivedValue = money(landedUnitCost.mul(qtyIn));
      const expiryDate = parseOptionalDate(raw.expiryDate);
      const harvestDate = parseOptionalDate(raw.harvestDate);
      const countryOfOrigin = raw.countryOfOrigin?.trim() || null;
      const suppliedLotNumber = raw.lotNumber?.trim() || null;

      if (originRequired && qtyIn > 0 && !raw.origin) {
        throw new AppError(
          400,
          "origin is required when receiving from an FPO or EXPORTER supplier",
          { poLineId: poLine.id, supplierType: po.supplier.supplierType },
        );
      }

      const receiptLine = await tx.goodsReceiptLine.create({
        data: {
          receiptId: receipt.id,
          poLineId: poLine.id,
          productId: poLine.productId,
          quantityReceived: qtyIn,
          quantityRejected: qtyReject,
          rejectionReason: qtyReject > 0 ? raw.rejectionReason!.trim() : null,
          unitCostActual,
          landedAddOnPerUnit,
          receivedValue,
          shipmentId,
          lotNumber: suppliedLotNumber,
          expiryDate,
          harvestDate,
          countryOfOrigin,
        },
      });

      if (raw.origin) {
        const origin = raw.origin;
        const fpoSupplierId =
          origin.fpoSupplierId?.trim() ||
          (po.supplier.supplierType === SupplierType.FPO ? po.supplierId : "");
        if (!fpoSupplierId) {
          throw new AppError(400, "origin.fpoSupplierId is required for exporter receipts", {
            poLineId: poLine.id,
          });
        }
        const state = origin.state.trim();
        const district = origin.district.trim();
        const crop = origin.crop.trim();
        if (!state || !district || !crop) {
          throw new AppError(400, "origin.state, origin.district and origin.crop are required");
        }
        if (
          origin.contributingFarmerCount != null &&
          (!Number.isInteger(origin.contributingFarmerCount) ||
            origin.contributingFarmerCount < 0)
        ) {
          throw new AppError(400, "origin.contributingFarmerCount must be a non-negative integer");
        }
        const fpo = await tx.supplier.findUnique({ where: { id: fpoSupplierId } });
        if (!fpo || fpo.supplierType !== SupplierType.FPO) {
          throw new AppError(400, "origin.fpoSupplierId must reference an FPO supplier", {
            fpoSupplierId,
          });
        }
        await tx.sourcingOrigin.create({
          data: {
            goodsReceiptLineId: receiptLine.id,
            fpoSupplierId,
            state,
            district,
            village: origin.village?.trim() || null,
            crop,
            variety: origin.variety?.trim() || null,
            harvestSeason: origin.harvestSeason?.trim() || null,
            harvestDate: parseOptionalDate(origin.harvestDate ?? null),
            contributingFarmerCount: origin.contributingFarmerCount ?? null,
            organicStatus: origin.organicStatus ?? OrganicStatus.CONVENTIONAL,
          },
        });
      }

      await tx.purchaseOrderLine.update({
        where: { id: poLine.id },
        data: { receivedQty: nextReceived, shortClosed },
      });

      // Accepted units only — rejected stay out of sellable stock (no Lot).
      if (qtyIn > 0) {
        const locked = lockedProductById.get(poLine.productId);
        if (!locked) throw new AppError(404, "Product not found", { productId: poLine.productId });
        // Cost / sku still need the full product row (locked product is a projection).
        const product = await tx.product.findUnique({ where: { id: poLine.productId } });
        if (!product) throw new AppError(404, "Product not found", { productId: poLine.productId });

        // Auto: {SKU}-{YYYYMMDD}-{receiptId short}; append line short on collision.
        let lotNumber =
          suppliedLotNumber ?? `${product.sku}-${yyyymmdd}-${receipt.id.slice(-8)}`;
        const collision = await tx.lot.findUnique({
          where: {
            productId_lotNumber_storeId: {
              productId: product.id,
              lotNumber,
              storeId: product.storeId,
            },
          },
          select: { id: true },
        });
        if (collision) {
          lotNumber = `${lotNumber}-${receiptLine.id.slice(-4)}`;
        }

        const lotBarcode = raw.lotBarcode?.trim()
          ? await claimLotBarcode(tx, product.storeId, raw.lotBarcode)
          : null;

        const previousStock = locked.stock;
        const lot = await addLot(tx, locked, {
          lotNumber,
          barcode: lotBarcode,
          storeId: product.storeId,
          supplierId: po.supplierId,
          goodsReceiptLineId: receiptLine.id,
          harvestDate,
          packDate: null,
          expiryDate,
          quantity: qtyIn,
          countryOfOrigin,
          receivedAt,
          unitCost: landedUnitCost,
          landedAddOnApplied: landedAddOnPerUnit,
        });
        locked.stock = previousStock + qtyIn;

        if (!suppliedLotNumber) {
          await tx.goodsReceiptLine.update({
            where: { id: receiptLine.id },
            data: { lotNumber },
          });
        }

        const newStock = previousStock + qtyIn;
        await tx.stockAdjustment.create({
          data: {
            productId: product.id,
            storeId: product.storeId,
            adjustedById: actor.id,
            previousStock,
            newStock,
            delta: qtyIn,
            reason: "RECEIPT",
            lotId: lot.id,
            lotPreviousQty: 0,
            lotNewQty: qtyIn,
          },
        });

        // Weighted-average cost uses landed unit cost (invoice + add-on).
        if (!landedUnitCost.eq(product.cost)) {
          let newCost: Prisma.Decimal;
          if (previousStock <= 0) {
            newCost = landedUnitCost;
          } else {
            const numerator = unitCostDec(product.cost)
              .mul(previousStock)
              .add(landedUnitCost.mul(qtyIn));
            const denominator = previousStock + qtyIn;
            newCost = unitCostDec(numerator.div(denominator));
          }
          await tx.product.update({
            where: { id: product.id },
            data: { cost: newCost },
          });
          costChanges.push({
            productId: product.id,
            before: unitCostDec(product.cost).toFixed(4),
            after: newCost.toFixed(4),
            quantityReceived: qtyIn,
            unitCostActual: unitCostActual.toFixed(4),
            landedUnitCost: landedUnitCost.toFixed(4),
          });
        }
      }

      poLine.receivedQty = nextReceived;
      poLine.shortClosed = shortClosed;
    }

    const refreshed = await tx.purchaseOrderLine.findMany({ where: { poId } });
    const nextStatus = derivePoStatus(refreshed, po.status);
    const updatedPo = await tx.purchaseOrder.update({
      where: { id: poId },
      data: { status: nextStatus },
      include: poInclude,
    });

    let shipmentMarkedReceived = false;
    if (shipmentId) {
      const links = await tx.importShipmentPurchaseOrder.findMany({
        where: { shipmentId },
        include: { po: { include: { lines: true } } },
      });
      const allPosDone = links.every((link) =>
        link.po.lines.every(
          (l) => l.shortClosed || l.receivedQty >= l.orderedQty,
        ),
      );
      if (allPosDone) {
        const current = await tx.importShipment.findUnique({ where: { id: shipmentId } });
        if (
          current &&
          current.status !== ImportShipmentStatus.RECEIVED &&
          current.status !== ImportShipmentStatus.COSTED &&
          current.status !== ImportShipmentStatus.CLOSED &&
          current.status !== ImportShipmentStatus.CANCELLED
        ) {
          await tx.importShipment.update({
            where: { id: shipmentId },
            data: { status: ImportShipmentStatus.RECEIVED },
          });
          await tx.shipmentEvent.create({
            data: {
              shipmentId,
              eventType: "STATUS_CHANGE",
              message: `${current.status} → RECEIVED (all attached POs received)`,
              payload: { from: current.status, to: ImportShipmentStatus.RECEIVED },
              createdByUserId: actor.id,
            },
          });
          shipmentMarkedReceived = true;
        }
      }
    }

    const fullReceipt = await tx.goodsReceipt.findUniqueOrThrow({
      where: { id: receipt.id },
      include: { lines: true },
    });

    return {
      receipt: fullReceipt,
      purchaseOrder: updatedPo,
      costChanges,
      shipmentId,
      shipmentNumber,
      acknowledgedNoLandedCost,
      complianceGapsAcknowledged,
      shipmentMarkedReceived,
    };
  });

  await writeAuditLog({
    userId: actor.id,
    storeId: result.purchaseOrder.storeId,
    action: AuditAction.PO_RECEIVE,
    entityType: "GoodsReceipt",
    entityId: result.receipt.id,
    after: {
      poId,
      poNumber: result.purchaseOrder.poNumber,
      status: result.purchaseOrder.status,
      invoiceNumber: result.receipt.invoiceNumber,
      lineCount: result.receipt.lines.length,
      shipmentId: result.shipmentId,
      shipmentNumber: result.shipmentNumber,
      shipmentMarkedReceived: result.shipmentMarkedReceived,
      complianceGapsAcknowledged: result.complianceGapsAcknowledged,
    },
    ipAddress: input.ipAddress ?? null,
  });

  if (result.complianceGapsAcknowledged?.length && result.shipmentId) {
    await writeAuditLog({
      userId: actor.id,
      storeId: result.purchaseOrder.storeId,
      action: AuditAction.COMPLIANCE_GAP_OVERRIDE,
      entityType: "ImportShipment",
      entityId: result.shipmentId,
      after: {
        shipmentNumber: result.shipmentNumber,
        poId,
        receiptId: result.receipt.id,
        gaps: result.complianceGapsAcknowledged,
      },
      ipAddress: input.ipAddress ?? null,
    });
  }

  if (result.acknowledgedNoLandedCost && result.shipmentId) {
    await writeAuditLog({
      userId: actor.id,
      storeId: result.purchaseOrder.storeId,
      action: AuditAction.RECEIVE_NO_LANDED_COST,
      entityType: "ImportShipment",
      entityId: result.shipmentId,
      after: {
        shipmentNumber: result.shipmentNumber,
        poId,
        receiptId: result.receipt.id,
        reason: "COOP_ADMIN acknowledged receive at invoice cost with no shipment costs",
      },
      ipAddress: input.ipAddress ?? null,
    });
  }

  for (const change of result.costChanges) {
    await writeAuditLog({
      userId: actor.id,
      storeId: result.purchaseOrder.storeId,
      action: AuditAction.PRODUCT_COST_CHANGE,
      entityType: "Product",
      entityId: change.productId,
      before: { cost: change.before },
      after: {
        cost: change.after,
        reason: "WEIGHTED_AVG_ON_RECEIPT",
        quantityReceived: change.quantityReceived,
        unitCostActual: change.unitCostActual,
        landedUnitCost: change.landedUnitCost,
        formula: "(oldStock*oldCost + qty*landedUnitCost)/(oldStock+qty)",
      },
      ipAddress: input.ipAddress ?? null,
    });
  }

  return result;
}

function parseOptionalDate(value: Date | string | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new AppError(400, "Invalid date value on receipt line");
  }
  return d;
}

// ─── Reorder suggestions ─────────────────────────────────────────────────────

export type ReorderSuggestion = {
  supplierId: string;
  supplierName: string;
  lines: Array<{
    productId: string;
    sku: string;
    name: string;
    storeId: string;
    /** On-hand sellable = stock − reserved. */
    available: number;
    /**
     * Outstanding units already committed on SUBMITTED / PARTIALLY_RECEIVED POs
     * (Σ orderedQty − receivedQty, excluding shortClosed lines).
     */
    onOrder: number;
    /** Open PO numbers that contribute to onOrder. */
    openPoNumbers: string[];
    /**
     * Units sitting on DRAFT POs for this SKU — not counted in position, but listed so
     * the buyer does not open a duplicate draft.
     */
    draftOnOrder: number;
    /** DRAFT PO numbers corresponding to draftOnOrder. */
    draftPoNumbers: string[];
    /** available + onOrder (DRAFT excluded). Suggest when ≤ reorderAt. */
    position: number;
    reorderAt: number;
    caseSize: number;
    minOrderQty: number;
    unitCost: string;
    suggestedQty: number;
    lineTotal: string;
  }>;
  suggestedSubtotal: string;
};

type PoPipelineAgg = {
  onOrder: number;
  openPoNumbers: string[];
  draftOnOrder: number;
  draftPoNumbers: string[];
};

/**
 * Pipeline qty already spoken for on open / draft POs for the given products.
 *
 * onOrder counts SUBMITTED + PARTIALLY_RECEIVED only (outstanding = ordered − received,
 * shortClosed lines ignored). DRAFT qty is returned separately as draftOnOrder.
 *
 * Phase 3 extends this for stores ordering from the warehouse.
 */
async function aggregateOpenPoPipeline(
  productIds: string[],
): Promise<Map<string, PoPipelineAgg>> {
  const byProduct = new Map<string, PoPipelineAgg>();
  for (const id of productIds) {
    byProduct.set(id, {
      onOrder: 0,
      openPoNumbers: [],
      draftOnOrder: 0,
      draftPoNumbers: [],
    });
  }
  if (productIds.length === 0) return byProduct;

  const lines = await prisma.purchaseOrderLine.findMany({
    where: {
      productId: { in: productIds },
      shortClosed: false,
      po: {
        status: {
          in: [
            PurchaseOrderStatus.DRAFT,
            PurchaseOrderStatus.SUBMITTED,
            PurchaseOrderStatus.PARTIALLY_RECEIVED,
          ],
        },
      },
    },
    select: {
      productId: true,
      orderedQty: true,
      receivedQty: true,
      po: { select: { poNumber: true, status: true } },
    },
  });

  for (const line of lines) {
    const agg = byProduct.get(line.productId);
    if (!agg) continue;
    const outstanding = Math.max(0, line.orderedQty - line.receivedQty);
    if (outstanding <= 0) continue;

    if (line.po.status === PurchaseOrderStatus.DRAFT) {
      agg.draftOnOrder += outstanding;
      if (!agg.draftPoNumbers.includes(line.po.poNumber)) {
        agg.draftPoNumbers.push(line.po.poNumber);
      }
    } else {
      // SUBMITTED or PARTIALLY_RECEIVED
      agg.onOrder += outstanding;
      if (!agg.openPoNumbers.includes(line.po.poNumber)) {
        agg.openPoNumbers.push(line.po.poNumber);
      }
    }
  }

  return byProduct;
}

/**
 * For products whose pipeline position (stock − reserved + onOrder) is at/below reorderAt,
 * propose draft PO lines grouped by preferred supplier, rounded up to caseSize and minOrderQty.
 *
 * DRAFT POs are excluded from onOrder/position but surfaced as draftOnOrder so buyers
 * see an existing draft before creating another.
 */
export async function suggestReorderDrafts(
  actor: AuthUser,
  storeId: string,
): Promise<ReorderSuggestion[]> {
  assertPoStoreAccess(actor, storeId);

  const products = await prisma.product.findMany({
    where: { storeId },
    include: {
      supplierProducts: {
        where: { isPreferred: true },
        include: { supplier: true },
      },
    },
  });

  const pipeline = await aggregateOpenPoPipeline(products.map((p) => p.id));
  const bySupplier = new Map<string, ReorderSuggestion>();

  for (const product of products) {
    const available = product.stock - product.reserved;
    const pipe = pipeline.get(product.id) ?? {
      onOrder: 0,
      openPoNumbers: [],
      draftOnOrder: 0,
      draftPoNumbers: [],
    };
    const position = available + pipe.onOrder;
    if (position > product.reorderAt) continue;

    const link = product.supplierProducts[0];
    if (!link || !link.supplier.isActive) continue;

    // Bring position back above reorderAt, then honor minOrderQty + case packs.
    const deficit = product.reorderAt - position + 1;
    let suggestedQty = Math.max(deficit, link.minOrderQty);
    if (link.caseSize > 1) {
      suggestedQty = Math.ceil(suggestedQty / link.caseSize) * link.caseSize;
    }

    const unitCost = unitCostDec(link.unitCost);
    const lineTotal = money(unitCost.mul(suggestedQty));

    let group = bySupplier.get(link.supplierId);
    if (!group) {
      group = {
        supplierId: link.supplierId,
        supplierName: link.supplier.name,
        lines: [],
        suggestedSubtotal: "0.00",
      };
      bySupplier.set(link.supplierId, group);
    }
    group.lines.push({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      storeId: product.storeId,
      available,
      onOrder: pipe.onOrder,
      openPoNumbers: pipe.openPoNumbers,
      draftOnOrder: pipe.draftOnOrder,
      draftPoNumbers: pipe.draftPoNumbers,
      position,
      reorderAt: product.reorderAt,
      caseSize: link.caseSize,
      minOrderQty: link.minOrderQty,
      unitCost: unitCost.toFixed(4),
      suggestedQty,
      lineTotal: lineTotal.toFixed(2),
    });
  }

  for (const group of bySupplier.values()) {
    const sub = group.lines.reduce(
      (sum, l) => sum.add(money(l.lineTotal)),
      new Prisma.Decimal(0),
    );
    group.suggestedSubtotal = money(sub).toFixed(2);
  }

  return [...bySupplier.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName));
}

export type { GoodsReceipt, PurchaseOrder, Supplier };
