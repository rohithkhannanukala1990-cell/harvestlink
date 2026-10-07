/**
 * Stock count guarantees, one test per rule:
 * 1. counting endpoints never show a counter the expected quantity
 * 2. approval adjusts lots and keeps Product.stock equal to the ACTIVE lot rollup (verify:stock)
 * 3. sales during a count are accounted for, not counted as shrinkage
 * 4. a variance over the threshold forces a recount instead of approval
 * 5. a negative variance writes an InventoryWriteOff valued at the lot's unit cost
 * 6. a QUARANTINED lot is not adjusted without an explicit override
 * 7. the shrinkage rate is losses at cost over sales at cost
 * 8. cycle counts prioritise high-value and high-velocity products
 */
import {
  LotStatus,
  PaymentMethod,
  Prisma,
  ShrinkageReason,
  StockCountLineStatus,
  StockCountStatus,
  StockCountType,
  type Product,
  type Store,
  type User,
} from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuditAction } from "../src/lib/audit.js";
import { findStockRollupMismatches } from "../src/lib/stockInvariant.js";
import * as membershipService from "../src/services/membership.service.js";
import * as salesService from "../src/services/sales.service.js";
import * as shrinkageService from "../src/services/shrinkage.service.js";
import * as stockCountService from "../src/services/stockCount.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createProduct, seedCashierStore, signTestToken } from "./helpers/factories.js";

const DAY = 24 * 60 * 60 * 1000;

const FORBIDDEN_COUNTER_KEYS = new Set([
  "expectedQuantity",
  "expectedAtCount",
  "quantityAtCount",
  "variance",
  "varianceValue",
  "movementDuringCount",
  "soldDuringCount",
  "countedQuantity",
  "recountedQuantity",
  "finalCountedQuantity",
  "quantityRemaining",
  "stock",
]);

/** Every key path in a JSON body, and every number in it. */
function walk(value: unknown, path: string, keys: string[], numbers: number[]): void {
  if (typeof value === "number") numbers.push(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, keys, numbers));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.push(`${path}.${k}`);
      walk(v, `${path}.${k}`, keys, numbers);
    }
  }
}

async function openDrawer(store: Store, user: User): Promise<void> {
  await prisma.cashDrawer.create({
    data: { storeId: store.id, openedByUserId: user.id, openingFloat: new Prisma.Decimal(100) },
  });
}

async function sell(store: Store, cashier: User, productId: string, quantity: number): Promise<void> {
  await salesService.createSale(store.id, asAuthUser(cashier), {
    items: [{ productId, quantity }],
    paymentMethod: PaymentMethod.CASH,
  });
}

async function addLot(
  product: Product,
  input: { lotNumber: string; quantity: number; unitCost: number; status?: LotStatus },
) {
  const status = input.status ?? LotStatus.ACTIVE;
  const lot = await prisma.lot.create({
    data: {
      lotNumber: input.lotNumber,
      productId: product.id,
      storeId: product.storeId,
      quantityReceived: input.quantity,
      quantityRemaining: input.quantity,
      unitCost: new Prisma.Decimal(input.unitCost),
      receivedAt: new Date(),
      status,
    },
  });
  if (status === LotStatus.ACTIVE) {
    await prisma.product.update({
      where: { id: product.id },
      data: { stock: { increment: input.quantity } },
    });
  }
  return lot;
}

async function setThresholds(coopAdmin: User, percent: number, value: number): Promise<void> {
  await membershipService.updateCooperativeSettings(asAuthUser(coopAdmin), {
    varianceThresholdPercent: percent,
    varianceThresholdValue: value,
  });
}

async function expectStockInvariant(storeId: string): Promise<void> {
  const { checked, mismatches } = await findStockRollupMismatches({ storeId });
  expect(checked).toBeGreaterThan(0);
  expect(mismatches).toEqual([]);
}

function lineFor(count: stockCountService.CounterCountView, lotId: string) {
  return count.lines.find((l) => l.lotId === lotId)!;
}

