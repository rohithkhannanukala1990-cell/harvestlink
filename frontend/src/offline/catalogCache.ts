/**
 * Product catalog cache — refreshed whenever the POS successfully loads products online.
 * Offline POS reads from here so cashiers can still build a cart without the network.
 */
import type { Product } from "../api/types";
import { idbGet, idbPut, STORE_CATALOG, type CatalogRecord } from "./idb";

export async function cacheProductCatalog(storeId: string, products: Product[]): Promise<void> {
  const record: CatalogRecord = {
    storeId,
    products,
    updatedAt: new Date().toISOString(),
  };
  await idbPut(STORE_CATALOG, record);
}

export async function readCachedCatalog(
  storeId: string,
): Promise<{ products: Product[]; updatedAt: string } | null> {
  const record = await idbGet<CatalogRecord>(STORE_CATALOG, storeId);
  if (!record) return null;
  return {
    products: record.products as Product[],
    updatedAt: record.updatedAt,
  };
}

/** Optimistic local stock decrement so the offline grid doesn't keep offering sold-out SKUs. */
export async function adjustCachedStock(
  storeId: string,
  deltas: Array<{ productId: string; quantityDelta: number }>,
): Promise<void> {
  const record = await idbGet<CatalogRecord>(STORE_CATALOG, storeId);
  if (!record) return;
  const products = (record.products as Product[]).map((p) => {
    const delta = deltas.find((d) => d.productId === p.id);
    if (!delta) return p;
    const nextStock = Math.max(0, (p.available ?? p.stock) + delta.quantityDelta);
    return {
      ...p,
      stock: Math.max(0, p.stock + delta.quantityDelta),
      available: nextStock,
    };
  });
  await idbPut(STORE_CATALOG, {
    ...record,
    products,
    updatedAt: record.updatedAt,
  });
}
