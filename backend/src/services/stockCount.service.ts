/**
 * Physical stock counts, built on the lot model.
 *
 * Lifecycle: createCount (DRAFT) → startCount (IN_PROGRESS, expected quantities frozen) →
 * submitCountLine per lot → completeCount (COMPLETED) → approveCount (stock adjusted).
 * Counts are CANCELLED, never deleted.
 *
 * BLIND COUNTING
 * /// If a counter can see the system expects 40, they will find 40. Blind counting is the entire
 * /// point; showing the expected figure makes the exercise worthless while still costing the labour.
 * getCountForCounter and submitCountLine never return expectedQuantity, variance, movement, or
 * another person's counted figure. Expected quantities are only returned by getCountForReview,
 * to STORE_ADMIN / COOP_ADMIN, once the count is COMPLETED.
 *
 * Every line is lot-level: counting a product counts each of its lots, so approval can adjust the
 * exact lot a variance belongs to and Product.stock (the cached rollup of ACTIVE lots) stays true.
 */
import {
  LotStatus,
  Prisma,
  Role,
  ShrinkageReason,
  StockCountLineStatus,
  StockCountStatus,
  StockCountType,
  type StockCount,
} from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { moneyDec } from "../lib/money.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";
import { getCooperativeSettings } from "./membership.service.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

const BLOCKED_LOT_STATUSES: LotStatus[] = [LotStatus.QUARANTINED, LotStatus.RECALLED];

export type CreateCountOptions = {
  productIds?: string[];
  lotIds?: string[];
  scheduledFor?: Date | null;
  notes?: string | null;
  ipAddress?: string | null;
};

export type ApproveCountOptions = {
  /** Shrinkage reason per line id. Variance lines without one are recorded as UNKNOWN. */
  reasons?: Record<string, ShrinkageReason>;
  /** Required to adjust a QUARANTINED or RECALLED lot. */
  overrideBlockedLots?: boolean;
  overrideReason?: string | null;
  ipAddress?: string | null;
};

/** What the person counting may see. Deliberately has no expected, variance or prior count. */
export type CounterLineView = {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  lotId: string | null;
  lotNumber: string | null;
  expiryDate: Date | null;
  /** Normalized product codes, so a device can resolve scans against the count while offline. */
  productBarcodes: string[];
  lotBarcode: string | null;
  status: StockCountLineStatus;
  countedByYou: boolean;
  /** True when a different person should take this recount (the viewer did the first count). */
  recountByAnotherPerson: boolean;
};

export type CounterCountView = {
  id: string;
  storeId: string;
  type: StockCountType;
  status: StockCountStatus;
  scheduledFor: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  notes: string | null;
  lines: CounterLineView[];
};

export type ReviewLineView = {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  lotId: string | null;
  lotNumber: string | null;
  lotStatus: LotStatus | null;
  unitCost: string | null;
  status: StockCountLineStatus;
  /** Lot quantity frozen at startCount. */
  expectedQuantity: number;
  /** Units sold from this lot between startCount and when the line was (re)counted. */
  soldDuringCount: number;
  /** All net movement in that window: sales out, restocked refunds back in, disposals. */
  movementDuringCount: number | null;
  /** expectedQuantity − movementDuringCount: what should have been on the shelf when counted. */
  expectedAtCount: number | null;
  countedQuantity: number | null;
  countedByUserId: string | null;
  recountedQuantity: number | null;
  recountedByUserId: string | null;
  finalCountedQuantity: number | null;
  variance: number | null;
  varianceValue: string | null;
  reasonCode: ShrinkageReason | null;
};

export type ReviewCountView = {
  id: string;
  storeId: string;
  type: StockCountType;
  status: StockCountStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  lines: ReviewLineView[];
  totals: {
    lines: number;
    linesWithVariance: number;
    shrinkageValue: string;
    overageValue: string;
    netVarianceValue: string;
  };
};

function isStoreAdmin(actor: AuthUser): boolean {
  return actor.role === Role.STORE_ADMIN || actor.role === Role.COOP_ADMIN;
}

function assertStoreAdmin(actor: AuthUser, action: string): void {
  if (!isStoreAdmin(actor)) {
    throw new AppError(403, `Only STORE_ADMIN or COOP_ADMIN can ${action}`);
  }
}

function assertStoreAccess(actor: AuthUser, storeId: string): void {
  if (actor.role === Role.COOP_ADMIN) return;
  if (!actor.storeId || actor.storeId !== storeId) {
    throw new AppError(404, "Stock count not found");
  }
}

async function loadCount(db: DbClient, actor: AuthUser, countId: string): Promise<StockCount> {
  const count = await db.stockCount.findUnique({ where: { id: countId } });
  if (!count) throw new AppError(404, "Stock count not found");
  assertStoreAccess(actor, count.storeId);
  return count;
}

