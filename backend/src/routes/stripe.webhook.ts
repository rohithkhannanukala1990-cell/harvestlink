/**
 * Stripe webhook handler for Harvestlink.
 *
 * Finalizes PENDING sales to PAID (and decrements stock) when Checkout or Terminal
 * payments succeed. Marks FAILED when PaymentIntents fail.
 *
 * Remember: webhook money events credit the CO-OP Stripe balance. Operator payables
 * are updated only via Sale.operatorAmount on PAID sales + Phase 6 settlement — never
 * by Stripe automatically paying the store operator.
 */
import type { Request, Response } from "express";
import type Stripe from "stripe";
import { AppError } from "../lib/errors.js";
import { constructStripeEvent } from "../lib/stripe.js";
import { prisma } from "../lib/prisma.js";
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

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status === "paid") {
          const saleId = await saleIdFromEvent(event);
          if (saleId) {
            if (typeof session.payment_intent === "string") {
              await prisma.sale.updateMany({
                where: { id: saleId, stripePaymentIntentId: null },
                data: { stripePaymentIntentId: session.payment_intent },
              });
            }
            await salesService.finalizePaidSale(saleId);
          }
        }
        break;
      }
      case "payment_intent.succeeded": {
        const saleId = await saleIdFromEvent(event);
        if (saleId) {
          await salesService.finalizePaidSale(saleId);
        }
        break;
      }
      case "payment_intent.payment_failed": {
        const saleId = await saleIdFromEvent(event);
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
    if (error instanceof AppError) {
      console.error("Stripe webhook business error", error.message, error.details);
      // Acknowledge to avoid infinite retries on permanent 409s; ops can reconcile.
      res.status(200).json({ received: true, warning: error.message });
      return;
    }
    console.error("Stripe webhook handler failed", error);
    res.status(500).json({ error: "Webhook handler failed" });
  }
}