/** An approved count of one product `daysAgo` days ago, with no variance. */
async function recordApprovedCount(storeId: string, admin: User, product: Product, daysAgo: number) {
  const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });
  const at = new Date(Date.now() - daysAgo * DAY);
  await prisma.stockCount.create({
    data: {
      storeId,
      type: StockCountType.SPOT,
      status: StockCountStatus.COMPLETED,
      createdByUserId: admin.id,
      startedAt: at,
      completedAt: at,
      approvedByUserId: admin.id,
      approvedAt: at,
      lines: {
        create: {
          productId: product.id,
          lotId: lot.id,
          expectedQuantity: lot.quantityRemaining,
          countedQuantity: lot.quantityRemaining,
          variance: 0,
          status: StockCountLineStatus.COUNTED,
        },
      },
    },
  });
}

describe("stock count service", () => {
  it("1. counting endpoints never return the expected quantity to a counter", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    // An unmistakable quantity: if 4321 (or the variance against it) shows up anywhere, it leaked.
    const product = await createProduct(store.id, { sku: "BLIND-1", stock: 4321, cost: 1 });
    const admin = asAuthUser(storeAdmin);
    const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [product.id],
    });
    await stockCountService.startCount(admin, count.id);
    const lineId = count.lines[0]!.id;

    const app = createApp();
    const asCashier = { Authorization: `Bearer ${signTestToken(cashier)}` };
    const asAdmin = { Authorization: `Bearer ${signTestToken(storeAdmin)}` };
    const bodies: Array<{ endpoint: string; body: unknown }> = [];
    const record = (endpoint: string, res: request.Response) => {
      expect(res.status, endpoint).toBe(200);
      bodies.push({ endpoint, body: res.body });
      return res;
    };

    record("GET /stock-counts", await request(app).get(`/stock-counts?storeId=${store.id}`).set(asCashier));
    record("GET /stock-counts/:id", await request(app).get(`/stock-counts/${count.id}`).set(asCashier));
    record("GET /barcodes/lookup", await request(app).get(`/barcodes/lookup?code=BLIND-1`).set(asCashier));

    const first = record(
      "POST count (first)",
      await request(app)
        .post(`/stock-counts/${count.id}/lines/${lineId}/count`)
        .set(asCashier)
        .send({ countedQuantity: 4000, idempotencyKey: "blind-first-0001" }),
    );
    expect(first.body.status).toBe(StockCountLineStatus.RECOUNT_REQUIRED);
    record(
      "POST count (replay)",
      await request(app)
        .post(`/stock-counts/${count.id}/lines/${lineId}/count`)
        .set(asCashier)
        .send({ countedQuantity: 4000, idempotencyKey: "blind-first-0001" }),
    );
    record("GET /stock-counts/:id (recount due)", await request(app).get(`/stock-counts/${count.id}`).set(asCashier));
    // The admin is counting here too, so the counting endpoints are blind for them as well.
    record(
      "POST count (recount)",
      await request(app)
        .post(`/stock-counts/${count.id}/lines/${lineId}/count`)
        .set(asAdmin)
        .send({ countedQuantity: 4310 }),
    );
    record("POST complete", await request(app).post(`/stock-counts/${count.id}/complete`).set(asCashier));
    record("GET /stock-counts/:id (completed)", await request(app).get(`/stock-counts/${count.id}`).set(asCashier));

    const leakedNumbers = new Set([4321, 4000, 4310, -321, 321, -11, 11]);
    for (const { endpoint, body } of bodies) {
      const keys: string[] = [];
      const numbers: number[] = [];
      walk(body, "$", keys, numbers);
      const leakedKeys = keys.filter((k) => FORBIDDEN_COUNTER_KEYS.has(k.split(".").at(-1)!));
      expect(leakedKeys, endpoint).toEqual([]);
      expect(numbers.filter((n) => leakedNumbers.has(n)), endpoint).toEqual([]);
    }

    for (const [method, path] of [
      ["get", `/stock-counts/${count.id}/review`],
      ["post", `/stock-counts/${count.id}/approve`],
      ["get", `/stock-counts/schedule-preview?storeId=${store.id}`],
    ] as const) {
      const res = await request(app)[method](path).set(asCashier).send({});
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(403);
    }

    const review = await request(app).get(`/stock-counts/${count.id}/review`).set(asAdmin);
    expect(review.body.lines[0]).toMatchObject({ expectedQuantity: 4321, finalCountedQuantity: 4310 });
  });

  it("2. approval adjusts lot quantities and keeps Product.stock equal to the ACTIVE lot rollup", async () => {
    const { store, cashier, storeAdmin, coopAdmin } = await seedCashierStore();
    await setThresholds(coopAdmin, 100, 1000);
    const product = await createProduct(store.id, { stock: 0, cost: 2, skipLot: true });
    const lotA = await addLot(product, { lotNumber: "A", quantity: 12, unitCost: 2 });
    const lotB = await addLot(product, { lotNumber: "B", quantity: 8, unitCost: 2 });
    const lotC = await addLot(product, { lotNumber: "C", quantity: 3, unitCost: 2 });
    const untouched = await createProduct(store.id, { stock: 7, cost: 1 });
    const admin = asAuthUser(storeAdmin);

    const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [product.id, untouched.id],
    });
    await stockCountService.startCount(admin, count.id);
    const counter = asAuthUser(cashier);
    await stockCountService.submitCountLine(counter, count.id, lineFor(count, lotA.id).id, 11);
    await stockCountService.submitCountLine(counter, count.id, lineFor(count, lotB.id).id, 9);
    await stockCountService.submitCountLine(counter, count.id, lineFor(count, lotC.id).id, 0);
    const untouchedLot = await prisma.lot.findFirstOrThrow({ where: { productId: untouched.id } });
    await stockCountService.submitCountLine(counter, count.id, lineFor(count, untouchedLot.id).id, 7);
    await stockCountService.completeCount(counter, count.id);

    await stockCountService.approveCount(admin, count.id);

    const lots = new Map(
      (await prisma.lot.findMany({ where: { productId: product.id } })).map((l) => [l.lotNumber, l]),
    );
    expect(lots.get("A")).toMatchObject({ quantityRemaining: 11, status: LotStatus.ACTIVE });
    expect(lots.get("B")).toMatchObject({ quantityRemaining: 9, status: LotStatus.ACTIVE });
    expect(lots.get("C")).toMatchObject({ quantityRemaining: 0, status: LotStatus.DEPLETED });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(20);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: untouched.id } })).stock).toBe(7);

    const adjustments = await prisma.stockAdjustment.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: "asc" },
    });
    expect(adjustments.map((a) => a.delta).sort()).toEqual([-1, -3, 1].sort());
    expect(adjustments.reduce((s, a) => s + a.delta, 0)).toBe(20 - 23);
    expect(await prisma.stockAdjustment.count({ where: { productId: untouched.id } })).toBe(0);

    await expectStockInvariant(store.id);
  });

  it("3. sales during a count are accounted for, not counted as shrinkage", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    await openDrawer(store, storeAdmin);
    const product = await createProduct(store.id, { stock: 50, cost: 2, price: 5 });
    const admin = asAuthUser(storeAdmin);
    const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [product.id],
    });
    await stockCountService.startCount(admin, count.id);

    await sell(store, cashier, product.id, 5);
    // The shelf is exactly right: 50 frozen at start − 5 sold = 45 counted.
    const result = await stockCountService.submitCountLine(
      asAuthUser(cashier),
      count.id,
      count.lines[0]!.id,
      45,
    );
    expect(result.status).toBe(StockCountLineStatus.COUNTED);
    await sell(store, cashier, product.id, 3);
    await stockCountService.completeCount(asAuthUser(cashier), count.id);

    const review = await stockCountService.getCountForReview(admin, count.id);
    expect(review.lines[0]).toMatchObject({
      expectedQuantity: 50,
      soldDuringCount: 5,
      expectedAtCount: 45,
      finalCountedQuantity: 45,
      variance: 0,
    });
    expect(review.totals).toMatchObject({ linesWithVariance: 0, shrinkageValue: "0.00" });

    await stockCountService.approveCount(admin, count.id);
    const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });
    expect(lot.quantityRemaining).toBe(42);
    expect(await prisma.inventoryWriteOff.count({ where: { storeId: store.id } })).toBe(0);
    expect(await prisma.stockAdjustment.count({ where: { productId: product.id } })).toBe(0);

    const report = await shrinkageService.getShrinkageReport(admin, {});
    expect(report.totals).toMatchObject({ value: "0.00", units: 0, salesAtCost: "16.00", ratePercent: "0.00" });
    await expectStockInvariant(store.id);
  });

  it("4. a variance over the threshold requires a recount instead of approval", async () => {
    const { store, cashier, storeAdmin, coopAdmin } = await seedCashierStore();
    await setThresholds(coopAdmin, 10, 25);
    const small = await createProduct(store.id, { sku: "SMALL", stock: 100, cost: 1 });
    const byPercent = await createProduct(store.id, { sku: "PCT", stock: 100, cost: 1 });
    const byValue = await createProduct(store.id, { sku: "VALUE", stock: 100, cost: 20 });
    const admin = asAuthUser(storeAdmin);
    const counter = asAuthUser(cashier);

    const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [small.id, byPercent.id, byValue.id],
    });
    await stockCountService.startCount(admin, count.id);
    const line = (p: Product) => count.lines.find((l) => l.productId === p.id)!.id;

    // 5% and $5: inside both thresholds.
    expect((await stockCountService.submitCountLine(counter, count.id, line(small), 95)).status).toBe(
      StockCountLineStatus.COUNTED,
    );
    // 15%: over the percent threshold.
    expect((await stockCountService.submitCountLine(counter, count.id, line(byPercent), 85)).status).toBe(
      StockCountLineStatus.RECOUNT_REQUIRED,
    );
    // 2% but $40: over the value threshold.
    expect((await stockCountService.submitCountLine(counter, count.id, line(byValue), 98)).status).toBe(
      StockCountLineStatus.RECOUNT_REQUIRED,
    );

    await expect(stockCountService.completeCount(admin, count.id)).rejects.toMatchObject({ status: 409 });
    await expect(stockCountService.approveCount(admin, count.id)).rejects.toMatchObject({ status: 409 });
    expect((await prisma.stockCount.findUniqueOrThrow({ where: { id: count.id } })).approvedAt).toBeNull();
    for (const p of [small, byPercent, byValue]) {
      expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stock).toBe(100);
    }
    expect(await prisma.inventoryWriteOff.count({ where: { storeId: store.id } })).toBe(0);

    expect((await stockCountService.submitCountLine(admin, count.id, line(byPercent), 99)).status).toBe(
      StockCountLineStatus.RESOLVED,
    );
    expect((await stockCountService.submitCountLine(admin, count.id, line(byValue), 100)).status).toBe(
      StockCountLineStatus.RESOLVED,
    );
    await stockCountService.completeCount(admin, count.id);
    await stockCountService.approveCount(admin, count.id);

    // The recount, not the first count, is what gets applied.
    const stock = async (p: Product) => (await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stock;
    expect(await stock(small)).toBe(95);
    expect(await stock(byPercent)).toBe(99);
    expect(await stock(byValue)).toBe(100);
    await expectStockInvariant(store.id);
  });

  it("5. a negative variance writes an InventoryWriteOff valued at the lot's unit cost", async () => {
    const { store, cashier, storeAdmin, coopAdmin } = await seedCashierStore();
    await setThresholds(coopAdmin, 100, 1000);
    // Product cost is the current price; each lot keeps what it actually cost.
    const product = await createProduct(store.id, { stock: 0, cost: 9.99, skipLot: true });
    const oldLot = await addLot(product, { lotNumber: "OLD", quantity: 10, unitCost: 3.25 });
    const newLot = await addLot(product, { lotNumber: "NEW", quantity: 10, unitCost: 4.1 });
    const admin = asAuthUser(storeAdmin);

    const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [product.id],
    });
    await stockCountService.startCount(admin, count.id);
    const oldLine = lineFor(count, oldLot.id).id;
    await stockCountService.submitCountLine(asAuthUser(cashier), count.id, oldLine, 7);
    await stockCountService.submitCountLine(asAuthUser(cashier), count.id, lineFor(count, newLot.id).id, 12);
    await stockCountService.completeCount(admin, count.id);

    const approved = await stockCountService.approveCount(admin, count.id, {
      reasons: { [oldLine]: ShrinkageReason.THEFT_SUSPECTED },
    });
    expect(approved.totals).toMatchObject({
      shrinkageValue: "9.75",
      overageValue: "8.20",
      netVarianceValue: "-1.55",
    });

    const writeOffs = await prisma.inventoryWriteOff.findMany({ where: { storeId: store.id } });
    expect(writeOffs).toHaveLength(1);
    expect(writeOffs[0]).toMatchObject({
      lotId: oldLot.id,
      productId: product.id,
      quantity: 3,
      reason: "STOCK_COUNT:THEFT_SUSPECTED",
    });
    expect(writeOffs[0]!.unitCost?.toFixed(2)).toBe("3.25");
    expect(writeOffs[0]!.value?.toFixed(2)).toBe("9.75");
    await expectStockInvariant(store.id);
  });

  it("6. a QUARANTINED lot is not adjusted without an explicit override", async () => {
    const { store, cashier, storeAdmin, coopAdmin } = await seedCashierStore();
    await setThresholds(coopAdmin, 100, 1000);
    const held = await createProduct(store.id, { stock: 0, cost: 2, skipLot: true });
    const quarantined = await addLot(held, {
      lotNumber: "Q-1",
      quantity: 5,
      unitCost: 2,
      status: LotStatus.QUARANTINED,
    });
    const recalled = await addLot(held, {
      lotNumber: "R-1",
      quantity: 4,
      unitCost: 2,
      status: LotStatus.RECALLED,
    });
    const normal = await createProduct(store.id, { stock: 10, cost: 1 });
    const normalLot = await prisma.lot.findFirstOrThrow({ where: { productId: normal.id } });
    const admin = asAuthUser(storeAdmin);
    const counter = asAuthUser(cashier);

    const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      lotIds: [quarantined.id, recalled.id, normalLot.id],
    });
    await stockCountService.startCount(admin, count.id);
    await stockCountService.submitCountLine(counter, count.id, lineFor(count, quarantined.id).id, 3);
    // No variance on the recalled lot, so it needs no override.
    await stockCountService.submitCountLine(counter, count.id, lineFor(count, recalled.id).id, 4);
    await stockCountService.submitCountLine(counter, count.id, lineFor(count, normalLot.id).id, 9);
    await stockCountService.completeCount(admin, count.id);

    await expect(stockCountService.approveCount(admin, count.id)).rejects.toMatchObject({
      status: 409,
      details: { lines: [{ lotId: quarantined.id, status: LotStatus.QUARANTINED }] },
    });
    // Nothing was applied, not even the ordinary lot.
    expect((await prisma.lot.findUniqueOrThrow({ where: { id: quarantined.id } })).quantityRemaining).toBe(5);
    expect((await prisma.lot.findUniqueOrThrow({ where: { id: normalLot.id } })).quantityRemaining).toBe(10);
    expect(await prisma.inventoryWriteOff.count({ where: { storeId: store.id } })).toBe(0);
    expect((await prisma.stockCount.findUniqueOrThrow({ where: { id: count.id } })).approvedAt).toBeNull();

    await expect(
      stockCountService.approveCount(admin, count.id, { overrideBlockedLots: true }),
    ).rejects.toMatchObject({ status: 400 });

    await stockCountService.approveCount(admin, count.id, {
      overrideBlockedLots: true,
      overrideReason: "Counting quarantined stock before disposal",
    });
    const after = await prisma.lot.findUniqueOrThrow({ where: { id: quarantined.id } });
    expect(after).toMatchObject({ quantityRemaining: 3, status: LotStatus.QUARANTINED });
    // Blocked lots are outside the sellable rollup, so the held product's stock stays 0.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: held.id } })).stock).toBe(0);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: normal.id } })).stock).toBe(9);

    const overrides = await prisma.auditLog.findMany({
      where: { action: AuditAction.STOCK_COUNT_BLOCKED_LOT_OVERRIDE },
    });
    expect(overrides.map((a) => a.entityId)).toEqual([quarantined.id]);
    expect(overrides[0]!.after).toMatchObject({ overrideReason: "Counting quarantined stock before disposal" });
    await expectStockInvariant(store.id);
  });

  it("7. shrinkage rate is count losses at lot cost over sales at cost", async () => {
    const { store, cashier, storeAdmin, coopAdmin } = await seedCashierStore();
    await setThresholds(coopAdmin, 100, 1000);
    await openDrawer(store, storeAdmin);
    const product = await createProduct(store.id, { stock: 30, cost: 4, price: 10 });
    const admin = asAuthUser(storeAdmin);

    await sell(store, cashier, product.id, 20);

    const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [product.id],
    });
    await stockCountService.startCount(admin, count.id);
    const lineId = count.lines[0]!.id;
    await stockCountService.submitCountLine(asAuthUser(cashier), count.id, lineId, 8);
    await stockCountService.completeCount(admin, count.id);
    await stockCountService.approveCount(admin, count.id, { reasons: { [lineId]: ShrinkageReason.DAMAGE } });

    const report = await shrinkageService.getShrinkageReport(admin, {});
    // 2 missing × $4 = $8 lost against 20 sold × $4 = $80 at cost.
    expect(report.totals).toMatchObject({
      value: "8.00",
      units: 2,
      salesAtCost: "80.00",
      ratePercent: "10.00",
    });
    expect(Number(report.totals.value) / Number(report.totals.salesAtCost) * 100).toBeCloseTo(
      Number(report.totals.ratePercent),
      2,
    );
    expect(report.bySource).toEqual([expect.objectContaining({ source: "STOCK_COUNT", units: 2, value: "8.00" })]);
    expect(report.byReason).toEqual([expect.objectContaining({ reason: "DAMAGE", value: "8.00" })]);
  });

  describe("8. cycle count scheduling", () => {
    async function seedRiskMix() {
      const seeded = await seedCashierStore();
      const { store, cashier, storeAdmin, coopAdmin } = seeded;
      await membershipService.updateCooperativeSettings(asAuthUser(coopAdmin), {
        highValueThreshold: 500,
        cycleCountFrequencyDays: 30,
        cycleCountSize: 10,
      });
      await openDrawer(store, storeAdmin);
      const products = {
        // $1,000 on hand: class A by value.
        value: await createProduct(store.id, { sku: "VALUE", stock: 100, cost: 10 }),
        // Cheap, but the store's best seller: class A by velocity.
        fast: await createProduct(store.id, { sku: "FAST", stock: 40, cost: 1 }),
        slow1: await createProduct(store.id, { sku: "SLOW-1", stock: 20, cost: 1 }),
        slow2: await createProduct(store.id, { sku: "SLOW-2", stock: 20, cost: 1 }),
        idle: await createProduct(store.id, { sku: "IDLE", stock: 20, cost: 1 }),
      };
      await sell(store, cashier, products.fast.id, 15);
      await sell(store, cashier, products.slow1.id, 1);
      await sell(store, cashier, products.slow2.id, 1);
      return { ...seeded, products };
    }

    it("counts high-value and fast-selling products every cycle and leaves low-risk ones for later", async () => {
      const { store, storeAdmin, products } = await seedRiskMix();
      for (const p of Object.values(products)) {
        await recordApprovedCount(store.id, storeAdmin, p, 10);
      }

      const schedule = await stockCountService.generateCycleCountSchedule(store.id);
      const bySku = new Map(schedule.selected.map((c) => [c.sku, c]));

      // Counted 10 days ago: class A is due again this cycle; B and C are not.
      expect([...bySku.keys()].sort()).toEqual(["FAST", "VALUE"]);
      expect(bySku.get("VALUE")).toMatchObject({ abcClass: "A", valueOnHand: "1000.00" });
      expect(bySku.get("VALUE")!.reasons).toContain("HIGH_VALUE");
      expect(bySku.get("FAST")).toMatchObject({ abcClass: "A", unitsSold: 15 });
      expect(bySku.get("FAST")!.reasons).toContain("HIGH_VELOCITY");
    });

    it("ranks high-value and high-velocity products first when the count is capped", async () => {
      const { store, coopAdmin } = await seedRiskMix();
      await membershipService.updateCooperativeSettings(asAuthUser(coopAdmin), { cycleCountSize: 2 });

      // Nothing has been counted, so all five are due; only two fit.
      const schedule = await stockCountService.generateCycleCountSchedule(store.id);
      expect(schedule.selected.map((c) => c.sku).sort()).toEqual(["FAST", "VALUE"]);
      expect(schedule.dueButDeferred).toBe(3);

      const draft = await stockCountService.createCount(
        asAuthUser(coopAdmin),
        store.id,
        StockCountType.CYCLE,
      );
      const skus = await prisma.product.findMany({
        where: { id: { in: draft.lines.map((l) => l.productId) } },
        select: { sku: true },
      });
      expect(skus.map((p) => p.sku).sort()).toEqual(["FAST", "VALUE"]);
    });
  });
});
