/**
 * Thin IndexedDB wrapper for Harvestlink POS offline storage.
 *
 * Why IndexedDB (not localStorage): product catalogs and queued sales can exceed
 * localStorage quotas, and we need structured queries by storeId without parsing
 * giant JSON blobs on every render.
 */
const DB_NAME = "harvestlink-pos";
const DB_VERSION = 1;

export const STORE_CATALOG = "productCatalog";
export const STORE_QUEUE = "queuedSales";

export type CatalogRecord = {
  /** Composite key: storeId */
  storeId: string;
  products: unknown[];
  updatedAt: string;
};

export type QueuedSaleLine = {
  productId: string;
  quantity: number;
  manualDiscount?: number;
  discountReason?: string;
  /** Snapshots for offline UI / local receipt display. */
  nameSnapshot: string;
  priceSnapshot: number;
  skuSnapshot: string;
};

/**
 * A cash sale captured while offline. The idempotencyKey is generated once when
 * the cashier taps Checkout and MUST be reused on every sync attempt so retries
 * never create a second Sale / stock decrement on the server.
 */
export type QueuedSale = {
  idempotencyKey: string;
  storeId: string;
  memberId: string | null;
  paymentMethod: "CASH";
  items: QueuedSaleLine[];
  /** Local wall-clock when the cashier completed the offline sale. */
  queuedAt: string;
  /** Last sync error message, if any (kept until successful POST). */
  lastError?: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CATALOG)) {
        db.createObjectStore(STORE_CATALOG, { keyPath: "storeId" });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        const queue = db.createObjectStore(STORE_QUEUE, { keyPath: "idempotencyKey" });
        queue.createIndex("byStore", "storeId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export async function idbPut(storeName: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(storeName, "readwrite");
    await idbReq(tx.objectStore(storeName).put(value));
  } finally {
    db.close();
  }
}

export async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    const tx = db.transaction(storeName, "readonly");
    return (await idbReq(tx.objectStore(storeName).get(key))) as T | undefined;
  } finally {
    db.close();
  }
}

export async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(storeName, "readwrite");
    await idbReq(tx.objectStore(storeName).delete(key));
  } finally {
    db.close();
  }
}

export async function idbGetAllFromIndex<T>(
  storeName: string,
  indexName: string,
  query: IDBValidKey,
): Promise<T[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(storeName, "readonly");
    const index = tx.objectStore(storeName).index(indexName);
    return (await idbReq(index.getAll(query))) as T[];
  } finally {
    db.close();
  }
}

export async function idbCountIndex(
  storeName: string,
  indexName: string,
  query: IDBValidKey,
): Promise<number> {
  const db = await openDb();
  try {
    const tx = db.transaction(storeName, "readonly");
    const index = tx.objectStore(storeName).index(indexName);
    return await idbReq(index.count(query));
  } finally {
    db.close();
  }
}
