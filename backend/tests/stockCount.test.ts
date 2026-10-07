/**
 * Stock count workflow: blind counting, recount routing, mid-count sales, approval side effects,
 * and the QUARANTINED / RECALLED override.
 */
import {
  LotStatus,
  PaymentMethod,
  Prisma,
  Role,
  ShrinkageReason,
  StockCountLineStatus,
  StockCountStatus,
  StockCountType,
  type Product,
} from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuditAction } from "../src/lib/audit.js";
import * as membershipService from "../src/services/membership.service.js";
import * as salesService from "../src/services/sales.service.js";
import * as stockCountService from "../src/services/stockCount.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createProduct,
  createStore,
  createUser,
  seedCashierStore,
  signTestToken,
} from "./helpers/factories.js";

const FORBIDDEN_COUNTER_FIELDS = [
  "expectedQuantity",
  "expectedAtCount",
  "variance",
  "varianceValue",
  "movementDuringCount",
  "soldDuringCount",
  "countedQuantity",
  "recountedQuantity",
];

async function expectRollupInSync(product: Product): Promise<number> {
  const [after, sums] = await Promise.all([
    prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
    prisma.lot.aggregate({
      where: { productId: product.id, status: LotStatus.ACTIVE },
      _sum: { quantityRemaining: true },
    }),
  ]);
  expect(sums._sum.quantityRemaining ?? 0).toBe(after.stock);
  return after.stock;
}

async function lotFor(productId: string) {
  return prisma.lot.findFirstOrThrow({ where: { productId } });
}

async function openDrawer(storeId: string, userId: string): Promise<void> {
  await prisma.cashDrawer.create({
    data: { storeId, openedByUserId: userId, openingFloat: new Prisma.Decimal(100) },
  });
}

