/**
 * CASHIER tokens must be rejected on settlement and admin-only routes.
 */
import { Role } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createProduct, seedCashierStore, signTestToken } from "./helpers/factories.js";

describe("authorization", () => {
  it("rejects a CASHIER token on every settlement and admin route", async () => {
    const { store, cashier } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 5 });
    const token = signTestToken(cashier);
    const app = createApp();
    const auth = { Authorization: `Bearer ${token}` };

    const checks: Array<{ method: "get" | "post" | "patch" | "delete"; path: string }> = [
      { method: "get", path: `/settlement/${store.id}/summary` },
      { method: "get", path: `/settlement/${store.id}/payouts` },
      { method: "post", path: `/settlement/${store.id}/payouts` },
      { method: "get", path: "/settlement/network-summary" },
      { method: "get", path: "/audit" },
      { method: "post", path: "/auth/register" },
      { method: "patch", path: `/stores/${store.id}` },
      { method: "post", path: "/products" },
      { method: "patch", path: `/products/${product.id}` },
      { method: "delete", path: `/products/${product.id}` },
      { method: "patch", path: `/products/${product.id}/stock` },
      { method: "post", path: "/sales/fake-sale-id/refund" },
      { method: "post", path: "/members" },
      { method: "patch", path: "/members/fake-member-id" },
      { method: "post", path: "/drawer/close" },
      { method: "get", path: "/reports/daily-close?date=2026-01-01" },
      { method: "get", path: "/purchasing/suppliers" },
      { method: "get", path: "/purchasing/purchase-orders" },
      { method: "post", path: "/purchasing/purchase-orders" },
      { method: "get", path: "/purchasing/reorder-suggestions" },
    ];

    for (const check of checks) {
      const req = request(app)[check.method](check.path).set(auth);
      const res =
        check.method === "get" || check.method === "delete"
          ? await req
          : await req.send({
              amount: 1,
              note: "x",
              name: "x",
              address: "x",
              operatorPercent: 1,
              sku: "X",
              category: "X",
              price: 1,
              cost: 1,
              stock: 1,
              reorderAt: 0,
              newStock: 1,
              reason: "test",
              email: "new@test.local",
              password: "StrongPass123!",
              role: Role.CASHIER,
              storeId: store.id,
              tier: "STANDARD",
            });

      expect(res.status, `${check.method.toUpperCase()} ${check.path}`).toBe(403);
    }
  });

  it("allows CASHIER on POS-safe routes", async () => {
    const { store, cashier } = await seedCashierStore();
    await createProduct(store.id, { stock: 5 });
    const token = signTestToken(cashier);
    const app = createApp();

    const products = await request(app)
      .get("/products")
      .set({ Authorization: `Bearer ${token}` });
    expect(products.status).toBe(200);

    const sales = await request(app)
      .get("/sales")
      .set({ Authorization: `Bearer ${token}` });
    expect(sales.status).toBe(200);
  });
});
