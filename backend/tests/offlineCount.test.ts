/**
 * Offline count queue on the server side: idempotent replay, and placing a count queued offline at
 * the moment it was physically taken (with device clock skew corrected), not when it synced.
 */
import { PaymentMethod, Prisma, StockCountLineStatus, StockCountType } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuditAction } from "../src/lib/audit.js";
import * as salesService from "../src/services/sales.service.js";
import * as stockCountService from "../src/services/stockCount.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createProduct, seedCashierStore, signTestToken } from "./helpers/factories.js";

const HOUR = 60 * 60 * 1000;

/**
 * Skew correction is accurate to the request's transit time (here, the gap between building
 * sentAt and the server reading its clock). Leave clear air between the count and the sale.
 */
function pause(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startedCount(stock: number) {
  const seeded = await seedCashierStore();
  const product = await createProduct(seeded.store.id, { stock });
  await prisma.cashDrawer.create({
    data: { storeId: seeded.store.id, openedByUserId: seeded.storeAdmin.id, openingFloat: new Prisma.Decimal(100) },
  });
  const admin = asAuthUser(seeded.storeAdmin);
  const count = await stockCountService.createCount(admin, seeded.store.id, StockCountType.SPOT, {
    productIds: [product.id],
  });
  await stockCountService.startCount(admin, count.id);
  return { ...seeded, product, admin, countId: count.id, lineId: count.lines[0]!.id };
}

async function sell(storeId: string, cashier: Parameters<typeof asAuthUser>[0], productId: string, quantity: number) {
  await salesService.createSale(storeId, asAuthUser(cashier), {
    items: [{ productId, quantity }],
    paymentMethod: PaymentMethod.CASH,
  });
}

describe("offline count submissions", () => {
  it("replays a queued entry by idempotencyKey instead of recounting it", async () => {
    const { cashier, countId, lineId, store } = await startedCount(10);
    const counter = asAuthUser(cashier);

    const first = await stockCountService.submitCountLine(counter, countId, lineId, 10, null, {
      idempotencyKey: "device-entry-0001",
    });
    expect(first).toEqual({ lineId, status: StockCountLineStatus.COUNTED });

    // Response lost; the device sends the same entry again.
    const again = await stockCountService.submitCountLine(counter, countId, lineId, 10, null, {
      idempotencyKey: "device-entry-0001",
    });
    expect(again).toEqual({ lineId, status: StockCountLineStatus.COUNTED, replayed: true });

    // Without the key it is a second count of the same line, which is refused.
    await expect(stockCountService.submitCountLine(counter, countId, lineId, 10)).rejects.toMatchObject({
      status: 409,
    });

    const audits = await prisma.auditLog.count({
      where: { storeId: store.id, action: AuditAction.STOCK_COUNT_LINE_COUNT },
    });
    expect(audits).toBe(1);

    // Replays still succeed after the count has closed.
    await stockCountService.completeCount(counter, countId);
    const late = await stockCountService.submitCountLine(counter, countId, lineId, 10, null, {
      idempotencyKey: "device-entry-0001",
    });
    expect(late.replayed).toBe(true);
  });

  it("refuses a key that already belongs to another line", async () => {
    const seeded = await seedCashierStore();
    const a = await createProduct(seeded.store.id, { stock: 5 });
    const b = await createProduct(seeded.store.id, { stock: 5 });
    const admin = asAuthUser(seeded.storeAdmin);
    const count = await stockCountService.createCount(admin, seeded.store.id, StockCountType.SPOT, {
      productIds: [a.id, b.id],
    });
    await stockCountService.startCount(admin, count.id);
    const [lineA, lineB] = count.lines;
    const counter = asAuthUser(seeded.cashier);
    await stockCountService.submitCountLine(counter, count.id, lineA!.id, 5, null, { idempotencyKey: "shared-key-01" });
    await expect(
      stockCountService.submitCountLine(counter, count.id, lineB!.id, 5, null, { idempotencyKey: "shared-key-01" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("measures an offline count against the shelf as it was when counted, not when synced", async () => {
    const { cashier, storeAdmin, admin, product, countId, lineId, store } = await startedCount(40);

    const countedAt = new Date();
    await pause();
    // While the device is out of signal, the till sells 5 from the same lot.
    await sell(store.id, cashier, product.id, 5);

    // Counter found 40 at countedAt. Read against the live 35 that would look like 5 found.
    const app = createApp();
    const res = await request(app)
      .post(`/stock-counts/${countId}/lines/${lineId}/count`)
      .set({ Authorization: `Bearer ${signTestToken(cashier)}` })
      .send({
        countedQuantity: 40,
        idempotencyKey: "offline-entry-40",
        countedAt: countedAt.toISOString(),
        sentAt: new Date().toISOString(),
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(StockCountLineStatus.COUNTED);

    await stockCountService.completeCount(asAuthUser(storeAdmin), countId);
    const review = await stockCountService.getCountForReview(admin, countId);
    expect(review.lines[0]).toMatchObject({ expectedQuantity: 40, movementDuringCount: 0, variance: 0 });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: lineId, action: AuditAction.STOCK_COUNT_LINE_COUNT },
    });
    expect(audit.after).toMatchObject({ queuedOffline: true });
  });

  it("corrects the device's clock skew before placing the count", async () => {
    const { cashier, storeAdmin, admin, product, countId, lineId, store } = await startedCount(20);

    // The tablet's clock runs an hour fast.
    const physicalCount = new Date();
    await pause();
    await sell(store.id, cashier, product.id, 3);
    const deviceSentAt = new Date(Date.now() + HOUR);

    await stockCountService.submitCountLine(asAuthUser(cashier), countId, lineId, 20, null, {
      idempotencyKey: "skewed-device-1",
      countedAt: new Date(physicalCount.getTime() + HOUR),
      sentAt: deviceSentAt,
    });

    await stockCountService.completeCount(asAuthUser(storeAdmin), countId);
    const review = await stockCountService.getCountForReview(admin, countId);
    // Uncorrected, countedAt would be clamped to "now", the 3 sold after the count would be missed,
    // and 20 counted against 17 would read as a 3-unit overage.
    expect(review.lines[0]).toMatchObject({ variance: 0, movementDuringCount: 0, soldDuringCount: 0 });
  });
});