function uniq(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

/** Lots a product-level selection expands to: sellable lots plus blocked lots still holding units. */
function countableLotWhere(storeId: string, productIds?: string[]): Prisma.LotWhereInput {
  return {
    storeId,
    ...(productIds ? { productId: { in: productIds } } : {}),
    OR: [
      { status: LotStatus.ACTIVE },
      { status: { in: BLOCKED_LOT_STATUSES }, quantityRemaining: { gt: 0 } },
    ],
  };
}

/**
 * Counts whose lines have not been applied to stock yet. A product on one of these must not be put
 * on another count: if both were approved, one shortfall would be written off twice.
 */
export function openCountWhere(storeId: string): Prisma.StockCountWhereInput {
  return {
    storeId,
    OR: [
      { status: { in: [StockCountStatus.DRAFT, StockCountStatus.IN_PROGRESS] } },
      { status: StockCountStatus.COMPLETED, approvedAt: null },
    ],
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** An ACTIVE lot expiring within this many days pulls its product into the next cycle count. */
const NEAR_EXPIRY_DAYS = 7;
/** How many cycles apart each class is due: A every cycle, B every 2nd, C every 4th. */
const CLASS_INTERVAL_CYCLES = { A: 1, B: 2, C: 4 } as const;
/** Value on hand at or above this share of highValueThreshold is class B. */
const CLASS_B_VALUE_SHARE = 0.25;
/** Top 20% of sellers by units are class A on velocity; the next 30% are class B. */
const CLASS_A_VELOCITY_SHARE = 0.2;
const CLASS_B_VELOCITY_SHARE = 0.5;

export type AbcClass = keyof typeof CLASS_INTERVAL_CYCLES;

export type CycleCountReason =
  | "VARIANCE_LAST_COUNT"
  | "NEAR_EXPIRY"
  | "HIGH_VALUE"
  | "HIGH_VELOCITY"
  | "NEVER_COUNTED"
  | "DUE";

export type CycleCountCandidate = {
  productId: string;
  sku: string;
  productName: string;
  abcClass: AbcClass;
  reasons: CycleCountReason[];
  /** Units on hand × lot unit cost across countable lots. */
  valueOnHand: string;
  /** Units sold over the last cycleCountFrequencyDays. */
  unitsSold: number;
  /** startedAt of the last approved count that included this product. */
  lastCountedAt: Date | null;
  score: number;
};

export type CycleCountSchedule = {
  storeId: string;
  generatedAt: Date;
  frequencyDays: number;
  size: number;
  selected: CycleCountCandidate[];
  /** Due or flagged, but beyond cycleCountSize; they rank higher next cycle as they age. */
  dueButDeferred: number;
  /** Skipped because they are already on an open count. */
  alreadyOnOpenCount: number;
};

function betterClass(a: AbcClass, b: AbcClass): AbcClass {
  return a < b ? a : b;
}

/**
 * Picks the products for a store's next cycle count, by risk.
 *
 * /// ABC-style prioritisation: a few products hold most of the value and most of the risk. Count
 * /// those often and everything else occasionally, rather than everything rarely.
 *
 * Class comes from value on hand at lot cost (A ≥ highValueThreshold, B ≥ a quarter of it) and
 * from sales velocity over the last cycle (A = top fifth of sellers, B = top half); the better of
 * the two wins. A product is due when its class interval would lapse before the next cycle, so A
 * is counted every cycle, B every second and C every fourth. Never-counted products are due.
 *
 * Due or not, a product is always included when its last approved count found a variance, or when
 * an ACTIVE lot expires within NEAR_EXPIRY_DAYS (FEFO failures show up there first).
 *
 * Order: those two flags first, then by score = value share + velocity share + staleness, each
 * 0–1. Products already on an open count are skipped. At most cycleCountSize are selected.
 */
export async function generateCycleCountSchedule(
  storeId: string,
  now = new Date(),
): Promise<CycleCountSchedule> {
  const settings = await getCooperativeSettings();
  const frequencyDays = settings.cycleCountFrequencyDays;
  const size = settings.cycleCountSize;
  const empty: CycleCountSchedule = {
    storeId,
    generatedAt: now,
    frequencyDays,
    size,
    selected: [],
    dueButDeferred: 0,
    alreadyOnOpenCount: 0,
  };

  const nearExpiryBy = new Date(now.getTime() + NEAR_EXPIRY_DAYS * MS_PER_DAY);
  const lots = await prisma.lot.findMany({
    where: countableLotWhere(storeId),
    select: {
      productId: true,
      status: true,
      quantityRemaining: true,
      unitCost: true,
      expiryDate: true,
      product: { select: { sku: true, name: true } },
    },
  });
  type ProductRisk = { sku: string; name: string; value: Prisma.Decimal; nearExpiry: boolean };
  const byProduct = new Map<string, ProductRisk>();
  for (const lot of lots) {
    const entry = byProduct.get(lot.productId) ?? {
      sku: lot.product.sku,
      name: lot.product.name,
      value: new Prisma.Decimal(0),
      nearExpiry: false,
    };
    entry.value = entry.value.add(lot.unitCost.mul(Math.max(0, lot.quantityRemaining)));
    if (
      lot.status === LotStatus.ACTIVE &&
      lot.quantityRemaining > 0 &&
      lot.expiryDate &&
      lot.expiryDate <= nearExpiryBy
    ) {
      entry.nearExpiry = true;
    }
    byProduct.set(lot.productId, entry);
  }
  const productIds = [...byProduct.keys()];
  if (productIds.length === 0) return empty;

  const since = new Date(now.getTime() - frequencyDays * MS_PER_DAY);
  const [onOpenRows, soldRows, approvedLines] = await Promise.all([
    prisma.stockCountLine.findMany({
      where: { productId: { in: productIds }, count: openCountWhere(storeId) },
      select: { productId: true },
      distinct: ["productId"],
    }),
    prisma.saleItem.groupBy({
      by: ["productId"],
      where: { productId: { in: productIds }, sale: { storeId, paidAt: { gte: since, lte: now } } },
      _sum: { quantity: true },
    }),
    prisma.stockCountLine.findMany({
      where: { productId: { in: productIds }, count: { storeId, approvedAt: { not: null } } },
      select: {
        productId: true,
        variance: true,
        countId: true,
        count: { select: { startedAt: true, approvedAt: true } },
      },
    }),
  ]);
  const onOpen = new Set(onOpenRows.map((r) => r.productId));
  const sold = new Map(soldRows.map((r) => [r.productId, r._sum.quantity ?? 0]));

  const lastCount = new Map<string, { countId: string; at: Date; hadVariance: boolean }>();
  for (const line of approvedLines) {
    const at = line.count.startedAt ?? line.count.approvedAt!;
    const current = lastCount.get(line.productId);
    if (!current || at > current.at) {
      lastCount.set(line.productId, { countId: line.countId, at, hadVariance: false });
    }
  }
  for (const line of approvedLines) {
    const last = lastCount.get(line.productId)!;
    if (line.countId === last.countId && (line.variance ?? 0) !== 0) last.hadVariance = true;
  }

  const sellers = productIds
    .filter((id) => (sold.get(id) ?? 0) > 0)
    .sort((a, b) => sold.get(b)! - sold.get(a)! || a.localeCompare(b));
  const velocityRank = new Map(sellers.map((id, i) => [id, i]));
  const topA = Math.ceil(sellers.length * CLASS_A_VELOCITY_SHARE);
  const topB = Math.ceil(sellers.length * CLASS_B_VELOCITY_SHARE);

  const highValue = settings.highValueThreshold;
  const classBValue = highValue.mul(CLASS_B_VALUE_SHARE);
  const maxValue = Math.max(...productIds.map((id) => byProduct.get(id)!.value.toNumber()), 0);
  const maxSold = Math.max(...sellers.map((id) => sold.get(id)!), 0);
  const nextCycle = new Date(now.getTime() + frequencyDays * MS_PER_DAY);

  type Ranked = CycleCountCandidate & { flagged: boolean };
  const ranked: Ranked[] = [];
  let alreadyOnOpenCount = 0;

  for (const productId of productIds) {
    const risk = byProduct.get(productId)!;
    const unitsSold = sold.get(productId) ?? 0;
    const last = lastCount.get(productId) ?? null;

    const valueClass: AbcClass = risk.value.gte(highValue)
      ? "A"
      : risk.value.gte(classBValue)
        ? "B"
        : "C";
    const rank = velocityRank.get(productId);
    const velocityClass: AbcClass =
      rank === undefined ? "C" : rank < topA ? "A" : rank < topB ? "B" : "C";
    const abcClass = betterClass(valueClass, velocityClass);

    const intervalDays = CLASS_INTERVAL_CYCLES[abcClass] * frequencyDays;
    const nextDueAt = last ? new Date(last.at.getTime() + intervalDays * MS_PER_DAY) : null;
    const due = !nextDueAt || nextDueAt <= nextCycle;
    const flagged = (last?.hadVariance ?? false) || risk.nearExpiry;
    if (!due && !flagged) continue;
    if (onOpen.has(productId)) {
      alreadyOnOpenCount += 1;
      continue;
    }

    const reasons: CycleCountReason[] = [];
    if (last?.hadVariance) reasons.push("VARIANCE_LAST_COUNT");
    if (risk.nearExpiry) reasons.push("NEAR_EXPIRY");
    if (valueClass === "A") reasons.push("HIGH_VALUE");
    if (velocityClass === "A") reasons.push("HIGH_VELOCITY");
    if (!last) reasons.push("NEVER_COUNTED");
    else if (due) reasons.push("DUE");

    const staleness = last
      ? Math.min(1, (now.getTime() - last.at.getTime()) / (intervalDays * MS_PER_DAY))
      : 1;
    const score =
      (maxValue > 0 ? risk.value.toNumber() / maxValue : 0) +
      (maxSold > 0 ? unitsSold / maxSold : 0) +
      staleness;

    ranked.push({
      productId,
      sku: risk.sku,
      productName: risk.name,
      abcClass,
      reasons,
      valueOnHand: moneyDec(risk.value).toFixed(2),
      unitsSold,
      lastCountedAt: last?.at ?? null,
      score: Math.round(score * 1000) / 1000,
      flagged,
    });
  }

  ranked.sort(
    (a, b) =>
      Number(b.flagged) - Number(a.flagged) ||
      b.score - a.score ||
      a.productId.localeCompare(b.productId),
  );

  return {
    ...empty,
    selected: ranked.slice(0, size).map(({ flagged: _flagged, ...candidate }) => candidate),
    dueButDeferred: Math.max(0, ranked.length - size),
    alreadyOnOpenCount,
  };
}

type NewCountInput = {
  storeId: string;
  type: StockCountType;
  lots: Array<{ id: string; productId: string }>;
  /** Null when the scheduler creates the count. */
  createdByUserId: string | null;
  scheduledFor: Date | null;
  notes: string | null;
  ipAddress: string | null;
  auditAfter: Record<string, Prisma.InputJsonValue>;
};

async function insertCount(input: NewCountInput): Promise<StockCount> {
  return prisma.$transaction(async (tx) => {
    // Serialise count creation per store so two requests cannot both pass the overlap check.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stock_count:${input.storeId}`}))`;

    const productIds = [...new Set(input.lots.map((l) => l.productId))];
    const clashes = await tx.stockCountLine.findMany({
      where: { productId: { in: productIds }, count: openCountWhere(input.storeId) },
      select: { productId: true, countId: true },
      distinct: ["productId"],
    });
    if (clashes.length > 0) {
      throw new AppError(
        409,
        "Some products are already on an open count; finish or cancel that count first",
        { products: clashes },
      );
    }

    const created = await tx.stockCount.create({
      data: {
        storeId: input.storeId,
        type: input.type,
        createdByUserId: input.createdByUserId,
        scheduledFor: input.scheduledFor,
        notes: input.notes,
      },
    });
    await tx.stockCountLine.createMany({
      data: input.lots.map((lot) => ({
        countId: created.id,
        productId: lot.productId,
        lotId: lot.id,
        expectedQuantity: 0,
      })),
    });
    await writeAuditLog(
      {
        userId: input.createdByUserId,
        storeId: input.storeId,
        action: AuditAction.STOCK_COUNT_CREATE,
        entityType: "StockCount",
        entityId: created.id,
        after: { type: input.type, lineCount: input.lots.length, ...input.auditAfter },
        ipAddress: input.ipAddress,
      },
      { tx },
    );
    return created;
  });
}

function scheduleAudit(schedule: CycleCountSchedule): Record<string, Prisma.InputJsonValue> {
  return {
    products: schedule.selected.map((c) => ({
      productId: c.productId,
      abcClass: c.abcClass,
      reasons: c.reasons,
    })),
    dueButDeferred: schedule.dueButDeferred,
  };
}

/**
 * Creates the next DRAFT cycle count for a store from generateCycleCountSchedule, with no human
 * creator. Returns null when nothing is due. Used by the scheduleCycleCounts job.
 */
export async function scheduleCycleCount(
  storeId: string,
  now = new Date(),
): Promise<{ countId: string; schedule: CycleCountSchedule } | null> {
  const schedule = await generateCycleCountSchedule(storeId, now);
  if (schedule.selected.length === 0) return null;

  const lots = await prisma.lot.findMany({
    where: countableLotWhere(storeId, schedule.selected.map((c) => c.productId)),
    select: { id: true, productId: true },
  });
  const count = await insertCount({
    storeId,
    type: StockCountType.CYCLE,
    lots,
    createdByUserId: null,
    scheduledFor: now,
    notes: "Scheduled cycle count",
    ipAddress: null,
    auditAfter: { scheduledBy: "SYSTEM", ...scheduleAudit(schedule) },
  });
  return { countId: count.id, schedule };
}

/**
 * Creates a DRAFT count with one line per lot. expectedQuantity stays 0 until startCount freezes it.
 * FULL counts every countable lot; CYCLE without ids uses generateCycleCountSchedule; SPOT and
 * RECEIVING_VERIFY need explicit productIds and/or lotIds. Rejected with 409 if any product is
 * already on an open count.
 */
export async function createCount(
  actor: AuthUser,
  storeId: string,
  type: StockCountType,
  options: CreateCountOptions = {},
): Promise<CounterCountView> {
  assertStoreAdmin(actor, "create stock counts");
  assertStoreAccess(actor, storeId);

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store || !store.isActive) throw new AppError(400, "Store not found or inactive");

  let productIds = uniq(options.productIds);
  const lotIds = uniq(options.lotIds);
  const hasIds = productIds.length > 0 || lotIds.length > 0;

  if (type === StockCountType.FULL && hasIds) {
    throw new AppError(400, "FULL counts include every product; do not pass productIds or lotIds");
  }
  if (
    (type === StockCountType.SPOT || type === StockCountType.RECEIVING_VERIFY) &&
    !hasIds
  ) {
    throw new AppError(400, `${type} counts need productIds or lotIds`);
  }

  const lotsById = new Map<string, { id: string; productId: string }>();
  let schedule: CycleCountSchedule | null = null;

  if (type === StockCountType.FULL) {
    for (const lot of await prisma.lot.findMany({
      where: countableLotWhere(storeId),
      select: { id: true, productId: true },
    })) {
      lotsById.set(lot.id, lot);
    }
  } else {
    if (type === StockCountType.CYCLE && !hasIds) {
      schedule = await generateCycleCountSchedule(storeId);
      productIds = schedule.selected.map((c) => c.productId);
      if (productIds.length === 0) {
        throw new AppError(400, "No products are due for a cycle count", {
          alreadyOnOpenCount: schedule.alreadyOnOpenCount,
        });
      }
    }

    if (productIds.length > 0) {
      const products = await prisma.product.findMany({
        where: { id: { in: productIds }, storeId },
        select: { id: true },
      });
      if (products.length !== productIds.length) {
        const found = new Set(products.map((p) => p.id));
        throw new AppError(404, "Some products were not found for this store", {
          missingProductIds: productIds.filter((id) => !found.has(id)),
        });
      }
      const lots = await prisma.lot.findMany({
        where: countableLotWhere(storeId, productIds),
        select: { id: true, productId: true },
      });
      const withLots = new Set(lots.map((l) => l.productId));
      const withoutLots = productIds.filter((id) => !withLots.has(id));
      if (withoutLots.length > 0) {
        throw new AppError(400, "Some products have no lots to count; count a specific lot instead", {
          productIds: withoutLots,
        });
      }
      for (const lot of lots) lotsById.set(lot.id, lot);
    }

    if (lotIds.length > 0) {
      const lots = await prisma.lot.findMany({
        where: { id: { in: lotIds }, storeId },
        select: { id: true, productId: true, status: true },
      });
      if (lots.length !== lotIds.length) {
        const found = new Set(lots.map((l) => l.id));
        throw new AppError(404, "Some lots were not found for this store", {
          missingLotIds: lotIds.filter((id) => !found.has(id)),
        });
      }
      const expired = lots.filter((l) => l.status === LotStatus.EXPIRED);
      if (expired.length > 0) {
        throw new AppError(400, "EXPIRED lots have already been written off and cannot be counted", {
          lotIds: expired.map((l) => l.id),
        });
      }
      for (const lot of lots) lotsById.set(lot.id, { id: lot.id, productId: lot.productId });
    }
  }

  if (lotsById.size === 0) {
    throw new AppError(400, "Nothing to count: no lots match this selection");
  }

  const count = await insertCount({
    storeId,
    type,
    lots: [...lotsById.values()],
    createdByUserId: actor.id,
    scheduledFor: options.scheduledFor ?? null,
    notes: options.notes?.trim() || null,
    ipAddress: options.ipAddress ?? null,
    auditAfter: schedule ? { autoSelected: true, ...scheduleAudit(schedule) } : {},
  });

  return getCountForCounter(actor, count.id);
}

/**
 * Freezes expectedQuantity for every line from the lots' current quantityRemaining and moves the
 * count to IN_PROGRESS. startedAt marks the snapshot; sales after it are reconciled per line.
 */
export async function startCount(
  actor: AuthUser,
  countId: string,
  ipAddress?: string | null,
): Promise<CounterCountView> {
  assertStoreAdmin(actor, "start stock counts");

  await prisma.$transaction(async (tx) => {
    const count = await loadCount(tx, actor, countId);
    if (count.status !== StockCountStatus.DRAFT) {
      throw new AppError(409, "Only DRAFT counts can be started", { status: count.status });
    }

    const lines = await tx.stockCountLine.findMany({
      where: { countId },
      select: { id: true, lotId: true },
    });
    if (lines.some((l) => l.lotId === null)) {
      throw new AppError(409, "Count has product-level lines; every line must name a lot");
    }

    const startedAt = new Date();
    const lots = await tx.lot.findMany({
      where: { id: { in: lines.map((l) => l.lotId!) } },
      select: { id: true, quantityRemaining: true },
    });
    const qtyByLot = new Map(lots.map((l) => [l.id, l.quantityRemaining]));

    for (const line of lines) {
      await tx.stockCountLine.update({
        where: { id: line.id },
        data: { expectedQuantity: qtyByLot.get(line.lotId!) ?? 0 },
      });
    }

    const claimed = await tx.stockCount.updateMany({
      where: { id: countId, status: StockCountStatus.DRAFT },
      data: { status: StockCountStatus.IN_PROGRESS, startedAt },
    });
    if (claimed.count !== 1) {
      throw new AppError(409, "Count was started by someone else");
    }

    await writeAuditLog(
      {
        userId: actor.id,
        storeId: count.storeId,
        action: AuditAction.STOCK_COUNT_START,
        entityType: "StockCount",
        entityId: countId,
        before: { status: StockCountStatus.DRAFT },
        after: { status: StockCountStatus.IN_PROGRESS, startedAt: startedAt.toISOString(), lineCount: lines.length },
        ipAddress: ipAddress ?? null,
      },
      { tx },
    );
  });

  return getCountForCounter(actor, countId);
}

/** True when a variance is large enough (by percent OR by value) to need a recount. */
function exceedsRecountThreshold(
  expectedAtCount: number,
  variance: number,
  varianceValue: Prisma.Decimal,
  thresholds: { percent: Prisma.Decimal; value: Prisma.Decimal },
): boolean {
  if (variance === 0) return false;
  if (varianceValue.abs().gt(thresholds.value)) return true;
  if (expectedAtCount <= 0) return true;
  const pct = new Prisma.Decimal(Math.abs(variance)).mul(100).div(expectedAtCount);
  return pct.gt(thresholds.percent);
}

/** Other store staff who could take a recount (store-scoped, not currently locked out). */
async function otherCountersAvailable(
  db: DbClient,
  storeId: string,
  excludeUserId: string,
): Promise<number> {
  return db.user.count({
    where: {
      storeId,
      id: { not: excludeUserId },
      role: { in: [Role.CASHIER, Role.STORE_ADMIN] },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
    },
  });
}

/**
 * How a count was captured, for submissions replayed from a device's offline queue.
 *
 * countedAt and sentAt are both the DEVICE's clock. The server corrects countedAt by the device's
 * skew (server receive time − sentAt), so a tablet whose clock is ten minutes slow does not
 * misplace the count against sales. The result is clamped to [startedAt, now].
 */
export type CountSubmission = {
  /** Minted once per entry on the device; a retry with the same key is a replay, not a recount. */
  idempotencyKey?: string | null;
  countedAt?: Date | null;
  sentAt?: Date | null;
};

type SubmitResult = { lineId: string; status: StockCountLineStatus; replayed?: true };

async function findSubmission(db: DbClient, key: string) {
  return db.stockCountLine.findFirst({
    where: { OR: [{ countSubmissionKey: key }, { recountSubmissionKey: key }] },
    select: { id: true, countId: true, status: true },
  });
}

function replayOf(
  existing: { id: string; countId: string; status: StockCountLineStatus },
  countId: string,
  lineId: string,
): SubmitResult {
  if (existing.id !== lineId || existing.countId !== countId) {
    throw new AppError(409, "idempotencyKey was already used for a different count line");
  }
  return { lineId, status: existing.status, replayed: true };
}

/** The physical moment of the count on the server's clock: see CountSubmission. */
function resolveCountedAt(submission: CountSubmission | undefined, startedAt: Date | null, now: Date): Date {
  if (!submission?.countedAt) return now;
  let t = submission.countedAt.getTime();
  if (submission.sentAt) t += now.getTime() - submission.sentAt.getTime();
  t = Math.min(t, now.getTime());
  if (startedAt) t = Math.max(t, startedAt.getTime());
  return new Date(t);
}

/**
 * Records a physical count for one line.
 *
 * The variance is measured against the lot as it stood at the moment of counting, so it already
 * accounts for every sale between startCount and the count: see approveCount for why. Online,
 * that is the live quantityRemaining. For an entry queued offline and synced later, units paid
 * from the lot after countedAt are added back — they were still on the shelf when the counter
 * looked. Restocked refunds in that gap are not reconstructed (refunds do not record which lot
 * took the units back until finalize); they are rare in the minutes a stockroom is out of signal,
 * and would show as a small shortfall that the review screen's movement column makes visible.
 *
 * First count over the recount threshold → RECOUNT_REQUIRED. The recount must be entered by a
 * different person unless nobody else on the store's staff can do it; the recount figure stands
 * and the line becomes RESOLVED. The response carries the line status only, never a figure.
 */
export async function submitCountLine(
  actor: AuthUser,
  countId: string,
  lineId: string,
  countedQuantity: number,
  ipAddress?: string | null,
  submission?: CountSubmission,
): Promise<SubmitResult> {
  if (!Number.isInteger(countedQuantity) || countedQuantity < 0) {
    throw new AppError(400, "countedQuantity must be a non-negative whole number");
  }
  const key = submission?.idempotencyKey?.trim() || null;

  const settings = await getCooperativeSettings();
  const thresholds = {
    percent: settings.varianceThresholdPercent,
    value: settings.varianceThresholdValue,
  };

  return prisma.$transaction(async (tx) => {
    const count = await loadCount(tx, actor, countId);

    // A replay must succeed even if the count has since moved on (e.g. was completed).
    if (key) {
      const existing = await findSubmission(tx, key);
      if (existing) return replayOf(existing, countId, lineId);
    }

    if (count.status !== StockCountStatus.IN_PROGRESS) {
      throw new AppError(409, "Lines can only be counted while the count is IN_PROGRESS", {
        status: count.status,
      });
    }

    const line = await tx.stockCountLine.findFirst({ where: { id: lineId, countId } });
    if (!line) throw new AppError(404, "Count line not found");
    if (!line.lotId) throw new AppError(409, "Count line has no lot");

    const isRecount = line.status === StockCountLineStatus.RECOUNT_REQUIRED;
    if (!isRecount && line.status !== StockCountLineStatus.PENDING) {
      throw new AppError(409, "This line has already been counted", { status: line.status });
    }

    let sameCounterRecount = false;
    if (isRecount && line.countedByUserId === actor.id) {
      if ((await otherCountersAvailable(tx, count.storeId, actor.id)) > 0) {
        throw new AppError(409, "A recount must be done by a different person from the first count");
      }
      sameCounterRecount = true;
    }

    const lot = await tx.lot.findUniqueOrThrow({
      where: { id: line.lotId },
      select: { quantityRemaining: true, unitCost: true },
    });
    const now = new Date();
    const countedAt = resolveCountedAt(submission, count.startedAt, now);
    let paidSinceCount = 0;
    if (countedAt < now) {
      const sold = await tx.saleItemLot.aggregate({
        where: { lotId: line.lotId, saleItem: { sale: { paidAt: { gt: countedAt, lte: now } } } },
        _sum: { quantity: true },
      });
      paidSinceCount = sold._sum.quantity ?? 0;
    }
    const quantityAtCount = lot.quantityRemaining + paidSinceCount;
    const movementDuringCount = line.expectedQuantity - quantityAtCount;
    const variance = countedQuantity - quantityAtCount;
    const varianceValue = moneyDec(lot.unitCost.mul(variance));

    let status: StockCountLineStatus;
    let data: Prisma.StockCountLineUncheckedUpdateManyInput;
    if (isRecount) {
      status = StockCountLineStatus.RESOLVED;
      data = {
        recountedQuantity: countedQuantity,
        recountedByUserId: actor.id,
        recountedAt: countedAt,
        recountSubmissionKey: key,
        movementDuringCount,
        variance,
        varianceValue,
        status,
      };
    } else {
      status = exceedsRecountThreshold(quantityAtCount, variance, varianceValue, thresholds)
        ? StockCountLineStatus.RECOUNT_REQUIRED
        : StockCountLineStatus.COUNTED;
      data = {
        countedQuantity,
        countedByUserId: actor.id,
        countedAt,
        countSubmissionKey: key,
        movementDuringCount,
        variance,
        varianceValue,
        status,
      };
    }

    const claimed = await tx.stockCountLine.updateMany({
      where: { id: line.id, status: line.status },
      data,
    });
    if (claimed.count !== 1) {
      // The same queued entry arriving twice at once: the other request won, so this is a replay.
      if (key) {
        const existing = await findSubmission(tx, key);
        if (existing) return replayOf(existing, countId, lineId);
      }
      throw new AppError(409, "This line was just counted by someone else");
    }

    if (!count.countedByUserId) {
      await tx.stockCount.update({
        where: { id: countId },
        data: { countedByUserId: actor.id },
      });
    }

    // Figures other than the counted quantity stay out of this entry: staff who can read the audit
    // log mid-count would otherwise learn the variance, and with it the expected quantity.
    await writeAuditLog(
      {
        userId: actor.id,
        storeId: count.storeId,
        action: AuditAction.STOCK_COUNT_LINE_COUNT,
        entityType: "StockCountLine",
        entityId: line.id,
        after: {
          countId,
          lotId: line.lotId,
          countedQuantity,
          recount: isRecount,
          status,
          ...(sameCounterRecount ? { sameCounterRecount: true } : {}),
          ...(submission?.countedAt ? { queuedOffline: true, countedAt: countedAt.toISOString() } : {}),
        },
        ipAddress: ipAddress ?? null,
      },
      { tx },
    );

    return { lineId: line.id, status };
  });
}

/** Closes counting. Every line must be COUNTED or RESOLVED (recounts done). */
export async function completeCount(
  actor: AuthUser,
  countId: string,
  ipAddress?: string | null,
): Promise<CounterCountView> {
  await prisma.$transaction(async (tx) => {
    const count = await loadCount(tx, actor, countId);
    if (count.status !== StockCountStatus.IN_PROGRESS) {
      throw new AppError(409, "Only IN_PROGRESS counts can be completed", { status: count.status });
    }

    const open = await tx.stockCountLine.groupBy({
      by: ["status"],
      where: {
        countId,
        status: { notIn: [StockCountLineStatus.COUNTED, StockCountLineStatus.RESOLVED] },
      },
      _count: { _all: true },
    });
    if (open.length > 0) {
      throw new AppError(409, "Every line must be counted, and every recount done, before completing", {
        open: Object.fromEntries(open.map((row) => [row.status, row._count._all])),
      });
    }

    const completedAt = new Date();
    const claimed = await tx.stockCount.updateMany({
      where: { id: countId, status: StockCountStatus.IN_PROGRESS },
      data: { status: StockCountStatus.COMPLETED, completedAt },
    });
    if (claimed.count !== 1) throw new AppError(409, "Count was completed by someone else");

    await writeAuditLog(
      {
        userId: actor.id,
        storeId: count.storeId,
        action: AuditAction.STOCK_COUNT_COMPLETE,
        entityType: "StockCount",
        entityId: countId,
        before: { status: StockCountStatus.IN_PROGRESS },
        after: { status: StockCountStatus.COMPLETED, completedAt: completedAt.toISOString() },
        ipAddress: ipAddress ?? null,
      },
      { tx },
    );
  });

  return getCountForCounter(actor, countId);
}

/** Cancels a count that has not been applied to stock. Counts are never deleted. */
export async function cancelCount(
  actor: AuthUser,
  countId: string,
  reason: string,
  ipAddress?: string | null,
): Promise<CounterCountView> {
  assertStoreAdmin(actor, "cancel stock counts");
  const trimmed = reason.trim();
  if (!trimmed) throw new AppError(400, "A cancellation reason is required");

  await prisma.$transaction(async (tx) => {
    const count = await loadCount(tx, actor, countId);
    if (count.status === StockCountStatus.CANCELLED) {
      throw new AppError(409, "Count is already cancelled");
    }
    if (count.approvedAt) {
      throw new AppError(409, "An approved count has already adjusted stock and cannot be cancelled");
    }
    const claimed = await tx.stockCount.updateMany({
      where: { id: countId, status: count.status, approvedAt: null },
      data: { status: StockCountStatus.CANCELLED },
    });
    if (claimed.count !== 1) throw new AppError(409, "Count changed while cancelling; try again");

    await writeAuditLog(
      {
        userId: actor.id,
        storeId: count.storeId,
        action: AuditAction.STOCK_COUNT_CANCEL,
        entityType: "StockCount",
        entityId: countId,
        before: { status: count.status },
        after: { status: StockCountStatus.CANCELLED, reason: trimmed },
        ipAddress: ipAddress ?? null,
      },
      { tx },
    );
  });

  return getCountForCounter(actor, countId);
}

/** Store-scoped count list. Carries no quantities, so it is safe for counters. */
export async function listCounts(
  actor: AuthUser,
  storeId: string,
  status?: StockCountStatus,
): Promise<
  Array<{
    id: string;
    type: StockCountType;
    status: StockCountStatus;
    scheduledFor: Date | null;
    startedAt: Date | null;
    completedAt: Date | null;
    approvedAt: Date | null;
    lineCount: number;
    scheduledBySystem: boolean;
    createdAt: Date;
  }>
> {
  assertStoreAccess(actor, storeId);
  const counts = await prisma.stockCount.findMany({
    where: { storeId, ...(status ? { status } : {}) },
    include: { _count: { select: { lines: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return counts.map((c) => ({
    id: c.id,
    type: c.type,
    status: c.status,
    scheduledFor: c.scheduledFor,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
    approvedAt: c.approvedAt,
    lineCount: c._count.lines,
    scheduledBySystem: c.createdByUserId === null,
    createdAt: c.createdAt,
  }));
}

/** The counting view. Never includes expectedQuantity, variance, movement or anyone's figures. */
export async function getCountForCounter(
  actor: AuthUser,
  countId: string,
): Promise<CounterCountView> {
  const count = await loadCount(prisma, actor, countId);
  const lines = await prisma.stockCountLine.findMany({
    where: { countId },
    select: {
      id: true,
      productId: true,
      lotId: true,
      status: true,
      countedByUserId: true,
      product: { select: { sku: true, name: true, barcodes: { select: { code: true } } } },
      lot: { select: { lotNumber: true, expiryDate: true, barcode: true } },
    },
    orderBy: [{ product: { name: "asc" } }, { lot: { lotNumber: "asc" } }],
  });

  return {
    id: count.id,
    storeId: count.storeId,
    type: count.type,
    status: count.status,
    scheduledFor: count.scheduledFor,
    startedAt: count.startedAt,
    completedAt: count.completedAt,
    notes: count.notes,
    lines: lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      sku: line.product.sku,
      productName: line.product.name,
      lotId: line.lotId,
      lotNumber: line.lot?.lotNumber ?? null,
      expiryDate: line.lot?.expiryDate ?? null,
      productBarcodes: line.product.barcodes.map((b) => b.code),
      lotBarcode: line.lot?.barcode ?? null,
      status: line.status,
      countedByYou: line.countedByUserId === actor.id,
      recountByAnotherPerson:
        line.status === StockCountLineStatus.RECOUNT_REQUIRED &&
        line.countedByUserId === actor.id,
    })),
  };
}

type LineForSales = {
  id: string;
  lotId: string | null;
  countedAt: Date | null;
  recountedAt: Date | null;
};

/**
 * Units sold from each line's lot between startedAt and the moment that line was (re)counted.
 * A sale moves stock when it is paid (cash immediately, card on finalize), so paidAt is the clock.
 */
async function soldDuringCountByLine(
  db: DbClient,
  startedAt: Date | null,
  lines: LineForSales[],
): Promise<Map<string, number>> {
  const sold = new Map<string, number>();
  const windows = lines
    .map((l) => ({ id: l.id, lotId: l.lotId, until: l.recountedAt ?? l.countedAt }))
    .filter((w): w is { id: string; lotId: string; until: Date } => !!w.lotId && !!w.until);
  if (!startedAt || windows.length === 0) return sold;

  const until = new Date(Math.max(...windows.map((w) => w.until.getTime())));
  const allocations = await db.saleItemLot.findMany({
    where: {
      lotId: { in: windows.map((w) => w.lotId) },
      saleItem: { sale: { paidAt: { gt: startedAt, lte: until } } },
    },
    select: { lotId: true, quantity: true, saleItem: { select: { sale: { select: { paidAt: true } } } } },
  });

  for (const w of windows) {
    let units = 0;
    for (const a of allocations) {
      const paidAt = a.saleItem.sale.paidAt;
      if (a.lotId === w.lotId && paidAt && paidAt <= w.until) units += a.quantity;
    }
    sold.set(w.id, units);
  }
  return sold;
}

async function buildReview(db: DbClient, count: StockCount): Promise<ReviewCountView> {
  const lines = await db.stockCountLine.findMany({
    where: { countId: count.id },
    include: {
      product: { select: { sku: true, name: true } },
      lot: { select: { lotNumber: true, status: true, unitCost: true } },
    },
    orderBy: [{ product: { name: "asc" } }, { lot: { lotNumber: "asc" } }],
  });
  const sold = await soldDuringCountByLine(db, count.startedAt, lines);

  let shrinkage = new Prisma.Decimal(0);
  let overage = new Prisma.Decimal(0);
  let linesWithVariance = 0;
  const view: ReviewLineView[] = lines.map((line) => {
    const value = line.varianceValue ?? new Prisma.Decimal(0);
    if (line.variance) {
      linesWithVariance += 1;
      if (value.lt(0)) shrinkage = shrinkage.add(value.abs());
      else overage = overage.add(value);
    }
    return {
      id: line.id,
      productId: line.productId,
      sku: line.product.sku,
      productName: line.product.name,
      lotId: line.lotId,
      lotNumber: line.lot?.lotNumber ?? null,
      lotStatus: line.lot?.status ?? null,
      unitCost: line.lot ? line.lot.unitCost.toFixed(2) : null,
      status: line.status,
      expectedQuantity: line.expectedQuantity,
      soldDuringCount: sold.get(line.id) ?? 0,
      movementDuringCount: line.movementDuringCount,
      expectedAtCount:
        line.movementDuringCount === null ? null : line.expectedQuantity - line.movementDuringCount,
      countedQuantity: line.countedQuantity,
      countedByUserId: line.countedByUserId,
      recountedQuantity: line.recountedQuantity,
      recountedByUserId: line.recountedByUserId,
      finalCountedQuantity: line.recountedQuantity ?? line.countedQuantity,
      variance: line.variance,
      varianceValue: line.varianceValue ? line.varianceValue.toFixed(2) : null,
      reasonCode: line.reasonCode,
    };
  });

  return {
    id: count.id,
    storeId: count.storeId,
    type: count.type,
    status: count.status,
    startedAt: count.startedAt,
    completedAt: count.completedAt,
    approvedAt: count.approvedAt,
    approvedByUserId: count.approvedByUserId,
    lines: view,
    totals: {
      lines: lines.length,
      linesWithVariance,
      shrinkageValue: moneyDec(shrinkage).toFixed(2),
      overageValue: moneyDec(overage).toFixed(2),
      netVarianceValue: moneyDec(overage.sub(shrinkage)).toFixed(2),
    },
  };
}

/**
 * Approver view with expected quantities and variances. Only STORE_ADMIN / COOP_ADMIN, and only
 * once counting is submitted (COMPLETED) — before that it would defeat the blind count.
 */
export async function getCountForReview(
  actor: AuthUser,
  countId: string,
): Promise<ReviewCountView> {
  assertStoreAdmin(actor, "review stock counts");
  const count = await loadCount(prisma, actor, countId);
  if (count.status !== StockCountStatus.COMPLETED) {
    throw new AppError(409, "Expected quantities are only shown once counting is complete", {
      status: count.status,
    });
  }
  return buildReview(prisma, count);
}

type LockedLot = {
  id: string;
  lotNumber: string;
  productId: string;
  status: LotStatus;
  quantityRemaining: number;
  quantityReserved: number;
  unitCost: Prisma.Decimal;
};

/**
 * Applies a COMPLETED count to stock in ONE transaction: lot quantities, the Product.stock rollup,
 * a StockAdjustment per variance line, an InventoryWriteOff per shrinkage line (valued at lot unit
 * cost), and the AuditLog.
 *
 * SALES DURING THE COUNT — the part most implementations get wrong.
 * expectedQuantity is frozen at startCount, but the store keeps trading while people count. If the
 * snapshot says 40, 3 are sold, and the counter finds 37, nothing is missing — yet a naive
 * "counted − expected" reports −3 shrinkage, and "set the lot to the counted figure" at approval
 * also erases every sale made after that shelf was counted.
 *
 * So the comparison is done per line, at the moment the line was counted:
 *   movementDuringCount = expectedQuantity − lot quantity when the line was (re)counted
 *                         (sales out, minus restocked refunds back in, over startedAt → countedAt)
 *   expectedAtCount     = expectedQuantity − movementDuringCount
 *   true variance       = counted − expectedAtCount
 * The window ends when the LINE was counted, not at completedAt: a sale after the shelf was counted
 * but before the whole count finished did not affect what the counter saw, and must not be
 * subtracted again. soldDuringCount (from SaleItemLot by paidAt) is reported beside it so the
 * approver can see how much of the movement was sales.
 *
 * At approval the true variance is applied as a DELTA to the lot's CURRENT quantity, which already
 * reflects sales since the line was counted. Writing the counted figure over the lot instead would
 * resurrect every unit sold in between.
 *
 * QUARANTINED / RECALLED lots are never adjusted without overrideBlockedLots + overrideReason, and
 * each such adjustment gets its own STOCK_COUNT_BLOCKED_LOT_OVERRIDE audit entry. They are not in
 * the sellable rollup, so Product.stock does not move for them.
 */
export async function approveCount(
  actor: AuthUser,
  countId: string,
  options: ApproveCountOptions = {},
): Promise<ReviewCountView> {
  assertStoreAdmin(actor, "approve stock counts");

  const reasons = options.reasons ?? {};
  const validReasons = new Set<string>(Object.values(ShrinkageReason));
  for (const [lineId, code] of Object.entries(reasons)) {
    if (!validReasons.has(code)) {
      throw new AppError(400, "Unknown shrinkage reason", { lineId, reasonCode: code });
    }
  }
  const overrideReason = options.overrideReason?.trim() ?? "";
  if (options.overrideBlockedLots && !overrideReason) {
    throw new AppError(400, "overrideReason is required when overriding QUARANTINED or RECALLED lots");
  }

  return prisma.$transaction(async (tx) => {
    const count = await loadCount(tx, actor, countId);
    if (count.status !== StockCountStatus.COMPLETED) {
      throw new AppError(409, "Only COMPLETED counts can be approved", { status: count.status });
    }
    if (count.approvedAt) {
      throw new AppError(409, "Count has already been approved");
    }

    const approvedAt = new Date();
    const claimed = await tx.stockCount.updateMany({
      where: { id: countId, status: StockCountStatus.COMPLETED, approvedAt: null },
      data: { approvedByUserId: actor.id, approvedAt },
    });
    if (claimed.count !== 1) throw new AppError(409, "Count was approved by someone else");

    const lines = await tx.stockCountLine.findMany({ where: { countId } });
    const unknownLineIds = Object.keys(reasons).filter((id) => !lines.some((l) => l.id === id));
    if (unknownLineIds.length > 0) {
      throw new AppError(400, "reasons reference lines not on this count", { lineIds: unknownLineIds });
    }

    const varianceLines = lines.filter((l) => (l.variance ?? 0) !== 0);
    const lotIds = [...new Set(varianceLines.map((l) => l.lotId).filter((id): id is string => !!id))];
    const lots = lotIds.length
      ? await tx.$queryRaw<LockedLot[]>`
          SELECT id, "lotNumber", "productId", status, "quantityRemaining", "quantityReserved", "unitCost"
          FROM "Lot"
          WHERE id IN (${Prisma.join(lotIds)})
          FOR UPDATE
        `
      : [];
    const lotById = new Map(lots.map((l) => [l.id, l]));

    const blocked = varianceLines.filter((l) => {
      const lot = l.lotId ? lotById.get(l.lotId) : undefined;
      return lot && BLOCKED_LOT_STATUSES.includes(lot.status);
    });
    if (blocked.length > 0 && !options.overrideBlockedLots) {
      throw new AppError(
        409,
        "Count would adjust QUARANTINED or RECALLED lots; approve with an explicit override",
        {
          lines: blocked.map((l) => {
            const lot = lotById.get(l.lotId!)!;
            return { lineId: l.id, lotId: lot.id, lotNumber: lot.lotNumber, status: lot.status };
          }),
        },
      );
    }

    const sold = await soldDuringCountByLine(tx, count.startedAt, varianceLines);
    const applied: Prisma.InputJsonValue[] = [];

    for (const line of varianceLines) {
      if (!line.lotId) throw new AppError(409, "Count line has no lot", { lineId: line.id });
      const lot = lotById.get(line.lotId)!;
      const reasonCode = reasons[line.id] ?? line.reasonCode ?? ShrinkageReason.UNKNOWN;
      const variance = line.variance!;
      const isBlocked = BLOCKED_LOT_STATUSES.includes(lot.status);

      const previousQty = lot.quantityRemaining;
      const unclamped = previousQty + variance;
      const targetQty = Math.max(0, unclamped);
      if (lot.status === LotStatus.ACTIVE && targetQty < lot.quantityReserved) {
        throw new AppError(
          409,
          "Adjustment would drop a lot below units held by pending sales; settle them before approving",
          { lineId: line.id, lotId: lot.id, quantityReserved: lot.quantityReserved, targetQty },
        );
      }
      const delta = targetQty - previousQty;

      await tx.stockCountLine.update({ where: { id: line.id }, data: { reasonCode } });

      const nextStatus =
        lot.status === LotStatus.ACTIVE && targetQty === 0
          ? LotStatus.DEPLETED
          : lot.status === LotStatus.DEPLETED && targetQty > 0
            ? LotStatus.ACTIVE
            : lot.status;

      if (delta !== 0 || nextStatus !== lot.status) {
        await tx.lot.update({
          where: { id: lot.id },
          data: { quantityRemaining: targetQty, status: nextStatus },
        });
      }

      // Product.stock is the rollup of ACTIVE lots only (npm run verify:stock).
      const rollupDelta =
        (nextStatus === LotStatus.ACTIVE ? targetQty : 0) -
        (lot.status === LotStatus.ACTIVE ? previousQty : 0);

      const reason = isBlocked
        ? `STOCK_COUNT:${reasonCode} (${lot.status} lot, override)`
        : `STOCK_COUNT:${reasonCode}`;

      if (rollupDelta !== 0) {
        const product = await tx.product.findUniqueOrThrow({
          where: { id: lot.productId },
          select: { stock: true },
        });
        await tx.product.update({
          where: { id: lot.productId },
          data: { stock: { increment: rollupDelta } },
        });
        await tx.stockAdjustment.create({
          data: {
            productId: lot.productId,
            storeId: count.storeId,
            adjustedById: actor.id,
            previousStock: product.stock,
            newStock: product.stock + rollupDelta,
            delta: rollupDelta,
            reason,
            lotId: lot.id,
          },
        });
      } else if (delta !== 0) {
        // Lot outside the sellable rollup: the lot's own quantities are the only honest before/after.
        await tx.stockAdjustment.create({
          data: {
            productId: lot.productId,
            storeId: count.storeId,
            adjustedById: actor.id,
            previousStock: previousQty,
            newStock: targetQty,
            delta,
            reason,
            lotId: lot.id,
          },
        });
      }

      if (delta < 0) {
        const quantity = -delta;
        await tx.inventoryWriteOff.create({
          data: {
            storeId: count.storeId,
            productId: lot.productId,
            lotId: lot.id,
            quantity,
            reason: `STOCK_COUNT:${reasonCode}`,
            unitCost: lot.unitCost,
            value: moneyDec(lot.unitCost.mul(quantity)),
          },
        });
      }

      if (isBlocked) {
        await writeAuditLog(
          {
            userId: actor.id,
            storeId: count.storeId,
            action: AuditAction.STOCK_COUNT_BLOCKED_LOT_OVERRIDE,
            entityType: "Lot",
            entityId: lot.id,
            before: { status: lot.status, quantityRemaining: previousQty },
            after: {
              quantityRemaining: targetQty,
              countId,
              lineId: line.id,
              reasonCode,
              overrideReason,
            },
            ipAddress: options.ipAddress ?? null,
          },
          { tx },
        );
      }

      lot.quantityRemaining = targetQty;
      lot.status = nextStatus;

      applied.push({
        lineId: line.id,
        lotId: lot.id,
        productId: lot.productId,
        expectedQuantity: line.expectedQuantity,
        soldDuringCount: sold.get(line.id) ?? 0,
        movementDuringCount: line.movementDuringCount,
        finalCountedQuantity: line.recountedQuantity ?? line.countedQuantity,
        variance,
        varianceValue: line.varianceValue?.toFixed(2) ?? null,
        appliedDelta: delta,
        reasonCode,
        ...(unclamped < 0 ? { clampedFrom: unclamped } : {}),
        ...(isBlocked ? { blockedLotOverride: true } : {}),
      });
    }

    await writeAuditLog(
      {
        userId: actor.id,
        storeId: count.storeId,
        action: AuditAction.STOCK_COUNT_APPROVE,
        entityType: "StockCount",
        entityId: countId,
        before: { status: StockCountStatus.COMPLETED, approvedAt: null },
        after: {
          approvedAt: approvedAt.toISOString(),
          lineCount: lines.length,
          adjustedLines: applied,
        },
        ipAddress: options.ipAddress ?? null,
      },
      { tx },
    );

    const approved = await tx.stockCount.findUniqueOrThrow({ where: { id: countId } });
    return buildReview(tx, approved);
  });
}
