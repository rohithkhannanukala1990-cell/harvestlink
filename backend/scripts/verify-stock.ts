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
import { prisma } from "../src/lib/prisma.js";
import { findStockRollupMismatches } from "../src/lib/stockInvariant.js";

async function main(): Promise<void> {
  const { checked, mismatches } = await findStockRollupMismatches();

  console.log(`Checked ${checked} product(s) against ACTIVE lot rollups.`);
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
