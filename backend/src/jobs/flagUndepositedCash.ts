/**
 * Daily job: flag stores whose oldest undeposited cash is past CooperativeSettings.cashDepositGraceDays.
 *
 * Writes one CASH_DEPOSIT_PAST_GRACE audit row per flagged store per UTC day, so the trail shows
 * how long each store stayed past grace. This is a prompt to bank the cash, not an accusation:
 * cash left in a store is a risk to the operator as much as to the co-op.
 */
import cron from "node-cron";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { getNetworkCashPositions } from "../services/cash.service.js";

let started = false;

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function runFlagUndepositedCashOnce(now = new Date()): Promise<{
  flaggedStoreIds: string[];
  alreadyFlaggedToday: string[];
}> {
  const { stores } = await getNetworkCashPositions(now);
  const flaggedStoreIds: string[] = [];
  const alreadyFlaggedToday: string[] = [];

  for (const position of stores) {
    if (!position.pastGrace) {
      continue;
    }

    try {
      const existing = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.CASH_DEPOSIT_PAST_GRACE,
          storeId: position.storeId,
          createdAt: { gte: utcDayStart(now) },
        },
        select: { id: true },
      });
      if (existing) {
        alreadyFlaggedToday.push(position.storeId);
        continue;
      }

      await writeAuditLog({
        userId: null,
        storeId: position.storeId,
        action: AuditAction.CASH_DEPOSIT_PAST_GRACE,
        entityType: "Store",
        entityId: position.storeId,
        after: {
          undepositedTotal: position.undepositedTotal,
          oldestUndepositedAt: position.oldestUndepositedAt?.toISOString() ?? null,
          daysOutstanding: position.daysOutstanding,
          graceDays: position.graceDays,
          pastDoubleGrace: position.pastDoubleGrace,
        },
      });

      flaggedStoreIds.push(position.storeId);
      console.log(
        JSON.stringify({
          type: "CASH_DEPOSIT_PAST_GRACE",
          storeId: position.storeId,
          storeName: position.storeName,
          undepositedTotal: position.undepositedTotal,
          daysOutstanding: position.daysOutstanding,
          graceDays: position.graceDays,
          at: new Date().toISOString(),
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "CASH_DEPOSIT_FLAG_ERROR",
          storeId: position.storeId,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        }),
      );
    }
  }

  return { flaggedStoreIds, alreadyFlaggedToday };
}

/**
 * Starts the daily undeposited-cash cron. Safe to call once from index.ts.
 */
export function startFlagUndepositedCashJob(): void {
  if (started) {
    return;
  }
  started = true;

  // Daily at 06:30 server time — after expireLots, before typical store open.
  cron.schedule("30 6 * * *", () => {
    void runFlagUndepositedCashOnce().then(({ flaggedStoreIds }) => {
      if (flaggedStoreIds.length) {
        console.log(`flagUndepositedCash: flagged=${flaggedStoreIds.length}`);
      }
    });
  });

  console.log("Scheduled flagUndepositedCash job (daily at 06:30)");
}
