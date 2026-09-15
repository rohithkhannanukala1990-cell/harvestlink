/**
 * Reconciliation job for stuck REFUNDING sales (refund protocol).
 *
 * Flow under normal refundSale:
 *   1) DB claim → paymentStatus = REFUNDING + SaleRefund PENDING
 *   2) stripe.refunds.create
 *   3) finalizeSucceededRefund → PAID (partial) or REFUNDED (full)
 *
 * If the process dies between (2) and (3), money may already be refunded in Stripe while
 * the sale still reads REFUNDING and inventory/settlement clawback never ran.
 * This job asks Stripe for truth and either finalizes or aborts the claim.
 */
import cron from "node-cron";
import { PaymentStatus, SaleRefundStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  REFUNDING_RECONCILE_AFTER_MS,
  reconcileRefundingSale,
} from "../services/sales.service.js";

let started = false;

export async function runReconcileRefundingSalesOnce(now = new Date()): Promise<{
  finalized: string[];
  aborted: string[];
  pending: string[];
}> {
  const cutoff = new Date(now.getTime() - REFUNDING_RECONCILE_AFTER_MS);

  const stuck = await prisma.sale.findMany({
    where: {
      paymentStatus: PaymentStatus.REFUNDING,
      OR: [
        {
          refunds: {
            some: {
              status: SaleRefundStatus.PENDING,
              createdAt: { lte: cutoff },
            },
          },
        },
        {
          AND: [
            { pendingRefundId: null },
            { refunds: { none: { status: SaleRefundStatus.PENDING } } },
          ],
        },
      ],
    },
    select: { id: true },
    take: 50,
    orderBy: { createdAt: "asc" },
  });

  const finalized: string[] = [];
  const aborted: string[] = [];
  const pending: string[] = [];

  for (const sale of stuck) {
    try {
      const result = await reconcileRefundingSale(sale.id);
      if (result === "finalized") {
        finalized.push(sale.id);
      } else if (result === "aborted") {
        aborted.push(sale.id);
      } else {
        pending.push(sale.id);
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "REFUNDING_RECONCILE_ERROR",
          saleId: sale.id,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        }),
      );
      pending.push(sale.id);
    }
  }

  return { finalized, aborted, pending };
}

export function startReconcileRefundingSalesJob(): void {
  if (started) {
    return;
  }
  started = true;

  cron.schedule("*/2 * * * *", () => {
    void runReconcileRefundingSalesOnce().then(({ finalized, aborted }) => {
      if (finalized.length || aborted.length) {
        console.log(
          `reconcileRefundingSales: finalized=${finalized.length} aborted=${aborted.length}`,
        );
      }
    });
  });

  console.log("Scheduled reconcileRefundingSales job (every 2 minutes)");
}
