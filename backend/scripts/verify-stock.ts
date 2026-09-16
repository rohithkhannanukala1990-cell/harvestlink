/**
 * Verify Product.stock / Product.reserved rollups match ACTIVE lots.
 *
 * Invariant (for every product):
 *   SUM(ACTIVE lot.quantityRemaining) === Product.stock
 *   SUM(ACTIVE lot.quantityReserved)  === Product.reserved
 *
 * Usage: npm run verify:stock
 * Exit 0 when all products match; exit 1 and print mismatches otherwise.
 */
import { LotStatus } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";

type Mismatch = {
  productId: string;
  sku: string;
  storeId: string;
  stock: number;
  reserved: number;
  lotRemaining: number;
  lotReserved: number;
};

async function main(): Promise<void> {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      sku: true,
      storeId: true,
      stock: true,
      reserved: true,
    },
    orderBy: [{ storeId: "asc" }, { sku: "asc" }],
  });

  const activeSums = await prisma.lot.groupBy({
    by: ["productId"],
    where: { status: LotStatus.ACTIVE },
    _sum: {
      quantityRemaining: true,
      quantityReserved: true,
    },
  });
  const byProduct = new Map(
    activeSums.map((row) => [
      row.productId,
      {
        remaining: row._sum.quantityRemaining ?? 0,
        reserved: row._sum.quantityReserved ?? 0,
      },
    ]),
  );

  const mismatches: Mismatch[] = [];
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

  console.log(`Checked ${products.length} product(s) against ACTIVE lot rollups.`);
  if (mismatches.length === 0) {
    console.log("OK — SUM(ACTIVE remaining) === stock and SUM(ACTIVE reserved) === reserved for all products.");
    return;
  }

  console.error(`FAIL — ${mismatches.length} product(s) out of sync:\n`);
  for (const m of mismatches) {
    console.error(
      `  ${m.sku} (${m.productId}) store=${m.storeId}\n` +
        `    Product.stock=${m.stock} vs ACTIVE remaining=${m.lotRemaining}\n` +
        `    Product.reserved=${m.reserved} vs ACTIVE reserved=${m.lotReserved}`,
    );
  }
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
