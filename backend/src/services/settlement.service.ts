/**
 * Settlement / operator payout reconciliation for Harvestlink.
 *
 * SOURCE OF TRUTH FOR OPERATOR PAYABLES
 * -------------------------------------
 * "How much does the co-op currently owe each store operator?" is answered here —
 * not by the POS UI, not by a spreadsheet, and not by recalculating operatorPercent
 * from today's Store settings.
 *
 * Reconciliation (per store) — NET of refunds:
 *   grossSales       = Σ (Sale.total - Sale.refundedAmount)
 *                      WHERE paymentStatus IN (PAID, REFUNDING, REFUNDED)
 *   operatorAccrued  = Σ (Sale.operatorAmount - Sale.refundedOperatorAmount)
 *                      WHERE paymentStatus IN (PAID, REFUNDING, REFUNDED)
 *   totalPaidOut     = Σ Payout.amount
 *   currentlyOwed    = operatorAccrued - totalPaidOut
 *
 * ACCOUNTING (why netting matters):
 * - Full card capture still lands in the co-op Stripe account; operatorAmount is an
 *   INTERNAL accrual only. When we refund the customer, we must claw back the same
 *   proportion of operatorAmount (refundedOperatorAmount) or the co-op overpays the
 *   operator on goods that are no longer sold.
 * - Partial refunds leave paymentStatus = PAID with refunded* > 0 — excluding only
 *   REFUNDED rows would still overpay on those partials. Netting both columns fixes
 *   full and partial refunds in one formula.
 * - REFUNDING rows are included at pre-finalize balances (refunded* not yet bumped).
 *   That short window prefers not underpaying; finalize then nets the clawback.
 * - Fully REFUNDED sales net to ~0 and stay in the aggregate so history is visible
 *   without special-casing status.
 *
 * Why correctness beats speed:
 * - These aggregates decide real cash leaving the co-op account.
 * - Accrual MUST use Sale.operatorAmount snapshots so a later change to
 *   Store.operatorPercent cannot rewrite historical payables.
 * - We re-aggregate from Sale + Payout on each read instead of caching a running
 *   balance that could drift after a failed write or a manual DB fix.
 *
 * Payouts above currentlyOwed are rejected for STORE_ADMIN. COOP_ADMIN may override
 * for edge cases (goodwill, correction) but that override is logged for audit.
 */
import { Prisma, Role, type Payout } from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

export type StoreSettlementSummary = {
  storeId: string;
  storeName: string;
  grossSales: string;
  operatorAccrued: string;
  totalPaidOut: string;
  currentlyOwed: string;
};

export type NetworkSettlementSummary = {
  storeCount: number;
  grossSales: string;
  operatorAccrued: string;
  totalPaidOut: string;
  currentlyOwed: string;
  stores: StoreSettlementSummary[];
};

export type CreatePayoutInput = {
  amount: number;
  note?: string | null;
  ipAddress?: string | null;
};

/**
 * STORE_ADMIN may only settle their own store; COOP_ADMIN may settle any store.
 * Cashiers have no settlement access — they ring sales, they do not move payout money.
 */
export function assertSettlementAccess(actor: AuthUser, storeId: string): void {
  if (actor.role === Role.COOP_ADMIN) {
    return;
  }

  if (actor.role === Role.STORE_ADMIN) {
    if (!actor.storeId || actor.storeId !== storeId) {
      throw new AppError(403, "STORE_ADMIN can only access settlement for their own store");
    }
    return;
  }

  throw new AppError(403, "Insufficient role for settlement");
}

function decimalToMoneyString(value: Prisma.Decimal): string {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * Builds the payable summary for one store by aggregating sales + payouts.
 * Prefer this fresh aggregate over any cached balance — it is the reconciliation
 * source of truth for what the co-op owes the operator right now.
 */
export async function getStoreSettlementSummary(storeId: string): Promise<StoreSettlementSummary> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new AppError(404, "Store not found");
  }

  // Net in SQL so partial refunds (PAID + refundedOperatorAmount > 0) reduce currentlyOwed.
  const [salesAgg, payoutsAgg] = await Promise.all([
    prisma.$queryRaw<Array<{ gross: Prisma.Decimal; accrued: Prisma.Decimal }>>`
      SELECT
        COALESCE(SUM(total - "refundedAmount"), 0) AS gross,
        COALESCE(SUM("operatorAmount" - "refundedOperatorAmount"), 0) AS accrued
      FROM "Sale"
      WHERE "storeId" = ${storeId}
        AND "paymentStatus"::text IN ('PAID', 'REFUNDING', 'REFUNDED')
    `,
    prisma.payout.aggregate({
      where: { storeId },
      _sum: {
        amount: true,
      },
    }),
  ]);

  const grossSales = new Prisma.Decimal(salesAgg[0]?.gross ?? 0);
  const operatorAccrued = new Prisma.Decimal(salesAgg[0]?.accrued ?? 0);
  const totalPaidOut = new Prisma.Decimal(payoutsAgg._sum.amount ?? 0);
  // currentlyOwed can theoretically go negative if an admin over-paid; surface that honestly.
  const currentlyOwed = operatorAccrued.sub(totalPaidOut);

  return {
    storeId: store.id,
    storeName: store.name,
    grossSales: decimalToMoneyString(grossSales),
    operatorAccrued: decimalToMoneyString(operatorAccrued),
    totalPaidOut: decimalToMoneyString(totalPaidOut),
    currentlyOwed: decimalToMoneyString(currentlyOwed),
  };
}

