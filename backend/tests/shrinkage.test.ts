/**
 * Shrinkage report: folds write-offs (expiry, refund without restock, stock count), manual
 * adjustments and offline stock conflicts into one rate against sales at cost.
 */
import { LotStatus, PaymentMethod, Prisma, Role, type Store, type User } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { runExpireLotsOnce } from "../src/jobs/expireLots.js";
import * as inventoryService from "../src/services/inventory.service.js";
import * as salesService from "../src/services/sales.service.js";
import * as shrinkageService from "../src/services/shrinkage.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createProduct,
  createStore,
  createUser,
  seedCashierStore,
  signTestToken,
} from "./helpers/factories.js";

async function openDrawer(storeId: string, userId: string): Promise<void> {
  await prisma.cashDrawer.create({
    data: { storeId, openedByUserId: userId, openingFloat: new Prisma.Decimal(100) },
  });
}

async function cashSale(store: Store, cashier: User, productId: string, quantity: number) {
  const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
    items: [{ productId, quantity }],
    paymentMethod: PaymentMethod.CASH,
  });
  return sale;
}

/**
 * Store A: $40 sales at cost and $21 of losses from four sources. Store B: $10 sales, no losses.
 */
async function seedNetwork() {
  const { store, cashier, storeAdmin, coopAdmin } = await seedCashierStore();
  await openDrawer(store.id, storeAdmin.id);
  const fpo = await prisma.supplier.create({ data: { name: "Hill Farmers FPO" } });

  const produce = await createProduct(store.id, { sku: "PRODUCE", stock: 0, cost: 2, price: 5, skipLot: true });
  const produceLot = await prisma.lot.create({
    data: {
      lotNumber: "HILL-1",
      productId: produce.id,
      storeId: store.id,
      supplierId: fpo.id,
      quantityReceived: 40,
      quantityRemaining: 40,
      unitCost: new Prisma.Decimal(2),
      receivedAt: new Date(),
      status: LotStatus.ACTIVE,
    },
  });
  await prisma.product.update({ where: { id: produce.id }, data: { stock: 40 } });

  // $40 at cost sold and kept; $4 sold then refunded without restock (cost nets out, loss stays).
  const firstSale = await cashSale(store, cashier, produce.id, 20);
  const returned = await cashSale(store, cashier, produce.id, 2);
  await salesService.refundSale(returned.id, store.id, { restock: false });

  // Expiry job: 4 units at $3 in a lot with no supplier, category Dairy.
  const dairy = await createProduct(store.id, { sku: "DAIRY", stock: 0, cost: 3, skipLot: true });
  await prisma.product.update({ where: { id: dairy.id }, data: { category: "Dairy", stock: 4 } });
  await prisma.lot.create({
    data: {
      lotNumber: "MILK-OLD",
      productId: dairy.id,
      storeId: store.id,
      quantityReceived: 4,
      quantityRemaining: 4,
      unitCost: new Prisma.Decimal(3),
      receivedAt: new Date("2019-12-01"),
      expiryDate: new Date("2020-01-01"),
      status: LotStatus.ACTIVE,
    },
  });
  await runExpireLotsOnce(new Date());

  // Stock count shortfall, already valued on the row.
  await prisma.inventoryWriteOff.create({
    data: {
      storeId: store.id,
      productId: produce.id,
      lotId: produceLot.id,
      quantity: 1,
      reason: "STOCK_COUNT:THEFT_SUSPECTED",
      unitCost: new Prisma.Decimal(2),
      value: new Prisma.Decimal(2),
    },
  });

  // Manual adjustment: 2 units at product cost $1.50.
  const dry = await createProduct(store.id, { sku: "DRY", stock: 10, cost: 1.5 });
  await inventoryService.adjustStock(dry.id, store.id, asAuthUser(storeAdmin), {
    newStock: 8,
    reason: "Water damage",
  });

  // Offline conflict: 3 sold with 1 on the books — a signal, not a loss.
  await prisma.stockReconciliation.create({
    data: {
      storeId: store.id,
      saleId: firstSale.id,
      productId: produce.id,
      quantitySold: 3,
      stockBefore: 1,
      stockAfter: -2,
      reason: "OFFLINE_SALE_NEGATIVE_STOCK",
    },
  });

  const other = await createStore({ name: "Other Store" });
  const otherCashier = await createUser({ email: `other-${Date.now()}@test.local`, role: Role.CASHIER, storeId: other.id });
  const otherAdmin = await createUser({ email: `other-admin-${Date.now()}@test.local`, role: Role.STORE_ADMIN, storeId: other.id });
  await openDrawer(other.id, otherAdmin.id);
  const otherProduct = await createProduct(other.id, { stock: 10, cost: 1 });
  await cashSale(other, otherCashier, otherProduct.id, 10);

  return { store, storeAdmin, coopAdmin, cashier, other, fpo, produce, dairy, dry };
}

