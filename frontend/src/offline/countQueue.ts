/**
 * Offline stock count queue (IndexedDB) — the POS cash-sale queue pattern, applied to counts.
 *
 * Every counted quantity is written here first and then sent, online or not, so a dead spot in
 * the stockroom never loses a count and the screen behaves the same either way. The count sheet
 * is cached alongside so the screen can open and resolve scans with no signal.
 */
import type { StockCountSheet } from "../api/types";
import {
  idbDelete,
  idbGet,
  idbGetAllFromIndex,
  idbPut,
  STORE_COUNT_QUEUE,
  STORE_COUNT_SHEETS,
  type CountSheetRecord,
  type QueuedCountEntry,
} from "./idb";

export type { QueuedCountEntry };
export { newIdempotencyKey } from "./salesQueue";

export async function enqueueCountEntry(entry: QueuedCountEntry): Promise<void> {
  await idbPut(STORE_COUNT_QUEUE, entry);
}

export async function listQueuedCountEntries(countId: string): Promise<QueuedCountEntry[]> {
  const rows = await idbGetAllFromIndex<QueuedCountEntry>(STORE_COUNT_QUEUE, "byCount", countId);
  return rows.sort((a, b) => a.countedAt.localeCompare(b.countedAt));
}

export async function removeCountEntry(idempotencyKey: string): Promise<void> {
  await idbDelete(STORE_COUNT_QUEUE, idempotencyKey);
}

export async function markCountEntry(
  entry: QueuedCountEntry,
  patch: Pick<QueuedCountEntry, "lastError" | "rejected">,
): Promise<void> {
  await idbPut(STORE_COUNT_QUEUE, { ...entry, ...patch });
}

export async function cacheCountSheet(sheet: StockCountSheet): Promise<void> {
  const record: CountSheetRecord = {
    countId: sheet.id,
    storeId: sheet.storeId,
    sheet,
    cachedAt: new Date().toISOString(),
  };
  await idbPut(STORE_COUNT_SHEETS, record);
}

export async function readCachedCountSheet(
  countId: string,
): Promise<{ sheet: StockCountSheet; cachedAt: string } | null> {
  const record = await idbGet<CountSheetRecord>(STORE_COUNT_SHEETS, countId);
  if (!record) return null;
  return { sheet: record.sheet as StockCountSheet, cachedAt: record.cachedAt };
}
