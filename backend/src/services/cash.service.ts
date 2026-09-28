/**
 * Cash banking records — tracks till cash from closed drawer shifts to the bank.
 *
 * An operator RECORDS a deposit; a co-op admin CONFIRMS it against the bank statement. Only
 * CONFIRMED deposits count as banked, and only at the bank's figure (confirmedAmount), never the
 * operator's claim (amount). Always trust the bank record over the operator's claim.
 *
 * Bankable cash per shift = countedCash − openingFloat (the float stays in the till).
 *
 * Coverage is derived on every read, never stored: CONFIRMED deposits are applied in confirmation
 * order, and each one's confirmedAmount is spread across its linked shifts oldest-first, capped at
 * what each shift still has uncovered. Disputing a deposit therefore releases its coverage with
 * nothing to unwind.
 *
 * Deposits are never deleted — dispute and record a corrected deposit instead.
 */
import {
  CashDepositStatus,
  Prisma,
  Role,
  type CashDeposit,
  type CashDrawer,
  type User,
} from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type RecordDepositOptions = {
  depositedAt?: Date;
  depositSlipUrl?: string | null;
  notes?: string | null;
  ipAddress?: string | null;
};

export type ConfirmDepositResult = {
  deposit: CashDeposit;
  /** confirmedAmount − amount. Negative means the bank received less than the operator claimed. */
  discrepancy: string;
  hasDiscrepancy: boolean;
};

export type UndepositedDrawer = {
  drawerId: string;
  closedAt: Date;
  bankableCash: string;
  coveredByConfirmedDeposits: string;
  undeposited: string;
  ageDays: number;
};

export type UndepositedCashSummary = {
  storeId: string;
  totalUndeposited: string;
  /** Age in whole days of the oldest shift with undeposited cash; null when everything is banked. */
  oldestAgeDays: number | null;
  drawers: UndepositedDrawer[];
};

type DrawerForAllocation = { id: string; closedAt: Date; bankable: Prisma.Decimal };
type ConfirmedDepositForAllocation = { confirmedAmount: Prisma.Decimal; drawerIds: string[] };

function money(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function moneyString(value: Prisma.Decimal): string {
  return money(value).toFixed(2);
}

function minDecimal(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return a.lt(b) ? a : b;
}

function bankableCash(drawer: Pick<CashDrawer, "countedCash" | "openingFloat">): Prisma.Decimal {
  if (drawer.countedCash === null) {
    return money(0);
  }
  const net = drawer.countedCash.sub(drawer.openingFloat);
  return money(net.lt(0) ? 0 : net);
}

/**
 * Spreads confirmed deposits across their linked shifts and returns the amount covered per shift.
 * `deposits` must already be in confirmation order.
 */
export function allocateConfirmedDeposits(
  drawers: DrawerForAllocation[],
  deposits: ConfirmedDepositForAllocation[],
): Map<string, Prisma.Decimal> {
  const byId = new Map(drawers.map((d) => [d.id, d]));
  const covered = new Map(drawers.map((d) => [d.id, new Prisma.Decimal(0)]));

  for (const deposit of deposits) {
    let left = money(deposit.confirmedAmount);
    const linked = deposit.drawerIds
      .map((id) => byId.get(id))
      .filter((d): d is DrawerForAllocation => d !== undefined)
      .sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime() || a.id.localeCompare(b.id));

    for (const drawer of linked) {
      if (left.lte(0)) break;
      const already = covered.get(drawer.id)!;
      const remaining = drawer.bankable.sub(already);
      if (remaining.lte(0)) continue;
      const take = minDecimal(left, remaining);
      covered.set(drawer.id, already.add(take));
      left = left.sub(take);
    }
  }

  return covered;
}

