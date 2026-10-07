/**
 * Daily job: create a DRAFT cycle count for each active store on the
 * CooperativeSettings.cycleCountFrequencyDays cadence, with products picked by
 * generateCycleCountSchedule (value at risk, velocity, staleness, last variance, near expiry).
 *
 * A store is skipped while it still has an open CYCLE count, or when its last non-cancelled CYCLE
 * count was created less than cycleCountFrequencyDays ago. Counts are only drafted here; a store
 * admin still starts them, so nothing is frozen until people are ready to count.
 */
import cron from "node-cron";
import { StockCountStatus, StockCountType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getCooperativeSettings } from "../services/membership.service.js";
import { openCountWhere, scheduleCycleCount } from "../services/stockCount.service.js";

let started = false;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function runScheduleCycleCountsOnce(now = new Date()): Promise<{
  enabled: boolean;
  createdCountIds: string[];
  skippedStoreIds: string[];
}> {
  const settings = await getCooperativeSettings();
  if (!settings.cycleCountEnabled) {
    return { enabled: false, createdCountIds: [], skippedStoreIds: [] };
  }

  const stores = await prisma.store.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  });
  const notBefore = new Date(now.getTime() - settings.cycleCountFrequencyDays * MS_PER_DAY);
  const createdCountIds: string[] = [];
  const skippedStoreIds: string[] = [];

  for (const store of stores) {
    try {
      const openCycle = await prisma.stockCount.findFirst({
        where: { ...openCountWhere(store.id), type: StockCountType.CYCLE },
        select: { id: true },
      });
      const recent = await prisma.stockCount.findFirst({
        where: {
          storeId: store.id,
          type: StockCountType.CYCLE,
          status: { not: StockCountStatus.CANCELLED },
          createdAt: { gt: notBefore },
        },
        select: { id: true },
      });
      if (openCycle || recent) {
        skippedStoreIds.push(store.id);
        continue;
      }

      const result = await scheduleCycleCount(store.id, now);
      if (!result) {
        skippedStoreIds.push(store.id);
        continue;
      }

      createdCountIds.push(result.countId);
      console.log(
        JSON.stringify({
          type: "CYCLE_COUNT_SCHEDULED",
          storeId: store.id,
          storeName: store.name,
          countId: result.countId,
          products: result.schedule.selected.length,
          dueButDeferred: result.schedule.dueButDeferred,
          at: new Date().toISOString(),
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "CYCLE_COUNT_SCHEDULE_ERROR",
          storeId: store.id,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        }),
      );
    }
  }

  return { enabled: true, createdCountIds, skippedStoreIds };
}

/**
 * Starts the daily cycle-count scheduler. Safe to call once from index.ts.
 */
export function startScheduleCycleCountsJob(): void {
  if (started) {
    return;
  }
  started = true;

  // Daily at 06:45 server time — after expireLots, so near-expiry reflects today's lot statuses.
  cron.schedule("45 6 * * *", () => {
    void runScheduleCycleCountsOnce().then(({ createdCountIds }) => {
      if (createdCountIds.length) {
        console.log(`scheduleCycleCounts: created=${createdCountIds.length}`);
      }
    });
  });

  console.log("Scheduled scheduleCycleCounts job (daily at 06:45)");
}
