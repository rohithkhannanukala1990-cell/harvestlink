/**
 * Stripe webhook handler for Harvestlink.
 *
 * Stripe guarantees at-least-once delivery: the same evt_… may arrive more than once,
 * and POST /sales/:id/confirm-payment can race the webhook. This handler MUST be safe
 * to run twice for the same event.
 *
 * Idempotency: after signature verification we insert ProcessedStripeEvent(id = event.id).
 * A unique-constraint violation means we already handled that delivery — return 200 and
 * skip work. finalizePaidSale is also idempotent on PAID, but the event log makes
 * double-finalize debugging possible for ops.
 *
 * Money still settles to the CO-OP Stripe account; operator payables stay on /settlement.
 */
import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import type Stripe from "stripe";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { constructStripeEvent } from "../lib/stripe.js";
import * as salesService from "../services/sales.service.js";

async function saleIdFromEvent(event: Stripe.Event): Promise<string | null> {
  const obj = event.data.object as {
    metadata?: { saleId?: string };
    id?: string;
    payment_intent?: string | { id?: string } | null;
  };

  if (obj.metadata?.saleId) {
    return obj.metadata.saleId;
  }

  if (event.type.startsWith("checkout.session.")) {
    const sessionId = obj.id;
    if (!sessionId) {
      return null;
    }
    const sale = await prisma.sale.findFirst({
      where: { stripeCheckoutSessionId: sessionId },
      select: { id: true },
    });
    return sale?.id ?? null;
  }

  if (event.type.startsWith("payment_intent.")) {
    const intentId = obj.id;
    if (!intentId) {
      return null;
    }
    const sale = await prisma.sale.findFirst({
      where: { stripePaymentIntentId: intentId },
      select: { id: true },
    });
    return sale?.id ?? null;
  }

  return null;
}

/**
 * Claims this Stripe event id for processing. Returns false if already processed
 * (unique violation on ProcessedStripeEvent.id).
 */
async function claimStripeEvent(
  event: Stripe.Event,
  saleId: string | null,
): Promise<boolean> {
  try {
    await prisma.processedStripeEvent.create({
      data: {
        id: event.id,
        type: event.type,
        saleId,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  const signature = req.headers["stripe-signature"];
  if (!signature || typeof signature !== "string") {
    res.status(400).json({ error: "Missing Stripe-Signature header" });
    return;
  }

  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Webhook requires raw body buffer" });
    return;
  }

  let event: Stripe.Event;
  try {
    event = constructStripeEvent(req.body, signature);
  } catch (error) {
    console.error("Stripe webhook signature verification failed", error);
    res.status(400).json({ error: "Invalid Stripe signature" });
    return;
  }

  // Resolve sale early so the idempotency row records saleId for audit.
  const saleId = await saleIdFromEvent(event);

  const claimed = await claimStripeEvent(event, saleId);
  if (!claimed) {
    // Duplicate delivery (Stripe retry) or prior successful claim — do not reprocess.
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status === "paid" && saleId) {
          if (typeof session.payment_intent === "string") {
            await prisma.sale.updateMany({
              where: { id: saleId, stripePaymentIntentId: null },
              data: { stripePaymentIntentId: session.payment_intent },
            });
          }
          await salesService.finalizePaidSale(saleId);
        }
        break;
      }
      case "payment_intent.succeeded": {
        if (saleId) {
          await salesService.finalizePaidSale(saleId);
        }
        break;
      }
      case "payment_intent.payment_failed": {
        if (saleId) {
          await salesService.markSalePaymentFailed(saleId);
        }
        break;
      }
      default:
        break;
    }

    res.status(200).json({ received: true });
  } catch (error) {
    // Allow Stripe to retry: drop the claim so the next delivery can reprocess.
    await prisma.processedStripeEvent.delete({ where: { id: event.id } }).catch(() => undefined);

    if (error instanceof AppError) {
      console.error("Stripe webhook business error", error.message, error.details);
      // Permanent business conflicts (already PAID, etc.) — acknowledge to stop retries.
      if (error.status === 409) {
        await prisma.processedStripeEvent
          .create({
            data: { id: event.id, type: event.type, saleId },
          })
          .catch(() => undefined);
        res.status(200).json({ received: true, warning: error.message });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }
    console.error("Stripe webhook handler failed", error);
    res.status(500).json({ error: "Webhook handler failed" });
  }
}
