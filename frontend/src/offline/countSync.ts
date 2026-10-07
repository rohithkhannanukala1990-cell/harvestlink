/**
 * Offline → online sync for stock count entries. Same shape as sync.ts for sales:
 *
 * 1. The counting screen enqueues each confirmed quantity with a stable idempotencyKey.
 * 2. syncQueuedCounts walks the queue (on save, on reconnect, on returning to the tab).
 * 3. Each entry is POSTed with the SAME key, plus countedAt and sentAt from the device clock.
 * 4. Success (first write or replay) → remove from the queue.
 *
 * WHY countedAt + sentAt
 * The variance must be measured against the shelf as it was when the counter looked, not when the
 * entry finally synced — sales carry on meanwhile. The server places the count at countedAt,
 * corrected by this device's clock skew (its receive time − sentAt).
 *
 * WHERE IT DIFFERS FROM SALES
 * Sales stop at the first failure to keep FIFO stock order. Count entries are independent lines,
 * so a refusal (4xx: count closed, line already counted by someone else) marks that entry
 * rejected for the counter to see and the walk continues. A transport failure (no signal, 5xx,
 * expired session) stops the walk and keeps everything for the next attempt.
 */
import { ApiError, apiRequest } from "../api/client";
import type { CountLineStatus } from "../api/types";
import {
  listQueuedCountEntries,
  markCountEntry,
  removeCountEntry,
  type QueuedCountEntry,
} from "./countQueue";

export type CountSyncResult = {
  synced: number;
  rejected: number;
  /** Transport failure: the remaining entries are still queued. */
  stalled: boolean;
  /** Server status per synced line, e.g. RECOUNT_REQUIRED. */
  statuses: Record<string, CountLineStatus>;
};

const inFlight = new Map<string, Promise<CountSyncResult>>();

function isRefusal(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429;
}

export async function syncQueuedCounts(countId: string): Promise<CountSyncResult> {
  // Single-flight per count: overlapping triggers must not double-POST the same entries.
  const running = inFlight.get(countId);
  if (running) return running;

  const run = (async () => {
    const result: CountSyncResult = { synced: 0, rejected: 0, stalled: false, statuses: {} };
    const queue = await listQueuedCountEntries(countId);
    for (const entry of queue) {
      if (entry.rejected) continue;
      try {
        const res = await replayOne(entry);
        await removeCountEntry(entry.idempotencyKey);
        result.synced += 1;
        result.statuses[res.lineId] = res.status;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Sync failed";
        if (isRefusal(err)) {
          await markCountEntry(entry, { lastError: message, rejected: true });
          result.rejected += 1;
          continue;
        }
        await markCountEntry(entry, { lastError: message, rejected: false });
        result.stalled = true;
        break;
      }
    }
    return result;
  })();

  inFlight.set(countId, run);
  try {
    return await run;
  } finally {
    inFlight.delete(countId);
  }
}

function replayOne(entry: QueuedCountEntry) {
  return apiRequest<{ lineId: string; status: CountLineStatus; replayed?: boolean }>(
    `/stock-counts/${entry.countId}/lines/${entry.lineId}/count`,
    {
      method: "POST",
      body: {
        countedQuantity: entry.countedQuantity,
        idempotencyKey: entry.idempotencyKey,
        countedAt: entry.countedAt,
        sentAt: new Date().toISOString(),
      },
    },
  );
}
