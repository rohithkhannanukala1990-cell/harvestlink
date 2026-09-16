/**
 * Near-expiry inventory listing (GET /inventory/expiring).
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { createApp } from "../src/app.js";
import { prisma } from "./helpers/db.js";
import { createProduct, seedCashierStore, signTestToken } from "./helpers/factories.js";

describe("GET /inventory/expiring", () => {
  it("lists ACTIVE lots approaching expiry within days window", async () => {
    const app = createApp();
    const { store, cashier } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 0, skipLot: true, sku: "NEAR1" });
    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    const far = new Date();
    far.setDate(far.getDate() + 90);

    await prisma.lot.create({
      data: {
        lotNumber: "SOON",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 5,
        quantityRemaining: 5,
        unitCost: new Prisma.Decimal(1),
        expiryDate: soon,
        receivedAt: new Date(),
        status: "ACTIVE",
      },
    });
    await prisma.lot.create({
      data: {
        lotNumber: "FAR",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 5,
        quantityRemaining: 5,
        unitCost: new Prisma.Decimal(1),
        expiryDate: far,
        receivedAt: new Date(),
        status: "ACTIVE",
      },
    });
    await prisma.product.update({ where: { id: product.id }, data: { stock: 10 } });

    const token = signTestToken(cashier);
    const res = await request(app)
      .get("/inventory/expiring?days=30")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    const numbers = res.body.lots.map((l: { lotNumber: string }) => l.lotNumber);
    expect(numbers).toContain("SOON");
    expect(numbers).not.toContain("FAR");
  });
});
