/**
 * Data migration: create a LEGACY lot for every Product currently holding stock.
 *
 * Idempotent — safe to run twice. Uses @@unique([productId, lotNumber, storeId]) so
 * lotNumber = "LEGACY-" + sku is never duplicated for the same product/store.
 *
 * Legacy stock predates lot tracking. We do not know its true origin or expiry, and inventing
 * one would be worse than recording none. Flag these for physical recount.
 *
 * Usage: npx tsx scripts/migrate-legacy-lots.ts
 *    or: npm run db:migrate-legacy-lots
 */
import { LotStatus } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";

function legacyLotNumber(sku: string): string {
  return `LEGACY-${sku}`;
}

async function main(): Promise<void> {
  const productsWithStock = await prisma.product.findMany({
    where: { stock: { gt: 0 } },
    select: {
      id: true,
      storeId: true,
      sku: true,
      stock: true,
      reserved: true,
      cost: true,
      name: true,
    },
    orderBy: [{ storeId: "asc" }, { sku: "asc" }],
  });

  let lotsCreated = 0;
  let lotsSkipped = 0;
  let totalUnits = 0;
  const recountSkus: string[] = [];

  const now = new Date();

  for (const product of productsWithStock) {
    const lotNumber = legacyLotNumber(product.sku);

    const existing = await prisma.lot.findUnique({
      where: {
        productId_lotNumber_storeId: {
          productId: product.id,
          lotNumber,
          storeId: product.storeId,
        },
      },
      select: { id: true },
    });

    if (existing) {
      lotsSkipped += 1;
      // Still counts as needing recount (legacy / unknown origin).
      recountSkus.push(`${product.sku} (store ${product.storeId})`);
      continue;
    }

    await prisma.lot.create({
      data: {
        lotNumber,
        productId: product.id,
        storeId: product.storeId,
        supplierId: null,
        goodsReceiptLineId: null,
        harvestDate: null,
        packDate: null,
        expiryDate: null,
        quantityReceived: product.stock,
        quantityRemaining: product.stock,
        // Carry existing holds across so available = remaining - reserved stays consistent.
        quantityReserved: product.reserved,
        status: LotStatus.ACTIVE,
        countryOfOrigin: null,
        receivedAt: now,
        unitCost: product.cost,
      },
    });

    lotsCreated += 1;
    totalUnits += product.stock;
    recountSkus.push(`${product.sku} (store ${product.storeId})`);
  }

  console.log("\n=== Legacy lot migration summary ===");
  console.log(`Lots created:              ${lotsCreated}`);
  console.log(`Lots already present:      ${lotsSkipped}`);
  console.log(`Total units in new lots:   ${totalUnits}`);
  console.log(`Products needing recount:  ${recountSkus.length}`);
  console.log(
    "  (Legacy stock — unknown supplier/expiry; physical recount recommended.)",
  );

  // VERIFY: for every product, lot sums must match Product.stock / Product.reserved.
  const allProducts = await prisma.product.findMany({
    select: {
      id: true,
      storeId: true,
      sku: true,
      stock: true,
      reserved: true,
    },
  });

  const lotAggs = await prisma.lot.groupBy({
    by: ["productId"],
    where: { status: LotStatus.ACTIVE },
    _sum: {
      quantityRemaining: true,
      quantityReserved: true,
    },
  });
  const lotSumByProduct = new Map(
    lotAggs.map((row) => [
      row.productId,
      {
        remaining: row._sum.quantityRemaining ?? 0,
        reserved: row._sum.quantityReserved ?? 0,
      },
    ]),
  );

  const mismatches: string[] = [];
  for (const product of allProducts) {
    const sums = lotSumByProduct.get(product.id) ?? { remaining: 0, reserved: 0 };
    if (sums.remaining !== product.stock || sums.reserved !== product.reserved) {
      mismatches.push(
        `${product.sku} (id=${product.id}): ` +
          `stock ${product.stock} vs ACTIVE remaining ${sums.remaining}; ` +
          `reserved ${product.reserved} vs ACTIVE reserved ${sums.reserved}`,
      );
    }
  }

  if (mismatches.length > 0) {
    console.error("\n=== VERIFICATION FAILED ===");
    console.error(`${mismatches.length} product(s) with ACTIVE lot sum mismatch:`);
    for (const line of mismatches) {
      console.error(`  ERROR: ${line}`);
    }
    throw new Error(
      `Legacy lot verification failed: ${mismatches.length} product mismatch(es)`,
    );
  }

  console.log("\n=== Verification OK ===");
  console.log(
    `Checked ${allProducts.length} product(s): SUM(ACTIVE lot.quantityRemaining) === stock and SUM(ACTIVE lot.quantityReserved) === reserved.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