async function loadDrawerCoverage(
  db: DbClient,
  storeId: string,
): Promise<Array<DrawerForAllocation & { covered: Prisma.Decimal; uncovered: Prisma.Decimal }>> {
  const [drawers, deposits] = await Promise.all([
    db.cashDrawer.findMany({
      where: { storeId, closedAt: { not: null } },
      orderBy: [{ closedAt: "asc" }, { id: "asc" }],
    }),
    db.cashDeposit.findMany({
      where: { storeId, status: CashDepositStatus.CONFIRMED },
      orderBy: [{ confirmedAt: "asc" }, { id: "asc" }],
      include: { drawers: { select: { cashDrawerId: true } } },
    }),
  ]);

  const forAllocation: DrawerForAllocation[] = drawers.map((d) => ({
    id: d.id,
    closedAt: d.closedAt!,
    bankable: bankableCash(d),
  }));

  const covered = allocateConfirmedDeposits(
    forAllocation,
    deposits.map((dep) => ({
      confirmedAmount: dep.confirmedAmount ?? new Prisma.Decimal(0),
      drawerIds: dep.drawers.map((link) => link.cashDrawerId),
    })),
  );

  return forAllocation.map((d) => {
    const c = covered.get(d.id) ?? new Prisma.Decimal(0);
    return { ...d, covered: c, uncovered: d.bankable.sub(c) };
  });
}

async function loadActor(db: DbClient, actorUserId: string): Promise<User> {
  const actor = await db.user.findUnique({ where: { id: actorUserId } });
  if (!actor) {
    throw new AppError(403, "Unknown user");
  }
  return actor;
}

function assertCanRecordForStore(actor: User, storeId: string): void {
  if (actor.role === Role.COOP_ADMIN) return;
  if (actor.role === Role.STORE_ADMIN && actor.storeId === storeId) return;
  throw new AppError(403, "Only this store's STORE_ADMIN or a COOP_ADMIN may record deposits");
}

function parsePositiveAmount(value: number, field: string): Prisma.Decimal {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError(400, `${field} must be a positive number`);
  }
  const amount = money(value);
  if (amount.lte(0)) {
    throw new AppError(400, `${field} must be a positive number`);
  }
  return amount;
}

/**
 * Records that an operator took cash from the listed closed shifts to the bank.
 * A RECORDED deposit is only a claim — it covers nothing until a co-op admin confirms it.
 */
