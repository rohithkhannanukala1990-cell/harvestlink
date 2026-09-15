/**
 * Offline cash-sale queue (IndexedDB).
 *
 * Card payments are never queued — Stripe genuinely needs connectivity. Only CASH
 * sales are written here while offline, then replayed by syncQueuedSales on reconnect.
 */
import {
  idbCountIndex,
  idbDelete,
  idbGetAllFromIndex,
  idbPut,
  STORE_QUEUE,
  type QueuedSale,
} from "./idb";

export type { QueuedSale };

export async function enqueueOfflineSale(sale: QueuedSale): Promise<void> {
  if (sale.paymentMethod !== "CASH") {
    throw new Error("Only CASH sales may be queued offline");
  }
  await idbPut(STORE_QUEUE, sale);
}

export async function listQueuedSales(storeId: string): Promise<QueuedSale[]> {
  const rows = await idbGetAllFromIndex<QueuedSale>(STORE_QUEUE, "byStore", storeId);
  return rows.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function countQueuedSales(storeId: string): Promise<number> {
  return idbCountIndex(STORE_QUEUE, "byStore", storeId);
}

export async function removeQueuedSale(idempotencyKey: string): Promise<void> {
  await idbDelete(STORE_QUEUE, idempotencyKey);
}

export async function markQueuedSaleError(
  sale: QueuedSale,
  lastError: string,
): Promise<void> {
  await idbPut(STORE_QUEUE, { ...sale, lastError });
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
