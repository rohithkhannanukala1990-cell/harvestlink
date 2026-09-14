/**
 * Stripe client + payment helpers for Harvestlink sales.
 *
 * MONEY ROUTING (read this before changing Connect / destination charges):
 * - The co-op Stripe account is the merchant of record and the Stripe payout destination.
 *   Card captures (Checkout or Terminal) fund the co-op — not the store operator.
 * - Operator earnings (Sale.operatorAmount) and Phase 6 /settlement Payout rows are an
 *   INTERNAL ledger only. They are NOT Stripe payouts / Connect transfers to operators.
 *   The co-op pays operators separately (e.g. weekly bank transfer) when settlement says so.
 *
 * Channels:
 * - CHECKOUT — Stripe Checkout Session (card-not-present / remote pay link)
 * - TERMINAL — PaymentIntent with card_present for in-store readers
 */
import Stripe from "stripe";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError(503, "Stripe is not configured (STRIPE_SECRET_KEY missing)");
  }

  if (!stripeClient) {
    stripeClient = new Stripe(env.STRIPE_SECRET_KEY);
  }

  return stripeClient;
}

/** Converts a Prisma Decimal / number money amount to Stripe's integer cents. */
export function toStripeCents(amount: { toString(): string } | number): number {
  const n = typeof amount === "number" ? amount : Number(amount.toString());
  if (!Number.isFinite(n) || n < 0) {
    throw new AppError(400, "Invalid amount for Stripe");
  }
  return Math.round(n * 100);
}

export function constructStripeEvent(rawBody: Buffer, signature: string): Stripe.Event {
  const stripe = getStripe();
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError(503, "Stripe webhook secret is not configured");
  }
  return stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}