export async function recordDeposit(
  storeId: string,
  amount: number,
  drawerIds: string[],
  actorUserId: string,
  options: RecordDepositOptions = {},
): Promise<CashDeposit> {
  const recordedAmount = parsePositiveAmount(amount, "amount");
  const ids = [...new Set(drawerIds)];
  if (ids.length === 0) {
    throw new AppError(400, "A deposit must cover at least one closed cash drawer");
  }
  const depositedAt = options.depositedAt ?? new Date();
  if (depositedAt.getTime() > Date.now()) {
    throw new AppError(400, "depositedAt cannot be in the future");
  }

  return prisma.$transaction(async (tx) => {
    const actor = await loadActor(tx, actorUserId);
    assertCanRecordForStore(actor, storeId);

    const store = await tx.store.findUnique({ where: { id: storeId } });
    if (!store) {
      throw new AppError(404, "Store not found");
    }

    const drawers = await tx.cashDrawer.findMany({ where: { id: { in: ids } } });
    const found = new Set(drawers.map((d) => d.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new AppError(404, "Cash drawer not found", { drawerIds: missing });
    }
    const otherStore = drawers.filter((d) => d.storeId !== storeId).map((d) => d.id);
    if (otherStore.length > 0) {
      throw new AppError(400, "Cash drawers belong to another store", { drawerIds: otherStore });
    }
    const stillOpen = drawers.filter((d) => d.closedAt === null).map((d) => d.id);
    if (stillOpen.length > 0) {
      throw new AppError(409, "Only closed cash drawers can be deposited", { drawerIds: stillOpen });
    }

    const coverage = await loadDrawerCoverage(tx, storeId);
    const fullyCovered = coverage
      .filter((d) => found.has(d.id) && d.uncovered.lte(0))
      .map((d) => d.id);
    if (fullyCovered.length > 0) {
      throw new AppError(409, "Cash drawers are already fully covered by confirmed deposits", {
        drawerIds: fullyCovered,
      });
    }

    const deposit = await tx.cashDeposit.create({
      data: {
        storeId,
        depositedByUserId: actor.id,
        amount: recordedAmount,
        depositedAt,
        depositSlipUrl: options.depositSlipUrl?.trim() || null,
        notes: options.notes?.trim() || null,
        drawers: { create: ids.map((cashDrawerId) => ({ cashDrawerId })) },
      },
    });

    await writeAuditLog(
      {
        userId: actor.id,
        storeId,
        action: AuditAction.CASH_DEPOSIT_RECORD,
        entityType: "CashDeposit",
        entityId: deposit.id,
        after: {
          status: deposit.status,
          amount: moneyString(recordedAmount),
          depositedAt: depositedAt.toISOString(),
          drawerIds: ids,
        },
        ipAddress: options.ipAddress ?? null,
      },
      { tx },
    );

    return deposit;
  });
}

/**
 * Confirms a RECORDED deposit against the bank statement at the amount the bank ACTUALLY shows.
 * Any difference from the operator's recorded amount is returned, audited, and logged for review;
 * coverage always uses the bank's figure.
 */
export async function confirmDeposit(
  depositId: string,
  bankReference: string,
  actualAmount: number,
  actorUserId: string,
  options: { ipAddress?: string | null } = {},
): Promise<ConfirmDepositResult> {
  const reference = bankReference?.trim();
  if (!reference) {
    throw new AppError(400, "bankReference is required to confirm a deposit");
  }
  const confirmedAmount = parsePositiveAmount(actualAmount, "actualAmount");

  const result = await prisma.$transaction(async (tx) => {
    const actor = await loadActor(tx, actorUserId);
    if (actor.role !== Role.COOP_ADMIN) {
      throw new AppError(403, "Only COOP_ADMIN may confirm deposits");
    }

    const existing = await tx.cashDeposit.findUnique({ where: { id: depositId } });
    if (!existing) {
      throw new AppError(404, "Deposit not found");
    }
    if (existing.status !== CashDepositStatus.RECORDED) {
      throw new AppError(409, `Only RECORDED deposits can be confirmed (status is ${existing.status})`);
    }

    // Guarded on status so two admins confirming at once cannot both succeed.
    const claimed = await tx.cashDeposit.updateMany({
      where: { id: depositId, status: CashDepositStatus.RECORDED },
      data: {
        status: CashDepositStatus.CONFIRMED,
        bankReference: reference,
        confirmedAmount,
        confirmedByUserId: actor.id,
        confirmedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new AppError(409, "Deposit was changed by another user; reload and retry");
    }

    const deposit = await tx.cashDeposit.findUniqueOrThrow({ where: { id: depositId } });
    const discrepancy = money(confirmedAmount.sub(existing.amount));

    await writeAuditLog(
      {
        userId: actor.id,
        storeId: deposit.storeId,
        action: AuditAction.CASH_DEPOSIT_CONFIRM,
        entityType: "CashDeposit",
        entityId: deposit.id,
        before: { status: existing.status, amount: moneyString(existing.amount) },
        after: {
          status: deposit.status,
          bankReference: reference,
          confirmedAmount: moneyString(confirmedAmount),
          discrepancy: moneyString(discrepancy),
        },
        ipAddress: options.ipAddress ?? null,
      },
      { tx },
    );

    return { deposit, discrepancy, actorId: actor.id };
  });

  const hasDiscrepancy = !result.discrepancy.eq(0);
  if (hasDiscrepancy) {
    console.warn(
      JSON.stringify({
        type: "CASH_DEPOSIT_DISCREPANCY",
        message: "Bank-confirmed amount differs from the operator's recorded deposit",
        depositId: result.deposit.id,
        storeId: result.deposit.storeId,
        recordedAmount: moneyString(result.deposit.amount),
        confirmedAmount: moneyString(confirmedAmount),
        discrepancy: moneyString(result.discrepancy),
        confirmedByUserId: result.actorId,
        at: new Date().toISOString(),
      }),
    );
  }

  return {
    deposit: result.deposit,
    discrepancy: moneyString(result.discrepancy),
    hasDiscrepancy,
  };
}

/**
 * Marks a deposit DISPUTED. A disputed deposit covers nothing, so its shifts show as undeposited
 * again until a corrected deposit is recorded and confirmed.
 * STORE_ADMIN may dispute their own store's unconfirmed deposits (e.g. a mis-keyed amount);
 * disputing a CONFIRMED deposit (e.g. a bank reversal) is COOP_ADMIN only.
 */
export async function disputeDeposit(
  depositId: string,
  reason: string,
  actorUserId: string,
  options: { ipAddress?: string | null } = {},
): Promise<CashDeposit> {
  const disputeReason = reason?.trim();
  if (!disputeReason) {
    throw new AppError(400, "A reason is required to dispute a deposit");
  }

  return prisma.$transaction(async (tx) => {
    const actor = await loadActor(tx, actorUserId);
    const existing = await tx.cashDeposit.findUnique({ where: { id: depositId } });
    if (!existing) {
      throw new AppError(404, "Deposit not found");
    }
    if (existing.status === CashDepositStatus.DISPUTED) {
      throw new AppError(409, "Deposit is already disputed");
    }

    const isCoopAdmin = actor.role === Role.COOP_ADMIN;
    const isOwnStoreAdmin =
      actor.role === Role.STORE_ADMIN && actor.storeId === existing.storeId;
    if (!isCoopAdmin && !(isOwnStoreAdmin && existing.status === CashDepositStatus.RECORDED)) {
      throw new AppError(
        403,
        existing.status === CashDepositStatus.CONFIRMED
          ? "Only COOP_ADMIN may dispute a confirmed deposit"
          : "Only this store's STORE_ADMIN or a COOP_ADMIN may dispute this deposit",
      );
    }

    const claimed = await tx.cashDeposit.updateMany({
      where: { id: depositId, status: existing.status },
      data: {
        status: CashDepositStatus.DISPUTED,
        disputedByUserId: actor.id,
        disputedAt: new Date(),
        disputeReason,
      },
    });
    if (claimed.count === 0) {
      throw new AppError(409, "Deposit was changed by another user; reload and retry");
    }

    const deposit = await tx.cashDeposit.findUniqueOrThrow({ where: { id: depositId } });

    await writeAuditLog(
      {
        userId: actor.id,
        storeId: deposit.storeId,
        action: AuditAction.CASH_DEPOSIT_DISPUTE,
        entityType: "CashDeposit",
        entityId: deposit.id,
        before: {
          status: existing.status,
          amount: moneyString(existing.amount),
          confirmedAmount: existing.confirmedAmount ? moneyString(existing.confirmedAmount) : null,
        },
        after: { status: deposit.status, reason: disputeReason },
        ipAddress: options.ipAddress ?? null,
      },
      { tx },
    );

    return deposit;
  });
}

/**
 * Closed shifts whose cash is not yet covered by a CONFIRMED deposit, oldest first.
 * RECORDED deposits do not reduce this figure — only bank-confirmed money counts.
 */
export async function getUndepositedCash(storeId: string): Promise<UndepositedCashSummary> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new AppError(404, "Store not found");
  }

  const now = Date.now();
  const coverage = await loadDrawerCoverage(prisma, storeId);
  const drawers = coverage
    .filter((d) => d.uncovered.gt(0))
    .map((d) => ({
      drawerId: d.id,
      closedAt: d.closedAt,
      bankableCash: moneyString(d.bankable),
      coveredByConfirmedDeposits: moneyString(d.covered),
      undeposited: moneyString(d.uncovered),
      ageDays: Math.floor((now - d.closedAt.getTime()) / MS_PER_DAY),
    }));

  const total = coverage.reduce(
    (sum, d) => (d.uncovered.gt(0) ? sum.add(d.uncovered) : sum),
    new Prisma.Decimal(0),
  );

  return {
    storeId,
    totalUndeposited: moneyString(total),
    oldestAgeDays: drawers.length > 0 ? drawers[0]!.ageDays : null,
    drawers,
  };
}
