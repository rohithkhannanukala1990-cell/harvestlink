/**
 * Offline → online sale sync for Harvestlink POS.
 *
 * FLOW
 * 1. While offline, POS enqueues CASH sales in IndexedDB with a stable idempotencyKey.
 * 2. On reconnect (window 'online' / visibility), syncQueuedSales walks the queue FIFO.
 * 3. Each item is POSTed to /sales with the SAME idempotencyKey and offlineSync: true.
 * 4. Success (201 create or 200 replay) → remove from queue.
 * 5. Hard failure → keep in queue with lastError; stop FIFO so order is preserved.
 *
 * WHY IDEMPOTENCY KEYS
 * Network flaps mean the client may POST, lose the response, and POST again. Without a
 * unique Sale.idempotencyKey the server would create two sales and decrement stock twice
 * for one physical basket. The key is minted when the cashier taps Checkout offline and
 * never regenerated for that queued row.
 *
 * WHY offlineSync + NEGATIVE STOCK (server)
 * Between queue and sync, another till may have sold the last units online. The server
 * must NOT silently drop the queued sale — cash already changed hands and goods left the
 * building. createSale(offlineSync) accepts the sale, allows Product.stock to go negative,
 * and inserts StockReconciliation rows for ops review. Physical reality outranks the DB count.
 */
import { apiRequest } from "../api/client";
import type { Sale } from "../api/types";
import {
  listQueuedSales,
  markQueuedSaleError,
  removeQueuedSale,
  type QueuedSale,
} from "./salesQueue";

export type SyncResult = {
  synced: number;
  failed: number;
  reconciliationWarnings: number;
  errors: string[];
};

let syncInFlight: Promise<SyncResult> | null = null;

export async function syncQueuedSales(storeId: string): Promise<SyncResult> {
  // Single-flight: overlapping online events must not double-POST the same queue.
  if (syncInFlight) {
    return syncInFlight;
  }

  syncInFlight = (async () => {
    const result: SyncResult = {
      synced: 0,
      failed: 0,
      reconciliationWarnings: 0,
      errors: [],
    };

    const queue = await listQueuedSales(storeId);
    for (const queued of queue) {
      try {
        const replay = await replayOne(queued);
        await removeQueuedSale(queued.idempotencyKey);
        result.synced += 1;
        if (replay.stockReconciliationQueued) {
          result.reconciliationWarnings += 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Sync failed";
        result.failed += 1;
        result.errors.push(`${queued.idempotencyKey}: ${message}`);
        await markQueuedSaleError(queued, message);
        // Stop on first failure so FIFO order is preserved.
        break;
      }
    }

    return result;
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

async function replayOne(queued: QueuedSale): Promise<{
  sale: Sale;
  stockReconciliationQueued?: boolean;
}> {
  return apiRequest<{
    sale: Sale;
    replayed?: boolean;
    stockReconciliationQueued?: boolean;
  }>("/sales", {
    method: "POST",
    body: {
      storeId: queued.storeId,
      memberId: queued.memberId,
      paymentMethod: "CASH",
      // Stable key minted at offline checkout — server returns existing sale on retry.
      idempotencyKey: queued.idempotencyKey,
      // Instructs createSale to accept insufficient stock and flag reconciliation.
      offlineSync: true,
      items: queued.items.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        ...(line.manualDiscount
          ? {
              manualDiscount: line.manualDiscount,
              discountReason: line.discountReason,
            }
          : {}),
      })),
    },
  });
}
