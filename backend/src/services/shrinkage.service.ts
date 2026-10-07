/**
 * Shrinkage as a rate, not as isolated incidents.
 *
 * Shrinkage rate = value lost ÷ sales at cost × 100. Raw value rises with volume; the rate is the
 * number to trend and to compare across stores.
 *
 * ONE RECORD PER LOSS — existing signals are folded in, never duplicated:
 * - InventoryWriteOff is the ledger of stock leaving without a sale: expiry job (EXPIRED), recall
 *   activation (RECALL), refunds with restock=false (REFUND_NO_RESTOCK) and stock count shortfalls
 *   (STOCK_COUNT:<reason>). A count approval also writes a StockAdjustment for the same units, so
 *   those adjustments are NOT read as losses.
 * - Manual StockAdjustments (adjustStock: no lot, reason not RECEIPT / STOCK_COUNT) with a negative
 *   delta have no write-off row, so they are read here, valued at product cost.
 * - StockReconciliation rows (offline sales that drove stock negative) are a separate signal, not
 *   lost value: those goods were sold, and the books are corrected by a later count — which shows
 *   up here as a count adjustment if anything was really missing.
 *
 * Sales at cost = SaleItemLot units × unitCostSnapshot for sales paid in the window, minus the cost
 * of refunded units when the refund completed. Sale lines from before lot tracking fall back to
 * product cost.
 */
import { Prisma, Role, SaleRefundStatus, ShrinkageReason } from "@prisma/client";
import { AppError } from "../lib/errors.js";
import { moneyDec } from "../lib/money.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 366;
const TOP_LOSS_PRODUCTS = 10;
const STOCK_COUNT_PREFIX = "STOCK_COUNT:";
const COUNT_REASONS = new Set<string>(Object.values(ShrinkageReason));

export type ShrinkageSource =
  | "EXPIRY_JOB"
  | "RECALL"
  | "REFUND_NO_RESTOCK"
  | "STOCK_COUNT"
  | "MANUAL_ADJUSTMENT"
  | "OTHER_WRITE_OFF";

export type ShrinkageGranularity = "day" | "week" | "month";

type Totals = {
  value: string;
  units: number;
  events: number;
  salesAtCost: string;
  /** null when there were no sales at cost to divide by. */
  ratePercent: string | null;
};

export type ShrinkageReport = {
  storeId: string | null;
  storeName: string | null;
  from: string;
  to: string;
  granularity: ShrinkageGranularity;
  totals: Totals & {
    /** Units found over the system figure in approved counts — shown, never netted off losses. */
    countOverageValue: string;
    countOverageUnits: number;
  };
  byReason: Array<{ reason: string; value: string; units: number; events: number; sharePercent: string }>;
  bySource: Array<{ source: ShrinkageSource; value: string; units: number; events: number }>;
  byProduct: Array<Totals & { productId: string; sku: string; productName: string; category: string }>;
  byCategory: Array<Totals & { category: string }>;
  byLot: Array<{
    lotId: string;
    lotNumber: string;
    productId: string;
    sku: string;
    productName: string;
    supplierId: string | null;
    supplierName: string | null;
    value: string;
    units: number;
    events: number;
  }>;
  /** Supplier / FPO whose lot the loss came from. supplierId null = legacy or unattributed stock. */
  bySupplier: Array<Totals & { supplierId: string | null; supplierName: string }>;
  topLossProducts: Array<Totals & { productId: string; sku: string; productName: string; category: string }>;
  trend: Array<Totals & { bucketStart: string; networkRatePercent: string | null }>;
  comparison: {
    storeRatePercent: string | null;
    networkRatePercent: string | null;
    networkValue: string;
    networkSalesAtCost: string;
    /** Every store's figures — COOP_ADMIN only; empty for a store admin. */
    stores: Array<Totals & { storeId: string; storeName: string }>;
  };
  offlineStockConflicts: {
    rows: number;
    open: number;
    unitsOversold: number;
    products: Array<{ productId: string; sku: string; productName: string; rows: number; open: number; unitsOversold: number }>;
  };
};

export type ShrinkageQuery = { storeId?: string; from?: string; to?: string };

