/**
 * Daily close (Z-report) for Harvestlink store operators.
 * Summarizes a UTC calendar day: tenders, tax, refunds, operator accrual, cash variance, cashiers.
 */
import { PaymentStatus, Prisma, Role } from "@prisma/client";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

function money(value: Prisma.Decimal | number): string {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}

function utcDayBounds(dateStr: string): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new AppError(400, "date must be YYYY-MM-DD");
  }
  const from = new Date(`${dateStr}T00:00:00.000Z`);
  const to = new Date(`${dateStr}T23:59:59.999Z`);
  if (Number.isNaN(from.getTime())) {
    throw new AppError(400, "Invalid date");
  }
  return { from, to };
}

export type DailyCloseReport = {
  storeId: string;
  storeName: string;
  date: string;
  salesByPaymentMethod: Record<string, string>;
  taxCollected: string;
  refundsTotal: string;
  operatorShareAccrued: string;
  cashVariance: string | null;
  cashierBreakdown: Array<{
    cashierId: string;
    email: string;
    saleCount: number;
    grossSales: string;
    operatorShare: string;
  }>;
  /** Shifts closed on this date, plus patterns over the trailing window ending on it. */
  drawerVariance: {
    windowFrom: string;
    windowTo: string;
    threshold: string;
    shifts: VarianceShift[];
    patterns: VariancePattern[];
  };
};

export type VarianceDirection = "SHORT" | "OVER" | "BALANCED";

export type VarianceShift = {
  drawerId: string;
  storeId: string;
  storeName: string;
  /** Who opened the drawer — the person running the till for this shift. */
  userId: string;
  userEmail: string;
  closedByEmail: string | null;
  openedAt: Date;
  closedAt: Date;
  expectedCash: string;
  countedCash: string;
  variance: string;
  direction: VarianceDirection;
  overThreshold: boolean;
};

export type VarianceAggregate = {
  shiftCount: number;
  totalVariance: string;
  averageVariance: string;
  /** Sum of shortfalls (≤ 0). Reported separately so shorts and overs cannot cancel out. */
  shortTotal: string;
  /** Sum of overages (≥ 0). */
  overTotal: string;
  shortCount: number;
  overCount: number;
  overThresholdCount: number;
};

/**
 * A run of consecutive same-direction variances by one user. Surfaced for a human to review —
 * never a conclusion. Consistent overages matter as much as shortfalls: an overage usually means
 * sales are not being rung up correctly, which is a bigger accounting problem than a shortfall.
 */
export type VariancePattern = {
  userId: string;
  userEmail: string;
  direction: Exclude<VarianceDirection, "BALANCED">;
  shiftCount: number;
  totalVariance: string;
  firstClosedAt: Date;
  lastClosedAt: Date;
  /** True when the run includes this user's most recent shift in the window. */
  ongoing: boolean;
  drawerIds: string[];
};

export type DrawerVarianceReport = {
  storeId: string | null;
  from: string;
  to: string;
  threshold: string;
  tolerance: string;
  minStreak: number;
  totals: VarianceAggregate;
  byShift: VarianceShift[];
  byUser: Array<VarianceAggregate & { userId: string; userEmail: string }>;
  byStore: Array<VarianceAggregate & { storeId: string; storeName: string }>;
  patterns: VariancePattern[];
};

export type DrawerVarianceQuery = {
  storeId?: string;
  from?: string;
  to?: string;
  /** |variance| above this counts toward overThresholdCount. Default $5.00. */
  threshold?: number;
  /** |variance| at or below this is BALANCED and breaks a pattern run. Default $1.00. */
  tolerance?: number;
  /** Consecutive same-direction shifts needed to surface a pattern. Default 3. */
  minStreak?: number;
};

