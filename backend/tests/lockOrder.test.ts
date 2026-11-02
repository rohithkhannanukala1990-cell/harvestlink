/**
 * Lock-order races: createSale (Product → Lot) must not deadlock against stock-count approval,
 * recall quarantine, or the expiry job when they touch the same rows.
 *
 * Every pair runs in parallel 20 times. Outcomes may be success or a business AppError
 * (e.g. insufficient stock); never a Postgres deadlock (40P01) or a 500.
 */
import {
  LotStatus,
  PaymentMethod,
  Prisma,
  RecallSeverity,
  StockCountLineStatus,
  StockCountType,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import { runExpireLotsOnce } from "../src/jobs/expireLots.js";
import { AppError } from "../src/lib/errors.js";
import { isDeadlockError } from "../src/lib/locks.js";
import { findStockRollupMismatches } from "../src/lib/stockInvariant.js";
import * as membershipService from "../src/services/membership.service.js";
import * as recallService from "../src/services/recall.service.js";
import * as salesService from "../src/services/sales.service.js";
import * as stockCountService from "../src/services/stockCount.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createProduct, seedCashierStore } from "./helpers/factories.js";

const RUNS = 20;

async function openDrawer(storeId: string, userId: string): Promise<void> {
  await prisma.cashDrawer.create({
    data: { storeId, openedByUserId: userId, openingFloat: new Prisma.Decimal(50) },
  });
}

/** Two ACTIVE lots on one product — FEFO and lock ordering both care about multiple rows. */
async function productWithTwoLots(storeId: string, qtyEach: number) {
  const product = await createProduct(storeId, { stock: 0, cost: 2, price: 5, skipLot: true });
  const older = await prisma.lot.create({
    data: {
      lotNumber: `OLD-${product.sku}`,
      productId: product.id,
      storeId,
      quantityReceived: qtyEach,
      quantityRemaining: qtyEach,
      unitCost: new Prisma.Decimal(2),
      receivedAt: new Date("2024-01-01"),
      expiryDate: new Date("2026-06-01"),
      status: LotStatus.ACTIVE,
    },
  });
  const newer = await prisma.lot.create({
    data: {
      lotNumber: `NEW-${product.sku}`,
      productId: product.id,
      storeId,
      quantityReceived: qtyEach,
      quantityRemaining: qtyEach,
      unitCost: new Prisma.Decimal(2),
      receivedAt: new Date("2025-01-01"),
      expiryDate: new Date("2027-06-01"),
      status: LotStatus.ACTIVE,
    },
  });
  await prisma.product.update({
    where: { id: product.id },
    data: { stock: qtyEach * 2 },
  });
  return { product, older, newer };
}

async function expectStockOk(storeId: string): Promise<void> {
  const { mismatches } = await findStockRollupMismatches({ storeId });
  expect(mismatches).toEqual([]);
}

function assertRaceOutcome(results: PromiseSettledResult<unknown>[]): void {
  for (const result of results) {
    if (result.status === "fulfilled") continue;
    const err = result.reason;
    expect(isDeadlockError(err), `deadlock: ${String(err)}`).toBe(false);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBeLessThan(500);
  }
}

describe("lock order races", () => {
  it("createSale ∥ stock-count approval never deadlocks (20 runs)", async () => {
    for (let i = 0; i < RUNS; i++) {
      const { store, cashier, storeAdmin, coopAdmin } = await seedCashierStore();
      await membershipService.updateCooperativeSettings(asAuthUser(coopAdmin), {
        varianceThresholdPercent: 100,
        varianceThresholdValue: 10_000,
      });
      await openDrawer(store.id, storeAdmin.id);
      const { product, older } = await productWithTwoLots(store.id, 3);
      const admin = asAuthUser(storeAdmin);

      const count = await stockCountService.createCount(admin, store.id, StockCountType.SPOT, {
        lotIds: [older.id],
      });
      await stockCountService.startCount(admin, count.id);
      // Count short by 1 on the older lot so approval writes Lot then Product.stock.
      const counted = await stockCountService.submitCountLine(
        asAuthUser(cashier),
        count.id,
        count.lines[0]!.id,
        2,
      );
      expect(counted.status).toBe(StockCountLineStatus.COUNTED);
      await stockCountService.completeCount(admin, count.id);

      const results = await Promise.allSettled([
        salesService.createSale(store.id, asAuthUser(cashier), {
          items: [{ productId: product.id, quantity: 4 }],
          paymentMethod: PaymentMethod.CASH,
        }),
        stockCountService.approveCount(admin, count.id),
      ]);
      assertRaceOutcome(results);
      await expectStockOk(store.id);
    }
  }, 180_000);

  it("createSale ∥ recall quarantine never deadlocks (20 runs)", async () => {
    for (let i = 0; i < RUNS; i++) {
      const { store, cashier, storeAdmin, coopAdmin } = await seedCashierStore();
      await openDrawer(store.id, storeAdmin.id);
      const { product, older } = await productWithTwoLots(store.id, 3);

      const results = await Promise.allSettled([
        salesService.createSale(store.id, asAuthUser(cashier), {
          items: [{ productId: product.id, quantity: 4 }],
          paymentMethod: PaymentMethod.CASH,
        }),
        recallService.initiateRecall(asAuthUser(coopAdmin), {
          lotIds: [older.id],
          reason: `Race quarantine ${i}`,
          severity: RecallSeverity.MANDATORY,
        }),
      ]);
      assertRaceOutcome(results);
      await expectStockOk(store.id);
    }
  }, 180_000);

  it("createSale ∥ expireLots never deadlocks (20 runs)", async () => {
    for (let i = 0; i < RUNS; i++) {
      const { store, cashier, storeAdmin } = await seedCashierStore();
      await openDrawer(store.id, storeAdmin.id);
      const { product, older } = await productWithTwoLots(store.id, 3);
      await prisma.lot.update({
        where: { id: older.id },
        data: { expiryDate: new Date("2020-01-01") },
      });

      const results = await Promise.allSettled([
        salesService.createSale(store.id, asAuthUser(cashier), {
          items: [{ productId: product.id, quantity: 4 }],
          paymentMethod: PaymentMethod.CASH,
        }),
        runExpireLotsOnce(new Date("2026-01-01")),
      ]);
      assertRaceOutcome(results);
      await expectStockOk(store.id);
    }
  }, 180_000);
});
