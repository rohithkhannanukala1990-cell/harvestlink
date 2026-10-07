/**
 * Risk-based cycle-count scheduling: ABC classes, forced flags, velocity, caps, the open-count
 * overlap guard, and the daily job.
 */
import {
  LotStatus,
  PaymentMethod,
  Prisma,
  StockCountLineStatus,
  StockCountStatus,
  StockCountType,
  type Product,
  type User,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import { runScheduleCycleCountsOnce } from "../src/jobs/scheduleCycleCounts.js";
import { AuditAction } from "../src/lib/audit.js";
import * as membershipService from "../src/services/membership.service.js";
import * as salesService from "../src/services/sales.service.js";
import * as stockCountService from "../src/services/stockCount.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createProduct, seedCashierStore } from "./helpers/factories.js";

const DAY = 24 * 60 * 60 * 1000;

/** An approved count of one product, started `daysAgo` days ago, with the given variance. */
async function recordApprovedCount(
  storeId: string,
  admin: User,
  product: Product,
  daysAgo: number,
  variance = 0,
): Promise<void> {
  const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });
  const startedAt = new Date(Date.now() - daysAgo * DAY);
  await prisma.stockCount.create({
    data: {
      storeId,
      type: StockCountType.SPOT,
      status: StockCountStatus.COMPLETED,
      createdByUserId: admin.id,
      startedAt,
      completedAt: startedAt,
      approvedByUserId: admin.id,
      approvedAt: startedAt,
      lines: {
        create: {
          productId: product.id,
          lotId: lot.id,
          expectedQuantity: lot.quantityRemaining,
          countedQuantity: lot.quantityRemaining + variance,
          variance,
          status: StockCountLineStatus.COUNTED,
        },
      },
    },
  });
}

