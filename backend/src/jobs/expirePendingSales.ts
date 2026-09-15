/**
 * Cleanup job for abandoned PENDING sales (Phase 12).
 *
 * Finds sales whose reservationExpiresAt has passed, then:
 * 1) Asks Stripe whether payment actually succeeded (lost webhook / confirm race).
 *    If paid → finalizePaidSale (keep reservation → convert to stock decrement).
 * 2) Otherwise → markSaleExpired + release reserved units.
 *
 * Why not blindly expire: at-least-once delivery means a paid Checkout can sit PENDING
 * if the webhook never arrived. Expiring that sale would free reserved stock while the
 * customer was already charged — the exact failure mode Phase 11 reservations prevent
 * for concurrent cashiers.
 *
 * Stripe delivery is at-least-once; this job + finalizePaidSale idempotency keep inventory
 * and payment status aligned when webhooks are late or duplicated.
 */
import cron from "node-cron";
import { PaymentStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  finalizePaidSale,
  isSalePaidInStripe,
  markSaleExpired,
} from "../services/sales.service.js";

let started = false;

export async function runExpirePendingSalesOnce(now = new Date()): Promise<{
  finalized: string[];
  expired: string[];
}> {
  const stale = await prisma.sale.findMany({
    where: {
      paymentStatus: PaymentStatus.PENDING,
      reservationExpiresAt: { lte: now },
    },
    select: {
      id: true,
      storeId: true,
      stripeCheckoutSessionId: true,
      stripePaymentIntentId: true,
      reservationExpiresAt: true,
    },
    take: 100,
    orderBy: { reservationExpiresAt: "asc" },
  });

  const finalized: string[] = [];
  const expired: string[] = [];

  for (const sale of stale) {
    try {
      const paidInStripe = await isSalePaidInStripe(sale);
      if (paidInStripe) {
        await finalizePaidSale(sale.id);
        finalized.push(sale.id);
        console.log(
          JSON.stringify({
            type: "PENDING_SALE_FINALIZED_BY_EXPIRY_JOB",
            saleId: sale.id,
            storeId: sale.storeId,
            reason: "Stripe showed paid; webhook likely lost",
            at: new Date().toISOString(),
          }),
        );
        continue;
      }

      await markSaleExpired(sale.id);
      expired.push(sale.id);
      console.log(
        JSON.stringify({
          type: "PENDING_SALE_EXPIRED",
          saleId: sale.id,
          storeId: sale.storeId,
          reservationExpiresAt: sale.reservationExpiresAt?.toISOString() ?? null,
          at: new Date().toISOString(),
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "PENDING_SALE_EXPIRY_ERROR",
          saleId: sale.id,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        }),
      );
    }
  }

  return { finalized, expired };
}

/**
 * Starts the every-5-minutes cron. Safe to call once from index.ts.
 */
export function startExpirePendingSalesJob(): void {
  if (started) {
    return;
  }
  started = true;

  // Every 5 minutes.
  cron.schedule("*/5 * * * *", () => {
    void runExpirePendingSalesOnce().then(({ finalized, expired }) => {
      if (finalized.length || expired.length) {
        console.log(
          `expirePendingSales: finalized=${finalized.length} expired=${expired.length}`,
        );
      }
    });
  });

  console.log("Scheduled expirePendingSales job (every 5 minutes)");
}