/**
 * Records a payout from the co-op account to the store operator.
 *
 * Guardrail: amount must be <= currentlyOwed for STORE_ADMIN so we never silently
 * overpay from a store console. COOP_ADMIN may exceed currentlyOwed (corrections /
 * goodwill) — we allow it but log the override because it breaks the simple
 * accrued - paid identity until future accruals catch up.
 */
export async function createPayout(
  storeId: string,
  actor: AuthUser,
  input: CreatePayoutInput,
): Promise<{ payout: Payout; summary: StoreSettlementSummary; adminOverride: boolean }> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new AppError(400, "amount must be a positive number");
  }

  const amount = new Prisma.Decimal(input.amount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  if (amount.lte(0)) {
    throw new AppError(400, "amount must be a positive number");
  }

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new AppError(404, "Store not found");
  }

  // Recompute owed inside the decision path so we do not trust a client-sent balance.
  const summaryBefore = await getStoreSettlementSummary(storeId);
  const currentlyOwed = new Prisma.Decimal(summaryBefore.currentlyOwed);

  let adminOverride = false;
  if (amount.gt(currentlyOwed)) {
    if (actor.role !== Role.COOP_ADMIN) {
      throw new AppError(400, "Payout amount exceeds currently owed", {
        amount: decimalToMoneyString(amount),
        currentlyOwed: summaryBefore.currentlyOwed,
      });
    }

    adminOverride = true;
    // Audit trail for finance: over-accrual payouts need a human review trail.
    console.warn(
      JSON.stringify({
        type: "SETTLEMENT_PAYOUT_OVERRIDE",
        message: "COOP_ADMIN recorded a payout greater than currentlyOwed",
        storeId,
        paidByUserId: actor.id,
        amount: decimalToMoneyString(amount),
        currentlyOwed: summaryBefore.currentlyOwed,
        note: input.note ?? null,
        at: new Date().toISOString(),
      }),
    );
  }

  const payout = await prisma.payout.create({
    data: {
      storeId,
      amount,
      note: input.note?.trim() ? input.note.trim() : null,
      paidByUserId: actor.id,
    },
  });

  // Return post-payout summary so the UI refreshes from the same source of truth.
  const summary = await getStoreSettlementSummary(storeId);

  await writeAuditLog({
    userId: actor.id,
    storeId,
    action: AuditAction.PAYOUT_CREATE,
    entityType: "Payout",
    entityId: payout.id,
    before: {
      currentlyOwed: summaryBefore.currentlyOwed,
    },
    after: {
      amount: decimalToMoneyString(amount),
      note: payout.note,
      adminOverride,
      currentlyOwedAfter: summary.currentlyOwed,
    },
    ipAddress: input.ipAddress ?? null,
  });

  return { payout, summary, adminOverride };
}

/**
 * Payout history for a store (newest first). Paginated for long-running operators.
 */
export async function listPayouts(
  storeId: string,
  page: number,
  pageSize: number,
): Promise<{
  payouts: Payout[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new AppError(404, "Store not found");
  }

  const where = { storeId };
  const skip = (page - 1) * pageSize;

  const [total, payouts] = await prisma.$transaction([
    prisma.payout.count({ where }),
    prisma.payout.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
    }),
  ]);

  return {
    payouts,
    page,
    pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

/**
 * Network-wide settlement rollup (COOP_ADMIN only at the route layer).
 * This is the view that matters once Harvestlink expands past a single pilot store:
 * one screen for total operator payables across the co-op.
 *
 * Built by summarizing each store with the same reconciliation formula, then summing —
 * so per-store and network numbers cannot disagree by construction.
 */
export async function getNetworkSettlementSummary(): Promise<NetworkSettlementSummary> {
  const stores = await prisma.store.findMany({
    orderBy: { name: "asc" },
    select: { id: true },
  });

  const storeSummaries: StoreSettlementSummary[] = [];
  for (const store of stores) {
    storeSummaries.push(await getStoreSettlementSummary(store.id));
  }

  let grossSales = new Prisma.Decimal(0);
  let operatorAccrued = new Prisma.Decimal(0);
  let totalPaidOut = new Prisma.Decimal(0);
  let currentlyOwed = new Prisma.Decimal(0);

  for (const summary of storeSummaries) {
    grossSales = grossSales.add(summary.grossSales);
    operatorAccrued = operatorAccrued.add(summary.operatorAccrued);
    totalPaidOut = totalPaidOut.add(summary.totalPaidOut);
    currentlyOwed = currentlyOwed.add(summary.currentlyOwed);
  }

  return {
    storeCount: storeSummaries.length,
    grossSales: decimalToMoneyString(grossSales),
    operatorAccrued: decimalToMoneyString(operatorAccrued),
    totalPaidOut: decimalToMoneyString(totalPaidOut),
    currentlyOwed: decimalToMoneyString(currentlyOwed),
    stores: storeSummaries,
  };
}
