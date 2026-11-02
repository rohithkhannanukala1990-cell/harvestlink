/**
 * Row locks for inventory mutations.
 *
 * /// LOCK ORDER — every transaction in this codebase:
 * ///   1. Product rows, ordered by id
 * ///   2. Lot rows, in FEFO order (productId, expiryDate NULLS LAST, receivedAt, id)
 * ///   3. Anything else (Store, Sale, StockCount, transfer rows…)
 * /// Any code that changes a Lot must lock that lot's Product row first, even if it only means to
 * /// update the lot. Taking these in a different order deadlocks against the till.
 */
import { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export type LockedProductRow = {
  id: string;
  storeId: string;
  sku: string;
  name: string;
  category: string;
  price: Prisma.Decimal;
  stock: number;
  reserved: number;
  taxExempt: boolean;
};

export type LockedLotRow = {
  id: string;
  lotNumber: string;
  productId: string;
  storeId: string;
  quantityRemaining: number;
  quantityReserved: number;
  unitCost: Prisma.Decimal;
  expiryDate: Date | null;
  receivedAt: Date;
  status: string;
};

/** True when Postgres aborted the transaction for a deadlock (SQLSTATE 40P01). */
export function isDeadlockError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === "P2034" || e.code === "40P01") return true;
  if (e.meta?.code === "40P01") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return msg.includes("40P01") || /deadlock detected/i.test(msg);
}

/**
 * Locks Product rows in id order. Call before any Lot lock or Product.stock/reserved write.
 * Empty input is a no-op (Prisma cannot `IN ()`).
 */
export async function lockProducts(tx: Tx, productIds: string[]): Promise<LockedProductRow[]> {
  const ids = [...new Set(productIds.filter(Boolean))].sort();
  if (ids.length === 0) return [];
  return tx.$queryRaw<LockedProductRow[]>`
    SELECT id, "storeId", sku, name, category, price, stock, reserved, "taxExempt"
    FROM "Product"
    WHERE id IN (${Prisma.join(ids)})
    ORDER BY id ASC
    FOR UPDATE
  `;
}

/**
 * Locks specific Lot rows in FEFO order. Call only after lockProducts for those lots' products.
 */
export async function lockLots(tx: Tx, lotIds: string[]): Promise<LockedLotRow[]> {
  const ids = [...new Set(lotIds.filter(Boolean))];
  if (ids.length === 0) return [];
  return tx.$queryRaw<LockedLotRow[]>`
    SELECT id, "lotNumber", "productId", "storeId", "quantityRemaining", "quantityReserved",
           "unitCost", "expiryDate", "receivedAt", status::text AS status
    FROM "Lot"
    WHERE id IN (${Prisma.join(ids)})
    ORDER BY "productId" ASC, "expiryDate" ASC NULLS LAST, "receivedAt" ASC, id ASC
    FOR UPDATE
  `;
}

/**
 * Locks every ACTIVE lot for the given products in this store, FEFO order.
 * Same query createSale uses to allocate units.
 */
export async function lockActiveLotsForProducts(
  tx: Tx,
  productIds: string[],
  storeId: string,
): Promise<LockedLotRow[]> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return [];
  return tx.$queryRaw<LockedLotRow[]>`
    SELECT id, "lotNumber", "productId", "storeId", "quantityRemaining", "quantityReserved",
           "unitCost", "expiryDate", "receivedAt", status::text AS status
    FROM "Lot"
    WHERE "productId" IN (${Prisma.join(ids)})
      AND "storeId" = ${storeId}
      AND status = 'ACTIVE'
    ORDER BY "productId" ASC, "expiryDate" ASC NULLS LAST, "receivedAt" ASC, id ASC
    FOR UPDATE
  `;
}
