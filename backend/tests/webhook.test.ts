/**
 * Stripe webhook signature + replay idempotency.
 */
import { PaymentMethod, PaymentStatus } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import * as salesService from "../src/services/sales.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createProduct, seedCashierStore } from "./helpers/factories.js";
import { signStripeWebhookPayload } from "./helpers/stripeMock.js";

describe("Stripe webhook", () => {
  it("rejects an invalid signature", async () => {
    const app = createApp();
    const payload = JSON.stringify({
      id: "evt_invalid_sig",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_x", metadata: {} } },
    });

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", "t=1,v1=deadbeef")
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  it("ignores a replayed event id", async () => {
    const { store, cashier } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 4, price: 10 });
    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });

    const refreshed = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    const paymentIntentId = refreshed.stripePaymentIntentId!;
    expect(paymentIntentId).toBeTruthy();

    const event = {
      id: "evt_replay_test_1",
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: paymentIntentId,
          object: "payment_intent",
          metadata: { saleId: sale.id },
        },
      },
    };
    const payload = JSON.stringify(event);
    const signature = signStripeWebhookPayload(payload);
    const app = createApp();

    const first = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", signature)
      .send(payload);

    expect(first.status).toBe(200);
    expect(first.body.received).toBe(true);

    const paid = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(paid.paymentStatus).toBe(PaymentStatus.PAID);

    const afterFirst = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(afterFirst.stock).toBe(3);

    const second = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", signature)
      .send(payload);

    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const afterSecond = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(afterSecond.stock).toBe(3);

    const events = await prisma.processedStripeEvent.count({
      where: { id: "evt_replay_test_1" },
    });
    expect(events).toBe(1);
  });
});
