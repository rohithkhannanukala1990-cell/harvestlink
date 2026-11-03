/**
 * CASHIER tokens must be rejected on settlement and admin-only routes.
 * Inventory/lot/product GETs are allowed but must never leak cost fields.
 */
import { Role } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createProduct, seedCashierStore, signTestToken } from "./helpers/factories.js";

const COST_KEY = /cost|landed|margin|supplierPrice/i;

/** Collect every object key in a JSON tree (nested). */
function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      keys.push(k);
      collectKeys(v, keys);
    }
  }
  return keys;
}

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
              lotId: "fake-lot",
              newQuantity: 1,
              reason: "test",
              email: "new@test.local",
              password: "StrongPass123!",
              role: Role.CASHIER,
              storeId: store.id,
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
    expect(products.body.products[0].price).toBeDefined();
    expect(products.body.products[0].cost).toBeUndefined();

    const sales = await request(app)
      .get("/sales")
      .set({ Authorization: `Bearer ${token}` });
    expect(sales.status).toBe(200);
  });

  it("CASHIER inventory/lot/product/traceability GETs never expose cost keys", async () => {
    const { store, cashier } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 5 });
    const token = signTestToken(cashier);
    const app = createApp();
    const auth = { Authorization: `Bearer ${token}` };

    const paths = [
      "/products",
      "/inventory",
      `/products/${product.id}/lots`,
      `/inventory/${product.id}/lots`,
      "/lots",
      "/inventory/expiring?days=30",
      `/products/expiring?days=30`,
      `/traceability/lots/${product.id}/forward`,
      `/traceability/lots/${product.id}/genealogy`,
      "/traceability/backward?saleId=fake-sale-id",
      "/traceability/sales/fake-sale-id/backward",
      "/traceability/sale-items/fake-item-id/backward",
    ];

    for (const path of paths) {
      const res = await request(app).get(path).set(auth);
      const keys = collectKeys(res.body);
      for (const key of keys) {
        expect(key, `${path} leaked key "${key}"`).not.toMatch(COST_KEY);
      }
    }
  });
});