const DEFAULT_VARIANCE_THRESHOLD = 5;
const DEFAULT_VARIANCE_TOLERANCE = 1;
const DEFAULT_MIN_STREAK = 3;
const DEFAULT_VARIANCE_WINDOW_DAYS = 30;
const MAX_VARIANCE_WINDOW_DAYS = 366;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function getDailyCloseReport(
  storeId: string,
  dateStr: string,
  actor: AuthUser,
): Promise<DailyCloseReport> {
  if (actor.role === Role.CASHIER) {
    throw new AppError(403, "Cashiers cannot view the daily close report");
  }
  if (actor.role === Role.STORE_ADMIN && actor.storeId !== storeId) {
    throw new AppError(403, "Cannot view another store's daily close");
  }

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new AppError(404, "Store not found");
  }

  const { from, to } = utcDayBounds(dateStr);

  const sales = await prisma.sale.findMany({
    where: {
      storeId,
      paymentStatus: {
        in: [PaymentStatus.PAID, PaymentStatus.REFUNDED, PaymentStatus.REFUNDING],
      },
      OR: [
        { paidAt: { gte: from, lte: to } },
        { paidAt: null, createdAt: { gte: from, lte: to } },
      ],
    },
    include: {
      cashier: { select: { id: true, email: true } },
    },
  });

  const byMethod: Record<string, Prisma.Decimal> = {
    CASH: new Prisma.Decimal(0),
    TERMINAL: new Prisma.Decimal(0),
    CHECKOUT: new Prisma.Decimal(0),
  };
  let taxCollected = new Prisma.Decimal(0);
  let refundsTotal = new Prisma.Decimal(0);
  let operatorShare = new Prisma.Decimal(0);

  type CashierAgg = {
    email: string;
    saleCount: number;
    gross: Prisma.Decimal;
    operator: Prisma.Decimal;
  };
  const byCashier = new Map<string, CashierAgg>();

  for (const sale of sales) {
    const netTotal = sale.total.sub(sale.refundedAmount);
    const netOp = sale.operatorAmount.sub(sale.refundedOperatorAmount);
    const method = sale.paymentMethod ?? "UNKNOWN";
    byMethod[method] = (byMethod[method] ?? new Prisma.Decimal(0)).add(netTotal);

    // Tax collected net of refunds (proportional to remaining share of total).
    const taxShare =
      sale.total.eq(0) || sale.refundedAmount.eq(0)
        ? sale.taxAmount
        : sale.taxAmount.mul(netTotal).div(sale.total);
    taxCollected = taxCollected.add(taxShare);
    refundsTotal = refundsTotal.add(sale.refundedAmount);
    operatorShare = operatorShare.add(netOp);

    const row = byCashier.get(sale.cashierId) ?? {
      email: sale.cashier.email,
      saleCount: 0,
      gross: new Prisma.Decimal(0),
      operator: new Prisma.Decimal(0),
    };
    row.saleCount += 1;
    row.gross = row.gross.add(netTotal);
    row.operator = row.operator.add(netOp);
    byCashier.set(sale.cashierId, row);
  }

  const drawers = await prisma.cashDrawer.findMany({
    where: {
      storeId,
      closedAt: { gte: from, lte: to },
    },
    orderBy: { closedAt: "desc" },
  });
  const cashVariance =
    drawers.length === 0
      ? null
      : money(drawers.reduce((sum, d) => sum.add(d.variance ?? 0), new Prisma.Decimal(0)));

  return {
    storeId: store.id,
    storeName: store.name,
    date: dateStr,
    salesByPaymentMethod: {
      CASH: money(byMethod.CASH ?? 0),
      TERMINAL: money(byMethod.TERMINAL ?? 0),
      CHECKOUT: money(byMethod.CHECKOUT ?? 0),
    },
    taxCollected: money(taxCollected),
    refundsTotal: money(refundsTotal),
    operatorShareAccrued: money(operatorShare),
    cashVariance,
    cashierBreakdown: [...byCashier.entries()].map(([cashierId, row]) => ({
      cashierId,
      email: row.email,
      saleCount: row.saleCount,
      grossSales: money(row.gross),
      operatorShare: money(row.operator),
    })),
    drawerVariance: await dailyCloseDrawerVariance(storeId, dateStr, from, to, actor),
  };
}

