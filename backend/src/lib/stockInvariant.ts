/**
 * The lot rollup invariant behind `npm run verify:stock`. For every product:
 *   SUM(ACTIVE lot.quantityRemaining) === Product.stock
 *   SUM(ACTIVE lot.quantityReserved)  === Product.reserved
 */
import { LotStatus } from "@prisma/client";
import { prisma } from "./prisma.js";

export type StockRollupMismatch = {
  productId: string;
  sku: string;
  storeId: string;
  stock: number;
  reserved: number;
  lotRemaining: number;
  lotReserved: number;
};

export type StockRollupCheck = { checked: number; mismatches: StockRollupMismatch[] };

export async function findStockRollupMismatches(
  filter: { storeId?: string } = {},
  db: Pick<typeof prisma, "product" | "lot"> = prisma,
): Promise<StockRollupCheck> {
  const products = await db.product.findMany({
    where: filter.storeId ? { storeId: filter.storeId } : {},
    select: { id: true, sku: true, storeId: true, stock: true, reserved: true },
    orderBy: [{ storeId: "asc" }, { sku: "asc" }],
  });

  const activeSums = await db.lot.groupBy({
    by: ["productId"],
    where: { status: LotStatus.ACTIVE, ...(filter.storeId ? { storeId: filter.storeId } : {}) },
    _sum: { quantityRemaining: true, quantityReserved: true },
  });
  const byProduct = new Map(
    activeSums.map((row) => [
      row.productId,
      { remaining: row._sum.quantityRemaining ?? 0, reserved: row._sum.quantityReserved ?? 0 },
    ]),
  );

  const mismatches: StockRollupMismatch[] = [];
  for (const p of products) {
    const sums = byProduct.get(p.id) ?? { remaining: 0, reserved: 0 };
    if (sums.remaining !== p.stock || sums.reserved !== p.reserved) {
      mismatches.push({
        productId: p.id,
        sku: p.sku,
        storeId: p.storeId,
        stock: p.stock,
        reserved: p.reserved,
        lotRemaining: sums.remaining,
        lotReserved: sums.reserved,
      });
    }
  }
  return { checked: products.length, mismatches };
}