describe("stock counts", () => {
  it("never returns expected quantities to the counter, and only reviews COMPLETED counts", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 40 });
    const admin = asAuthUser(storeAdmin);

    const draft = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [product.id],
    });
    await stockCountService.startCount(admin, draft.id);

    const app = createApp();
    const counterAuth = { Authorization: `Bearer ${signTestToken(cashier)}` };
    const adminAuth = { Authorization: `Bearer ${signTestToken(storeAdmin)}` };

    const view = await request(app).get(`/stock-counts/${draft.id}`).set(counterAuth);
    expect(view.status).toBe(200);
    expect(view.body.lines).toHaveLength(1);
    const lineId = view.body.lines[0].id as string;

    const earlyReview = await request(app).get(`/stock-counts/${draft.id}/review`).set(adminAuth);
    expect(earlyReview.status).toBe(409);

    const submit = await request(app)
      .post(`/stock-counts/${draft.id}/lines/${lineId}/count`)
      .set(counterAuth)
      .send({ countedQuantity: 39 });
    expect(submit.status).toBe(200);
    expect(submit.body).toEqual({ lineId, status: StockCountLineStatus.COUNTED });

    const afterCount = await request(app).get(`/stock-counts/${draft.id}`).set(counterAuth);
    for (const body of [view.body, submit.body, afterCount.body]) {
      const json = JSON.stringify(body);
      for (const field of FORBIDDEN_COUNTER_FIELDS) {
        expect(json).not.toContain(`"${field}"`);
      }
    }

    const cashierReview = await request(app)
      .get(`/stock-counts/${draft.id}/review`)
      .set(counterAuth);
    expect(cashierReview.status).toBe(403);

    await request(app).post(`/stock-counts/${draft.id}/complete`).set(counterAuth).expect(200);
    const review = await request(app).get(`/stock-counts/${draft.id}/review`).set(adminAuth);
    expect(review.status).toBe(200);
    expect(review.body.lines[0].expectedQuantity).toBe(40);
    expect(review.body.lines[0].variance).toBe(-1);

    const cashierApprove = await request(app)
      .post(`/stock-counts/${draft.id}/approve`)
      .set(counterAuth)
      .send({});
    expect(cashierApprove.status).toBe(403);
  });

  it("requires a recount over the threshold, by a different person when staff allow", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 40, cost: 4 });
    const admin = asAuthUser(storeAdmin);

    const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [product.id],
    });
    await stockCountService.startCount(admin, count.id);
    const lineId = count.lines[0]!.id;

    const first = await stockCountService.submitCountLine(asAuthUser(cashier), count.id, lineId, 30);
    expect(first.status).toBe(StockCountLineStatus.RECOUNT_REQUIRED);

    await expect(stockCountService.completeCount(admin, count.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      stockCountService.submitCountLine(asAuthUser(cashier), count.id, lineId, 31),
    ).rejects.toMatchObject({ status: 409 });

    const counterView = await stockCountService.getCountForCounter(asAuthUser(cashier), count.id);
    expect(counterView.lines[0]!.recountByAnotherPerson).toBe(true);

    const recount = await stockCountService.submitCountLine(admin, count.id, lineId, 38);
    expect(recount.status).toBe(StockCountLineStatus.RESOLVED);

    await stockCountService.completeCount(admin, count.id);
    const review = await stockCountService.getCountForReview(admin, count.id);
    expect(review.lines[0]).toMatchObject({
      countedQuantity: 30,
      countedByUserId: cashier.id,
      recountedQuantity: 38,
      recountedByUserId: storeAdmin.id,
      finalCountedQuantity: 38,
      variance: -2,
    });
  });

  it("lets the same person recount when nobody else on staff can", async () => {
    const store = await createStore();
    const soloAdmin = await createUser({
      email: `solo-${Date.now()}@test.local`,
      role: Role.STORE_ADMIN,
      storeId: store.id,
    });
    const product = await createProduct(store.id, { stock: 10, cost: 4 });
    const actor = asAuthUser(soloAdmin);

    const count = await stockCountService.createCount(actor, store.id, StockCountType.SPOT, {
      productIds: [product.id],
    });
    await stockCountService.startCount(actor, count.id);
    const lineId = count.lines[0]!.id;

    expect((await stockCountService.submitCountLine(actor, count.id, lineId, 2)).status).toBe(
      StockCountLineStatus.RECOUNT_REQUIRED,
    );
    expect((await stockCountService.submitCountLine(actor, count.id, lineId, 3)).status).toBe(
      StockCountLineStatus.RESOLVED,
    );

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: AuditAction.STOCK_COUNT_LINE_COUNT, entityId: lineId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.after).toMatchObject({ recount: true, sameCounterRecount: true });
  });

  it("accounts for sales during the count and applies the variance as a delta", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 40, cost: 4, price: 10 });
    const admin = asAuthUser(storeAdmin);
    await openDrawer(store.id, storeAdmin.id);

    const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [product.id],
    });
    await stockCountService.startCount(admin, count.id);
    const lineId = count.lines[0]!.id;

    // 3 sold after the snapshot but before the shelf was counted.
    await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 3 }],
      paymentMethod: PaymentMethod.CASH,
    });

    // 37 should be on the shelf; the counter finds 36 — one genuinely missing, not four.
    const result = await stockCountService.submitCountLine(asAuthUser(cashier), count.id, lineId, 36);
    expect(result.status).toBe(StockCountLineStatus.COUNTED);

    // 2 more sold after this shelf was counted, before approval.
    await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: PaymentMethod.CASH,
    });

    await stockCountService.completeCount(asAuthUser(cashier), count.id);
    const review = await stockCountService.getCountForReview(admin, count.id);
    expect(review.lines[0]).toMatchObject({
      expectedQuantity: 40,
      soldDuringCount: 3,
      movementDuringCount: 3,
      expectedAtCount: 37,
      finalCountedQuantity: 36,
      variance: -1,
    });

    await stockCountService.approveCount(admin, count.id);

    // 40 − 3 − 2 sold − 1 missing. Overwriting with the counted 36 would resurrect the 2 later sales.
    const lot = await lotFor(product.id);
    expect(lot.quantityRemaining).toBe(34);
    expect(await expectRollupInSync(product)).toBe(34);

    const writeOffs = await prisma.inventoryWriteOff.findMany({ where: { lotId: lot.id } });
    expect(writeOffs).toHaveLength(1);
    expect(writeOffs[0]!.quantity).toBe(1);
  });

  it("approves in one pass: lot, rollup, StockAdjustment, valued write-off and audit", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const short = await createProduct(store.id, { stock: 20, cost: 2.5 });
    const over = await createProduct(store.id, { stock: 10, cost: 3 });
    const admin = asAuthUser(storeAdmin);

    const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [short.id, over.id],
    });
    await stockCountService.startCount(admin, count.id);
    const shortLine = count.lines.find((l) => l.productId === short.id)!;
    const overLine = count.lines.find((l) => l.productId === over.id)!;

    await stockCountService.submitCountLine(asAuthUser(cashier), count.id, shortLine.id, 18);
    await stockCountService.submitCountLine(asAuthUser(cashier), count.id, overLine.id, 11);
    await stockCountService.completeCount(asAuthUser(cashier), count.id);

    const approved = await stockCountService.approveCount(admin, count.id, {
      reasons: { [shortLine.id]: ShrinkageReason.DAMAGE },
    });
    expect(approved.approvedByUserId).toBe(storeAdmin.id);
    expect(approved.totals).toMatchObject({
      linesWithVariance: 2,
      shrinkageValue: "5.00",
      overageValue: "3.00",
      netVarianceValue: "-2.00",
    });

    expect(await expectRollupInSync(short)).toBe(18);
    expect(await expectRollupInSync(over)).toBe(11);

    const shortAdj = await prisma.stockAdjustment.findFirstOrThrow({ where: { productId: short.id } });
    expect(shortAdj).toMatchObject({ previousStock: 20, newStock: 18, delta: -2, reason: "STOCK_COUNT:DAMAGE" });
    const overAdj = await prisma.stockAdjustment.findFirstOrThrow({ where: { productId: over.id } });
    expect(overAdj).toMatchObject({ delta: 1, reason: "STOCK_COUNT:UNKNOWN" });

    const writeOffs = await prisma.inventoryWriteOff.findMany({ where: { storeId: store.id } });
    expect(writeOffs).toHaveLength(1);
    expect(writeOffs[0]).toMatchObject({ productId: short.id, quantity: 2, reason: "STOCK_COUNT:DAMAGE" });
    expect(writeOffs[0]!.unitCost?.toFixed(2)).toBe("2.50");
    expect(writeOffs[0]!.value?.toFixed(2)).toBe("5.00");

    const lines = await prisma.stockCountLine.findMany({ where: { countId: count.id } });
    expect(lines.find((l) => l.id === shortLine.id)!.reasonCode).toBe(ShrinkageReason.DAMAGE);
    expect(lines.find((l) => l.id === overLine.id)!.reasonCode).toBe(ShrinkageReason.UNKNOWN);

    expect(
      await prisma.auditLog.count({
        where: { action: AuditAction.STOCK_COUNT_APPROVE, entityId: count.id },
      }),
    ).toBe(1);

    await expect(stockCountService.approveCount(admin, count.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("refuses to adjust a QUARANTINED lot without an explicit override", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 0, cost: 2, skipLot: true });
    const lot = await prisma.lot.create({
      data: {
        lotNumber: "Q-1",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 5,
        quantityRemaining: 5,
        unitCost: new Prisma.Decimal(2),
        receivedAt: new Date(),
        status: LotStatus.QUARANTINED,
      },
    });
    const admin = asAuthUser(storeAdmin);

    const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      lotIds: [lot.id],
    });
    await stockCountService.startCount(admin, count.id);
    await stockCountService.submitCountLine(asAuthUser(cashier), count.id, count.lines[0]!.id, 3);
    await stockCountService.submitCountLine(admin, count.id, count.lines[0]!.id, 3);
    await stockCountService.completeCount(admin, count.id);

    await expect(stockCountService.approveCount(admin, count.id)).rejects.toMatchObject({
      status: 409,
    });
    expect((await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } })).quantityRemaining).toBe(5);
    expect((await prisma.stockCount.findUniqueOrThrow({ where: { id: count.id } })).approvedAt).toBeNull();

    await expect(
      stockCountService.approveCount(admin, count.id, { overrideBlockedLots: true }),
    ).rejects.toMatchObject({ status: 400 });

    await stockCountService.approveCount(admin, count.id, {
      overrideBlockedLots: true,
      overrideReason: "Recall disposal count before destruction",
    });

    const after = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(after.quantityRemaining).toBe(3);
    expect(after.status).toBe(LotStatus.QUARANTINED);
    expect(await expectRollupInSync(product)).toBe(0);

    const override = await prisma.auditLog.findFirstOrThrow({
      where: { action: AuditAction.STOCK_COUNT_BLOCKED_LOT_OVERRIDE, entityId: lot.id },
    });
    expect(override.after).toMatchObject({
      quantityRemaining: 3,
      overrideReason: "Recall disposal count before destruction",
    });
    const writeOff = await prisma.inventoryWriteOff.findFirstOrThrow({ where: { lotId: lot.id } });
    expect(writeOff.quantity).toBe(2);
  });

  it("CYCLE createCount uses the risk schedule and skips products on open counts", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    await membershipService.updateCooperativeSettings(asAuthUser(coopAdmin), { cycleCountSize: 2 });
    const cheap = await createProduct(store.id, { stock: 10, cost: 1 });
    const dear = await createProduct(store.id, { stock: 10, cost: 9 });
    const counted = await createProduct(store.id, { stock: 10, cost: 50 });
    const admin = asAuthUser(storeAdmin);

    await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [counted.id],
    });

    const cycle = await stockCountService.createCount(admin, store.id, StockCountType.CYCLE);
    expect(cycle.status).toBe(StockCountStatus.DRAFT);
    expect(cycle.lines.map((l) => l.productId).sort()).toEqual([cheap.id, dear.id].sort());
  });
});