describe("cycle count schedule", () => {
  it("counts class A every cycle, flags variances and near-expiry, and leaves the rest for later", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    await membershipService.updateCooperativeSettings(asAuthUser(coopAdmin), {
      highValueThreshold: 100,
      cycleCountFrequencyDays: 30,
      cycleCountSize: 10,
    });

    const highNew = await createProduct(store.id, { sku: "HIGH-NEW", stock: 50, cost: 4 });
    const highRecent = await createProduct(store.id, { sku: "HIGH-RECENT", stock: 50, cost: 4 });
    const lowRecent = await createProduct(store.id, { sku: "LOW-RECENT", stock: 10, cost: 1 });
    const lowVariance = await createProduct(store.id, { sku: "LOW-VAR", stock: 10, cost: 1 });
    const lowOld = await createProduct(store.id, { sku: "LOW-OLD", stock: 10, cost: 1 });
    const onOpen = await createProduct(store.id, { sku: "ON-OPEN", stock: 10, cost: 1 });
    const expiring = await createProduct(store.id, { sku: "EXPIRING", stock: 0, skipLot: true });
    await prisma.lot.create({
      data: {
        lotNumber: "EXP-SOON",
        productId: expiring.id,
        storeId: store.id,
        quantityReceived: 5,
        quantityRemaining: 5,
        unitCost: new Prisma.Decimal(1),
        receivedAt: new Date(),
        expiryDate: new Date(Date.now() + 3 * DAY),
        status: LotStatus.ACTIVE,
      },
    });
    await prisma.product.update({ where: { id: expiring.id }, data: { stock: 5 } });

    await recordApprovedCount(store.id, storeAdmin, highRecent, 5);
    await recordApprovedCount(store.id, storeAdmin, lowRecent, 10);
    await recordApprovedCount(store.id, storeAdmin, lowVariance, 10, -1);
    await recordApprovedCount(store.id, storeAdmin, lowOld, 100);
    await recordApprovedCount(store.id, storeAdmin, expiring, 10);
    await stockCountService.createCount(asAuthUser(storeAdmin), store.id, StockCountType.SPOT, {
      productIds: [onOpen.id],
    });

    const schedule = await stockCountService.generateCycleCountSchedule(store.id);
    const bySku = new Map(schedule.selected.map((c) => [c.sku, c]));

    expect([...bySku.keys()].sort()).toEqual(
      ["EXPIRING", "HIGH-NEW", "HIGH-RECENT", "LOW-OLD", "LOW-VAR"].sort(),
    );
    expect(schedule.alreadyOnOpenCount).toBe(1);

    expect(bySku.get("HIGH-NEW")).toMatchObject({ abcClass: "A", valueOnHand: "200.00" });
    expect(bySku.get("HIGH-NEW")!.reasons).toEqual(["HIGH_VALUE", "NEVER_COUNTED"]);
    expect(bySku.get("HIGH-RECENT")!.reasons).toEqual(["HIGH_VALUE", "DUE"]);
    expect(bySku.get("LOW-VAR")!.reasons).toContain("VARIANCE_LAST_COUNT");
    expect(bySku.get("EXPIRING")!.reasons).toContain("NEAR_EXPIRY");
    expect(bySku.get("LOW-OLD")).toMatchObject({ abcClass: "C", reasons: ["DUE"] });

    const flaggedFirst = schedule.selected.slice(0, 2).map((c) => c.sku).sort();
    expect(flaggedFirst).toEqual(["EXPIRING", "LOW-VAR"]);
  });

  it("promotes fast sellers to class A and caps the count at cycleCountSize", async () => {
    const { store, cashier, storeAdmin, coopAdmin } = await seedCashierStore();
    await membershipService.updateCooperativeSettings(asAuthUser(coopAdmin), {
      highValueThreshold: 1000,
      cycleCountSize: 1,
    });
    const fast = await createProduct(store.id, { sku: "FAST", stock: 20, cost: 1, price: 2 });
    const slow = await createProduct(store.id, { sku: "SLOW", stock: 20, cost: 1 });
    await recordApprovedCount(store.id, storeAdmin, fast, 10);
    await recordApprovedCount(store.id, storeAdmin, slow, 200);

    await prisma.cashDrawer.create({
      data: { storeId: store.id, openedByUserId: storeAdmin.id, openingFloat: new Prisma.Decimal(50) },
    });
    await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: fast.id, quantity: 5 }],
      paymentMethod: PaymentMethod.CASH,
    });

    const schedule = await stockCountService.generateCycleCountSchedule(store.id);
    expect(schedule.selected).toHaveLength(1);
    expect(schedule.dueButDeferred).toBe(1);
    expect(schedule.selected[0]).toMatchObject({ sku: "FAST", abcClass: "A", unitsSold: 5 });
    expect(schedule.selected[0]!.reasons).toContain("HIGH_VELOCITY");
  });

  it("never puts a product on two open counts", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 10 });
    const admin = asAuthUser(storeAdmin);

    const first = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
      productIds: [product.id],
    });
    await expect(
      stockCountService.createCount(admin, store.id, StockCountType.SPOT, { productIds: [product.id] }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      stockCountService.createCount(admin, store.id, StockCountType.FULL),
    ).rejects.toMatchObject({ status: 409 });

    await stockCountService.cancelCount(admin, first.id, "replaced");
    const concurrent = await Promise.allSettled([
      stockCountService.createCount(admin, store.id, StockCountType.SPOT, { productIds: [product.id] }),
      stockCountService.createCount(admin, store.id, StockCountType.SPOT, { productIds: [product.id] }),
    ]);
    expect(concurrent.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const open = await prisma.stockCountLine.count({
      where: { productId: product.id, count: stockCountService.openCountWhere(store.id) },
    });
    expect(open).toBe(1);
  });

  it("the daily job drafts one system cycle count per store and respects the cadence", async () => {
    const { store, coopAdmin } = await seedCashierStore();
    await createProduct(store.id, { stock: 10 });
    await createProduct(store.id, { stock: 5 });

    const first = await runScheduleCycleCountsOnce();
    expect(first.createdCountIds).toHaveLength(1);

    const count = await prisma.stockCount.findUniqueOrThrow({
      where: { id: first.createdCountIds[0]! },
      include: { lines: true },
    });
    expect(count).toMatchObject({
      storeId: store.id,
      type: StockCountType.CYCLE,
      status: StockCountStatus.DRAFT,
      createdByUserId: null,
    });
    expect(count.lines).toHaveLength(2);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: AuditAction.STOCK_COUNT_CREATE, entityId: count.id },
    });
    expect(audit.userId).toBeNull();
    expect(audit.after).toMatchObject({ scheduledBy: "SYSTEM", lineCount: 2 });

    const again = await runScheduleCycleCountsOnce();
    expect(again.createdCountIds).toHaveLength(0);
    expect(again.skippedStoreIds).toContain(store.id);

    await prisma.stockCount.update({
      where: { id: count.id },
      data: { status: StockCountStatus.CANCELLED },
    });
    await membershipService.updateCooperativeSettings(asAuthUser(coopAdmin), {
      cycleCountEnabled: false,
    });
    const disabled = await runScheduleCycleCountsOnce();
    expect(disabled).toMatchObject({ enabled: false, createdCountIds: [] });
  });
});