async function dailyCloseDrawerVariance(
  storeId: string,
  dateStr: string,
  dayFrom: Date,
  dayTo: Date,
  actor: AuthUser,
): Promise<DailyCloseReport["drawerVariance"]> {
  const windowFrom = shiftDate(dateStr, -(DEFAULT_VARIANCE_WINDOW_DAYS - 1));
  const report = await getDrawerVarianceReport(actor, { storeId, from: windowFrom, to: dateStr });
  return {
    windowFrom: report.from,
    windowTo: report.to,
    threshold: report.threshold,
    shifts: report.byShift.filter((s) => s.closedAt >= dayFrom && s.closedAt <= dayTo),
    patterns: report.patterns,
  };
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  return new Date(d.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function varianceDirection(variance: Prisma.Decimal, tolerance: Prisma.Decimal): VarianceDirection {
  if (variance.abs().lte(tolerance)) return "BALANCED";
  return variance.lt(0) ? "SHORT" : "OVER";
}

function aggregateVariance(shifts: VarianceShift[]): VarianceAggregate {
  let total = new Prisma.Decimal(0);
  let shortTotal = new Prisma.Decimal(0);
  let overTotal = new Prisma.Decimal(0);
  let shortCount = 0;
  let overCount = 0;
  let overThresholdCount = 0;

  for (const shift of shifts) {
    const v = new Prisma.Decimal(shift.variance);
    total = total.add(v);
    if (v.lt(0)) shortTotal = shortTotal.add(v);
    if (v.gt(0)) overTotal = overTotal.add(v);
    if (shift.direction === "SHORT") shortCount += 1;
    if (shift.direction === "OVER") overCount += 1;
    if (shift.overThreshold) overThresholdCount += 1;
  }

  return {
    shiftCount: shifts.length,
    totalVariance: money(total),
    averageVariance: money(shifts.length === 0 ? 0 : total.div(shifts.length)),
    shortTotal: money(shortTotal),
    overTotal: money(overTotal),
    shortCount,
    overCount,
    overThresholdCount,
  };
}

/**
 * Finds runs of at least `minStreak` consecutive same-direction shifts per user.
 * BALANCED shifts (within tolerance) break a run.
 */
export function detectVariancePatterns(
  shifts: VarianceShift[],
  minStreak: number,
): VariancePattern[] {
  const byUser = new Map<string, VarianceShift[]>();
  for (const shift of shifts) {
    const list = byUser.get(shift.userId) ?? [];
    list.push(shift);
    byUser.set(shift.userId, list);
  }

  const patterns: VariancePattern[] = [];
  for (const userShifts of byUser.values()) {
    const ordered = [...userShifts].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
    let run: VarianceShift[] = [];

    const flush = (isLast: boolean) => {
      const first = run[0];
      const last = run[run.length - 1];
      if (first && last && run.length >= minStreak && first.direction !== "BALANCED") {
        patterns.push({
          userId: first.userId,
          userEmail: first.userEmail,
          direction: first.direction,
          shiftCount: run.length,
          totalVariance: money(
            run.reduce((sum, s) => sum.add(s.variance), new Prisma.Decimal(0)),
          ),
          firstClosedAt: first.closedAt,
          lastClosedAt: last.closedAt,
          ongoing: isLast,
          drawerIds: run.map((s) => s.drawerId),
        });
      }
      run = [];
    };

    for (const shift of ordered) {
      if (shift.direction === "BALANCED") {
        flush(false);
        continue;
      }
      if (run.length > 0 && run[0]!.direction !== shift.direction) {
        flush(false);
      }
      run.push(shift);
    }
    flush(true);
  }

  return patterns.sort(
    (a, b) =>
      Number(b.ongoing) - Number(a.ongoing) ||
      b.shiftCount - a.shiftCount ||
      b.lastClosedAt.getTime() - a.lastClosedAt.getTime(),
  );
}

function parseReportDate(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(400, `${field} must be YYYY-MM-DD`);
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new AppError(400, `Invalid ${field}`);
  }
  return d;
}

function nonNegative(value: number | undefined, fallback: number, field: string): Prisma.Decimal {
  const n = value ?? fallback;
  if (!Number.isFinite(n) || n < 0) {
    throw new AppError(400, `${field} must be a non-negative number`);
  }
  return new Prisma.Decimal(n).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Drawer variance by shift, user and store over a UTC date range, with repeated same-direction
 * runs by one user surfaced as patterns. Read-only: it never writes audit rows or touches accounts —
 * a pattern is a prompt for a human to look, not a finding.
 */
export async function getDrawerVarianceReport(
  actor: AuthUser,
  query: DrawerVarianceQuery,
): Promise<DrawerVarianceReport> {
  let storeId: string | null;
  if (actor.role === Role.COOP_ADMIN) {
    storeId = query.storeId ?? null;
  } else if (actor.role === Role.STORE_ADMIN) {
    if (!actor.storeId) {
      throw new AppError(403, "User is not assigned to a store");
    }
    if (query.storeId && query.storeId !== actor.storeId) {
      throw new AppError(403, "Cannot view another store's drawer variance");
    }
    storeId = actor.storeId;
  } else {
    throw new AppError(403, "Insufficient role for drawer variance");
  }

  const toStr = query.to ?? new Date().toISOString().slice(0, 10);
  const fromStr = query.from ?? shiftDate(toStr, -(DEFAULT_VARIANCE_WINDOW_DAYS - 1));
  const from = parseReportDate(fromStr, "from");
  const toStart = parseReportDate(toStr, "to");
  if (from > toStart) {
    throw new AppError(400, "from must be on or before to");
  }
  if ((toStart.getTime() - from.getTime()) / MS_PER_DAY >= MAX_VARIANCE_WINDOW_DAYS) {
    throw new AppError(400, `Date range cannot exceed ${MAX_VARIANCE_WINDOW_DAYS} days`);
  }
  const to = new Date(toStart.getTime() + MS_PER_DAY - 1);

  const threshold = nonNegative(query.threshold, DEFAULT_VARIANCE_THRESHOLD, "threshold");
  const tolerance = nonNegative(query.tolerance, DEFAULT_VARIANCE_TOLERANCE, "tolerance");
  const minStreak = query.minStreak ?? DEFAULT_MIN_STREAK;
  if (!Number.isInteger(minStreak) || minStreak < 2) {
    throw new AppError(400, "minStreak must be a whole number of at least 2");
  }

  if (storeId) {
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) {
      throw new AppError(404, "Store not found");
    }
  }

  const drawers = await prisma.cashDrawer.findMany({
    where: {
      ...(storeId ? { storeId } : {}),
      closedAt: { gte: from, lte: to },
      variance: { not: null },
    },
    orderBy: [{ closedAt: "desc" }, { id: "asc" }],
    include: {
      store: { select: { name: true } },
      openedBy: { select: { email: true } },
      closedBy: { select: { email: true } },
    },
  });

  const byShift: VarianceShift[] = drawers.map((d) => {
    const variance = d.variance!;
    return {
      drawerId: d.id,
      storeId: d.storeId,
      storeName: d.store.name,
      userId: d.openedByUserId,
      userEmail: d.openedBy.email,
      closedByEmail: d.closedBy?.email ?? null,
      openedAt: d.openedAt,
      closedAt: d.closedAt!,
      expectedCash: money(d.expectedCash),
      countedCash: money(d.countedCash ?? 0),
      variance: money(variance),
      direction: varianceDirection(variance, tolerance),
      overThreshold: variance.abs().gt(threshold),
    };
  });

  const groupBy = <K extends string>(key: (s: VarianceShift) => K) => {
    const groups = new Map<K, VarianceShift[]>();
    for (const shift of byShift) {
      const k = key(shift);
      groups.set(k, [...(groups.get(k) ?? []), shift]);
    }
    return groups;
  };

  const byUser = [...groupBy((s) => s.userId).values()]
    .map((shifts) => ({
      userId: shifts[0]!.userId,
      userEmail: shifts[0]!.userEmail,
      ...aggregateVariance(shifts),
    }))
    .sort((a, b) => b.overThresholdCount - a.overThresholdCount || b.shiftCount - a.shiftCount);

  const byStore = [...groupBy((s) => s.storeId).values()]
    .map((shifts) => ({
      storeId: shifts[0]!.storeId,
      storeName: shifts[0]!.storeName,
      ...aggregateVariance(shifts),
    }))
    .sort((a, b) => a.storeName.localeCompare(b.storeName));

  return {
    storeId,
    from: fromStr,
    to: toStr,
    threshold: threshold.toFixed(2),
    tolerance: tolerance.toFixed(2),
    minStreak,
    totals: aggregateVariance(byShift),
    byShift,
    byUser,
    byStore,
    patterns: detectVariancePatterns(byShift, minStreak),
  };
}