type Place = { storeId: string; productId: string; lotId: string | null; supplierId: string | null; at: Date };
type LossEvent = Place & { units: number; value: Prisma.Decimal; reason: string; source: ShrinkageSource };
type CostEvent = Place & { cost: Prisma.Decimal };

type Acc = { value: Prisma.Decimal; units: number; events: number; salesAtCost: Prisma.Decimal };

const ZERO = new Prisma.Decimal(0);

function newAcc(): Acc {
  return { value: ZERO, units: 0, events: 0, salesAtCost: ZERO };
}

function bump<K>(map: Map<K, Acc>, key: K): Acc {
  let acc = map.get(key);
  if (!acc) {
    acc = newAcc();
    map.set(key, acc);
  }
  return acc;
}

function addLoss(acc: Acc, e: LossEvent): void {
  acc.value = acc.value.add(e.value);
  acc.units += e.units;
  acc.events += 1;
}

function addCost(acc: Acc, e: CostEvent): void {
  acc.salesAtCost = acc.salesAtCost.add(e.cost);
}

function ratePercent(value: Prisma.Decimal, salesAtCost: Prisma.Decimal): string | null {
  if (salesAtCost.lte(0)) return null;
  return value.div(salesAtCost).mul(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}

function totals(acc: Acc): Totals {
  return {
    value: moneyDec(acc.value).toFixed(2),
    units: acc.units,
    events: acc.events,
    salesAtCost: moneyDec(acc.salesAtCost).toFixed(2),
    ratePercent: ratePercent(acc.value, acc.salesAtCost),
  };
}

function byValueDesc<T extends { value: string }>(a: T, b: T): number {
  return Number(b.value) - Number(a.value);
}

function classifyWriteOff(reason: string): { source: ShrinkageSource; reason: string } {
  if (reason === "EXPIRED") return { source: "EXPIRY_JOB", reason: ShrinkageReason.EXPIRY };
  if (reason === "RECALL") return { source: "RECALL", reason: "RECALL" };
  if (reason === "REFUND_NO_RESTOCK") {
    return { source: "REFUND_NO_RESTOCK", reason: "RETURNED_NOT_RESTOCKED" };
  }
  if (reason.startsWith(STOCK_COUNT_PREFIX)) {
    const code = reason.slice(STOCK_COUNT_PREFIX.length);
    return { source: "STOCK_COUNT", reason: COUNT_REASONS.has(code) ? code : ShrinkageReason.UNKNOWN };
  }
  return { source: "OTHER_WRITE_OFF", reason: "OTHER" };
}

function parseDay(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError(400, `${field} must be YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new AppError(400, `Invalid ${field}`);
  return d;
}

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function granularityFor(days: number): ShrinkageGranularity {
  if (days <= 31) return "day";
  if (days <= 184) return "week";
  return "month";
}

/** UTC start of the bucket containing `d`; weeks start on Monday. */
function bucketStart(d: Date, granularity: ShrinkageGranularity): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (granularity === "day") return dayString(day);
  if (granularity === "month") return dayString(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return dayString(new Date(day.getTime() - sinceMonday * MS_PER_DAY));
}

function bucketsBetween(from: Date, to: Date, granularity: ShrinkageGranularity): string[] {
  const keys: string[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += MS_PER_DAY) {
    const key = bucketStart(new Date(t), granularity);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

function resolveScope(actor: AuthUser, requested?: string): string | null {
  if (actor.role === Role.COOP_ADMIN) return requested ?? null;
  if (actor.role === Role.STORE_ADMIN) {
    if (!actor.storeId) throw new AppError(403, "User is not assigned to a store");
    if (requested && requested !== actor.storeId) {
      throw new AppError(403, "Cannot view another store's shrinkage");
    }
    return actor.storeId;
  }
  throw new AppError(403, "Insufficient role for shrinkage reporting");
}

type Allocation = {
  lotId: string;
  quantity: number;
  unitCostSnapshot: Prisma.Decimal;
  lot: { supplierId: string | null };
};

/** The allocation that supplied most units — where a lot-less refund write-off is attributed. */
function dominant(allocs: Allocation[]): Allocation | null {
  return allocs.reduce<Allocation | null>((best, a) => (!best || a.quantity > best.quantity ? a : best), null);
}

async function loadLosses(from: Date, to: Date): Promise<{ losses: LossEvent[]; overages: LossEvent[] }> {
  const window = { gte: from, lte: to };
  const [writeOffs, adjustments] = await Promise.all([
    prisma.inventoryWriteOff.findMany({
      where: { createdAt: window },
      select: {
        storeId: true,
        productId: true,
        lotId: true,
        saleItemId: true,
        quantity: true,
        reason: true,
        value: true,
        createdAt: true,
        lot: { select: { unitCost: true, supplierId: true } },
      },
    }),
    prisma.stockAdjustment.findMany({
      where: {
        createdAt: window,
        OR: [
          {
            delta: { lt: 0 },
            lotId: null,
            NOT: [{ reason: "RECEIPT" }, { reason: { startsWith: STOCK_COUNT_PREFIX } }],
          },
          { delta: { gt: 0 }, reason: { startsWith: STOCK_COUNT_PREFIX } },
        ],
      },
      select: {
        storeId: true,
        productId: true,
        lotId: true,
        delta: true,
        reason: true,
        createdAt: true,
        lot: { select: { unitCost: true, supplierId: true } },
      },
    }),
  ]);

  const saleItemIds = [
    ...new Set(writeOffs.filter((w) => !w.lot && w.saleItemId).map((w) => w.saleItemId!)),
  ];
  const productIds = [
    ...new Set([...writeOffs.map((w) => w.productId), ...adjustments.map((a) => a.productId)]),
  ];
  const [allocations, products] = await Promise.all([
    saleItemIds.length
      ? prisma.saleItemLot.findMany({
          where: { saleItemId: { in: saleItemIds } },
          select: {
            saleItemId: true,
            lotId: true,
            quantity: true,
            unitCostSnapshot: true,
            lot: { select: { supplierId: true } },
          },
        })
      : [],
    prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, cost: true } }),
  ]);
  const allocsByItem = new Map<string, Allocation[]>();
  for (const a of allocations) {
    allocsByItem.set(a.saleItemId, [...(allocsByItem.get(a.saleItemId) ?? []), a]);
  }
  const costByProduct = new Map(products.map((p) => [p.id, p.cost]));

  const losses: LossEvent[] = [];
  for (const w of writeOffs) {
    const { source, reason } = classifyWriteOff(w.reason);
    let lotId = w.lotId;
    let supplierId = w.lot?.supplierId ?? null;
    let value = w.value;
    const allocs = w.saleItemId ? allocsByItem.get(w.saleItemId) ?? [] : [];
    if (!lotId && allocs.length > 0) {
      const top = dominant(allocs)!;
      lotId = top.lotId;
      supplierId = top.lot.supplierId;
    }
    if (!value) {
      if (w.lot) {
        value = w.lot.unitCost.mul(w.quantity);
      } else if (allocs.length > 0) {
        const qty = allocs.reduce((s, a) => s + a.quantity, 0);
        const cost = allocs.reduce((s, a) => s.add(a.unitCostSnapshot.mul(a.quantity)), ZERO);
        value = cost.div(qty).mul(w.quantity);
      } else {
        value = (costByProduct.get(w.productId) ?? ZERO).mul(w.quantity);
      }
    }
    losses.push({
      storeId: w.storeId,
      productId: w.productId,
      lotId,
      supplierId,
      at: w.createdAt,
      units: w.quantity,
      value: moneyDec(value),
      reason,
      source,
    });
  }

  const overages: LossEvent[] = [];
  for (const a of adjustments) {
    const units = Math.abs(a.delta);
    const place = {
      storeId: a.storeId,
      productId: a.productId,
      lotId: a.lotId,
      supplierId: a.lot?.supplierId ?? null,
      at: a.createdAt,
      units,
    };
    if (a.delta < 0) {
      losses.push({
        ...place,
        value: moneyDec((costByProduct.get(a.productId) ?? ZERO).mul(units)),
        reason: "MANUAL_ADJUSTMENT",
        source: "MANUAL_ADJUSTMENT",
      });
    } else {
      overages.push({
        ...place,
        value: moneyDec((a.lot?.unitCost ?? costByProduct.get(a.productId) ?? ZERO).mul(units)),
        reason: "COUNT_OVERAGE",
        source: "STOCK_COUNT",
      });
    }
  }

  return { losses, overages };
}

async function loadSalesAtCost(from: Date, to: Date): Promise<CostEvent[]> {
  const window = { gte: from, lte: to };
  const [allocations, legacyItems, refundLines] = await Promise.all([
    prisma.saleItemLot.findMany({
      where: { saleItem: { sale: { paidAt: window } } },
      select: {
        lotId: true,
        quantity: true,
        unitCostSnapshot: true,
        lot: { select: { supplierId: true } },
        saleItem: { select: { productId: true, sale: { select: { storeId: true, paidAt: true } } } },
      },
    }),
    prisma.saleItem.findMany({
      where: { sale: { paidAt: window }, lotAllocations: { none: {} } },
      select: {
        productId: true,
        quantity: true,
        product: { select: { cost: true } },
        sale: { select: { storeId: true, paidAt: true } },
      },
    }),
    prisma.saleRefundLine.findMany({
      where: { saleRefund: { status: SaleRefundStatus.SUCCEEDED, completedAt: window } },
      select: {
        quantity: true,
        saleRefund: { select: { completedAt: true } },
        saleItem: {
          select: {
            productId: true,
            quantity: true,
            product: { select: { cost: true } },
            sale: { select: { storeId: true, paidAt: true } },
            lotAllocations: {
              select: { lotId: true, quantity: true, unitCostSnapshot: true, lot: { select: { supplierId: true } } },
            },
          },
        },
      },
    }),
  ]);

  const events: CostEvent[] = [];
  for (const a of allocations) {
    events.push({
      storeId: a.saleItem.sale.storeId,
      productId: a.saleItem.productId,
      lotId: a.lotId,
      supplierId: a.lot.supplierId,
      at: a.saleItem.sale.paidAt!,
      cost: a.unitCostSnapshot.mul(a.quantity),
    });
  }
  for (const item of legacyItems) {
    events.push({
      storeId: item.sale.storeId,
      productId: item.productId,
      lotId: null,
      supplierId: null,
      at: item.sale.paidAt!,
      cost: item.product.cost.mul(item.quantity),
    });
  }
  for (const line of refundLines) {
    const item = line.saleItem;
    // A refund on a sale that was never paid moved no stock, so it reverses no cost.
    if (!item.sale.paidAt) continue;
    const at = line.saleRefund.completedAt!;
    if (item.lotAllocations.length === 0 || item.quantity <= 0) {
      events.push({
        storeId: item.sale.storeId,
        productId: item.productId,
        lotId: null,
        supplierId: null,
        at,
        cost: item.product.cost.mul(line.quantity).neg(),
      });
      continue;
    }
    for (const alloc of item.lotAllocations) {
      const units = new Prisma.Decimal(alloc.quantity).mul(line.quantity).div(item.quantity);
      events.push({
        storeId: item.sale.storeId,
        productId: item.productId,
        lotId: alloc.lotId,
        supplierId: alloc.lot.supplierId,
        at,
        cost: alloc.unitCostSnapshot.mul(units).neg(),
      });
    }
  }
  return events;
}

/**
 * Shrinkage report for one store (or the whole network for a COOP_ADMIN without storeId) over a
 * UTC date range, default the last 30 days. Read-only.
 */
export async function getShrinkageReport(
  actor: AuthUser,
  query: ShrinkageQuery,
): Promise<ShrinkageReport> {
  const storeId = resolveScope(actor, query.storeId);

  const toStr = query.to ?? dayString(new Date());
  const toStart = parseDay(toStr, "to");
  const from = query.from
    ? parseDay(query.from, "from")
    : new Date(toStart.getTime() - (DEFAULT_WINDOW_DAYS - 1) * MS_PER_DAY);
  if (from > toStart) throw new AppError(400, "from must be on or before to");
  const spanDays = Math.round((toStart.getTime() - from.getTime()) / MS_PER_DAY) + 1;
  if (spanDays > MAX_WINDOW_DAYS) {
    throw new AppError(400, `Date range cannot exceed ${MAX_WINDOW_DAYS} days`);
  }
  const to = new Date(toStart.getTime() + MS_PER_DAY - 1);
  const granularity = granularityFor(spanDays);

  const stores = await prisma.store.findMany({ select: { id: true, name: true } });
  const storeName = storeId ? stores.find((s) => s.id === storeId)?.name ?? null : null;
  if (storeId && storeName === null) throw new AppError(404, "Store not found");

  const [{ losses: allLosses, overages: allOverages }, allCosts, reconciliations] = await Promise.all([
    loadLosses(from, to),
    loadSalesAtCost(from, to),
    prisma.stockReconciliation.findMany({
      where: { createdAt: { gte: from, lte: to }, ...(storeId ? { storeId } : {}) },
      select: { productId: true, quantitySold: true, stockAfter: true, resolvedAt: true },
    }),
  ]);

  const inScope = <T extends { storeId: string }>(e: T) => !storeId || e.storeId === storeId;
  const losses = allLosses.filter(inScope);
  const costs = allCosts.filter(inScope);
  const overages = allOverages.filter(inScope);

  const productIds = [
    ...new Set([...losses.map((e) => e.productId), ...costs.map((e) => e.productId), ...reconciliations.map((r) => r.productId)]),
  ];
  const lotIds = [...new Set(losses.map((e) => e.lotId).filter((id): id is string => !!id))];
  const [products, lots] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true, name: true, category: true },
    }),
    prisma.lot.findMany({
      where: { id: { in: lotIds } },
      select: { id: true, lotNumber: true, productId: true, supplierId: true },
    }),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const supplierIds = [
    ...new Set(
      [...losses.map((e) => e.supplierId), ...costs.map((e) => e.supplierId)].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  const suppliers = await prisma.supplier.findMany({
    where: { id: { in: supplierIds } },
    select: { id: true, name: true },
  });
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const categoryOf = (productId: string) => productById.get(productId)?.category ?? "Uncategorised";

  const total = newAcc();
  const byReason = new Map<string, Acc>();
  const bySource = new Map<ShrinkageSource, Acc>();
  const byProduct = new Map<string, Acc>();
  const byCategory = new Map<string, Acc>();
  const byLot = new Map<string, Acc>();
  const bySupplier = new Map<string | null, Acc>();
  const trendStore = new Map<string, Acc>();
  const trendNetwork = new Map<string, Acc>();
  const network = newAcc();
  const byStore = new Map<string, Acc>();

  for (const e of losses) {
    addLoss(total, e);
    addLoss(bump(byReason, e.reason), e);
    addLoss(bump(bySource, e.source), e);
    addLoss(bump(byProduct, e.productId), e);
    addLoss(bump(byCategory, categoryOf(e.productId)), e);
    if (e.lotId) addLoss(bump(byLot, e.lotId), e);
    addLoss(bump(bySupplier, e.supplierId), e);
    addLoss(bump(trendStore, bucketStart(e.at, granularity)), e);
  }
  for (const c of costs) {
    addCost(total, c);
    // Denominators only where there is a loss row to divide; sales alone are not listed.
    for (const acc of [
      byProduct.get(c.productId),
      byCategory.get(categoryOf(c.productId)),
      bySupplier.get(c.supplierId),
    ]) {
      if (acc) addCost(acc, c);
    }
    addCost(bump(trendStore, bucketStart(c.at, granularity)), c);
  }
  for (const e of allLosses) {
    addLoss(network, e);
    addLoss(bump(byStore, e.storeId), e);
    addLoss(bump(trendNetwork, bucketStart(e.at, granularity)), e);
  }
  for (const c of allCosts) {
    addCost(network, c);
    addCost(bump(byStore, c.storeId), c);
    addCost(bump(trendNetwork, bucketStart(c.at, granularity)), c);
  }

  const overageValue = overages.reduce((s, e) => s.add(e.value), ZERO);
  const overageUnits = overages.reduce((s, e) => s + e.units, 0);

  const productRows = [...byProduct.entries()]
    .map(([productId, acc]) => {
      const p = productById.get(productId);
      return {
        productId,
        sku: p?.sku ?? "",
        productName: p?.name ?? "Unknown product",
        category: categoryOf(productId),
        ...totals(acc),
      };
    })
    .sort(byValueDesc);

  const conflictsByProduct = new Map<string, { rows: number; open: number; unitsOversold: number }>();
  let conflictOpen = 0;
  let conflictUnits = 0;
  for (const r of reconciliations) {
    const units = Math.max(0, Math.min(r.quantitySold, -r.stockAfter));
    const row = conflictsByProduct.get(r.productId) ?? { rows: 0, open: 0, unitsOversold: 0 };
    row.rows += 1;
    row.unitsOversold += units;
    if (!r.resolvedAt) {
      row.open += 1;
      conflictOpen += 1;
    }
    conflictUnits += units;
    conflictsByProduct.set(r.productId, row);
  }

  const totalValue = total.value;
  return {
    storeId,
    storeName,
    from: dayString(from),
    to: toStr,
    granularity,
    totals: {
      ...totals(total),
      countOverageValue: moneyDec(overageValue).toFixed(2),
      countOverageUnits: overageUnits,
    },
    byReason: [...byReason.entries()]
      .map(([reason, acc]) => ({
        reason,
        value: moneyDec(acc.value).toFixed(2),
        units: acc.units,
        events: acc.events,
        sharePercent: totalValue.gt(0)
          ? acc.value.div(totalValue).mul(100).toDecimalPlaces(1).toFixed(1)
          : "0.0",
      }))
      .sort(byValueDesc),
    bySource: [...bySource.entries()]
      .map(([source, acc]) => ({
        source,
        value: moneyDec(acc.value).toFixed(2),
        units: acc.units,
        events: acc.events,
      }))
      .sort(byValueDesc),
    byProduct: productRows,
    byCategory: [...byCategory.entries()]
      .map(([category, acc]) => ({ category, ...totals(acc) }))
      .sort(byValueDesc),
    byLot: [...byLot.entries()]
      .map(([lotId, acc]) => {
        const lot = lotById.get(lotId);
        const p = lot ? productById.get(lot.productId) : undefined;
        const sid = lot?.supplierId ?? null;
        return {
          lotId,
          lotNumber: lot?.lotNumber ?? "",
          productId: lot?.productId ?? "",
          sku: p?.sku ?? "",
          productName: p?.name ?? "Unknown product",
          supplierId: sid,
          supplierName: sid ? supplierName.get(sid) ?? null : null,
          value: moneyDec(acc.value).toFixed(2),
          units: acc.units,
          events: acc.events,
        };
      })
      .sort(byValueDesc),
    bySupplier: [...bySupplier.entries()]
      .map(([supplierId, acc]) => ({
        supplierId,
        supplierName: supplierId ? supplierName.get(supplierId) ?? "Unknown supplier" : "No supplier on record",
        ...totals(acc),
      }))
      .sort(byValueDesc),
    topLossProducts: productRows.slice(0, TOP_LOSS_PRODUCTS),
    trend: bucketsBetween(from, toStart, granularity).map((key) => {
      const acc = trendStore.get(key) ?? newAcc();
      const net = trendNetwork.get(key) ?? newAcc();
      return {
        bucketStart: key,
        ...totals(acc),
        networkRatePercent: ratePercent(net.value, net.salesAtCost),
      };
    }),
    comparison: {
      storeRatePercent: ratePercent(total.value, total.salesAtCost),
      networkRatePercent: ratePercent(network.value, network.salesAtCost),
      networkValue: moneyDec(network.value).toFixed(2),
      networkSalesAtCost: moneyDec(network.salesAtCost).toFixed(2),
      stores:
        actor.role === Role.COOP_ADMIN
          ? stores
              .map((s) => ({ storeId: s.id, storeName: s.name, ...totals(byStore.get(s.id) ?? newAcc()) }))
              .sort(
                (a, b) =>
                  Number(b.ratePercent ?? -1) - Number(a.ratePercent ?? -1) || byValueDesc(a, b),
              )
          : [],
    },
    offlineStockConflicts: {
      rows: reconciliations.length,
      open: conflictOpen,
      unitsOversold: conflictUnits,
      products: [...conflictsByProduct.entries()]
        .map(([productId, row]) => ({
          productId,
          sku: productById.get(productId)?.sku ?? "",
          productName: productById.get(productId)?.name ?? "Unknown product",
          ...row,
        }))
        .sort((a, b) => b.unitsOversold - a.unitsOversold || b.rows - a.rows),
    },
  };
}