describe("shrinkage report", () => {
  it("folds every loss source into one rate against sales at cost", async () => {
    const { store, storeAdmin, fpo, dairy } = await seedNetwork();

    const report = await shrinkageService.getShrinkageReport(asAuthUser(storeAdmin), {});

    expect(report.storeId).toBe(store.id);
    expect(report.totals).toMatchObject({
      value: "21.00",
      units: 9,
      salesAtCost: "40.00",
      ratePercent: "52.50",
    });

    const reasons = Object.fromEntries(report.byReason.map((r) => [r.reason, r.value]));
    expect(reasons).toEqual({
      EXPIRY: "12.00",
      RETURNED_NOT_RESTOCKED: "4.00",
      MANUAL_ADJUSTMENT: "3.00",
      THEFT_SUSPECTED: "2.00",
    });
    const sources = Object.fromEntries(report.bySource.map((s) => [s.source, s.units]));
    expect(sources).toEqual({ EXPIRY_JOB: 4, REFUND_NO_RESTOCK: 2, MANUAL_ADJUSTMENT: 2, STOCK_COUNT: 1 });

    const hill = report.bySupplier.find((s) => s.supplierId === fpo.id)!;
    expect(hill).toMatchObject({ value: "6.00", salesAtCost: "40.00", ratePercent: "15.00" });
    expect(report.bySupplier.find((s) => s.supplierId === null)!.value).toBe("15.00");

    expect(report.byCategory.find((c) => c.category === "Dairy")!.value).toBe("12.00");
    expect(report.topLossProducts[0]!.productId).toBe(dairy.id);
    expect(report.byLot.map((l) => l.lotNumber).sort()).toEqual(["HILL-1", "MILK-OLD"]);

    const trendValue = report.trend.reduce((s, b) => s + Number(b.value), 0);
    expect(trendValue).toBeCloseTo(21, 2);
    expect(report.granularity).toBe("day");

    expect(report.comparison).toMatchObject({
      storeRatePercent: "52.50",
      networkRatePercent: "42.00",
      stores: [],
    });

    expect(report.offlineStockConflicts).toMatchObject({ rows: 1, open: 1, unitsOversold: 2 });
    expect(report.totals.value).toBe("21.00");
  });

  it("gives COOP_ADMIN the network and every store, highest rate first", async () => {
    const { store, coopAdmin, other } = await seedNetwork();

    const network = await shrinkageService.getShrinkageReport(asAuthUser(coopAdmin), {});
    expect(network.storeId).toBeNull();
    expect(network.totals).toMatchObject({ value: "21.00", salesAtCost: "50.00", ratePercent: "42.00" });
    expect(network.comparison.stores.map((s) => s.storeId)).toEqual([store.id, other.id]);
    expect(network.comparison.stores[1]).toMatchObject({ value: "0.00", ratePercent: "0.00" });
  });

  it("scopes by role over HTTP", async () => {
    const { storeAdmin, cashier, other } = await seedNetwork();
    const app = createApp();

    const own = await request(app)
      .get("/reports/shrinkage")
      .set({ Authorization: `Bearer ${signTestToken(storeAdmin)}` });
    expect(own.status).toBe(200);
    expect(own.body.totals.ratePercent).toBe("52.50");

    const foreign = await request(app)
      .get(`/reports/shrinkage?storeId=${other.id}`)
      .set({ Authorization: `Bearer ${signTestToken(storeAdmin)}` });
    expect(foreign.status).toBe(403);

    const asCashier = await request(app)
      .get("/reports/shrinkage")
      .set({ Authorization: `Bearer ${signTestToken(cashier)}` });
    expect(asCashier.status).toBe(403);

    const tooLong = await request(app)
      .get("/reports/shrinkage?from=2024-01-01&to=2026-01-01")
      .set({ Authorization: `Bearer ${signTestToken(storeAdmin)}` });
    expect(tooLong.status).toBe(400);
  });
});
