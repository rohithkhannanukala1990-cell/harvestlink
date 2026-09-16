/**
 * Daily job: mark past-due ACTIVE lots as EXPIRED and keep Product.stock rollups accurate.
 *
 * QUARANTINED / RECALLED lots are never sold (createSale filters ACTIVE only). EXPIRED is the
 * time-based sibling — once expiryDate has passed, units leave the sellable rollup and are
 * recorded as an InventoryWriteOff (reason EXPIRED).
 *
 * Lots with quantityReserved > 0 are skipped until the PENDING sale settles (pay or expire),
 * so we do not break reservation release / finalize.
 */
import cron from "node-cron";
import { LotStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

let started = false;

export async function runExpireLotsOnce(now = new Date()): Promise<{
  expiredLotIds: string[];
  skippedReserved: string[];
}> {
  const due = await prisma.lot.findMany({
    where: {
      status: LotStatus.ACTIVE,
      expiryDate: { lt: now },
    },
    select: {
      id: true,
      storeId: true,
      productId: true,
      quantityRemaining: true,
      quantityReserved: true,
      expiryDate: true,
      lotNumber: true,
    },
    take: 200,
    orderBy: { expiryDate: "asc" },
  });

  const expiredLotIds: string[] = [];
  const skippedReserved: string[] = [];

  for (const lot of due) {
    if (lot.quantityReserved > 0) {
      skippedReserved.push(lot.id);
      continue;
    }

    try {
      const didExpire = await prisma.$transaction(async (tx) => {
        const claimed = await tx.lot.updateMany({
          where: {
            id: lot.id,
            status: LotStatus.ACTIVE,
            quantityReserved: 0,
          },
          data: { status: LotStatus.EXPIRED },
        });
        if (claimed.count !== 1) {
          return false;
        }

        const writeOffQty = Math.max(0, lot.quantityRemaining);
        if (writeOffQty > 0) {
          await tx.product.update({
            where: { id: lot.productId },
            data: { stock: { decrement: writeOffQty } },
          });
          await tx.inventoryWriteOff.create({
            data: {
              storeId: lot.storeId,
              productId: lot.productId,
              lotId: lot.id,
              quantity: writeOffQty,
              reason: "EXPIRED",
            },
          });
        }
        return true;
      });

      if (!didExpire) {
        continue;
      }

      expiredLotIds.push(lot.id);
      console.log(
        JSON.stringify({
          type: "LOT_EXPIRED",
          lotId: lot.id,
          lotNumber: lot.lotNumber,
          productId: lot.productId,
          storeId: lot.storeId,
          quantityWrittenOff: Math.max(0, lot.quantityRemaining),
          expiryDate: lot.expiryDate?.toISOString() ?? null,
          at: new Date().toISOString(),
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "LOT_EXPIRY_ERROR",
          lotId: lot.id,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        }),
      );
    }
  }

  return { expiredLotIds, skippedReserved };
}

/**
 * Starts the daily lot-expiry cron. Safe to call once from index.ts.
 */
export function startExpireLotsJob(): void {
  if (started) {
    return;
  }
  started = true;

  // Daily at 06:00 server time — after overnight, before typical store open.
  cron.schedule("0 6 * * *", () => {
    void runExpireLotsOnce().then(({ expiredLotIds, skippedReserved }) => {
      if (expiredLotIds.length || skippedReserved.length) {
        console.log(
          `expireLots: expired=${expiredLotIds.length} skippedReserved=${skippedReserved.length}`,
        );
      }
    });
  });

  console.log("Scheduled expireLots job (daily at 06:00)");
}
