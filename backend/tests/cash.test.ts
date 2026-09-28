/**
 * Cash handling end to end: settlement card/cash split, deposit record → confirm → dispute,
 * undeposited-cash coverage and age, and drawer variance by user.
 */
import { CashDepositStatus, PaymentMethod, Prisma, Role, type Store, type User } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as cashService from "../src/services/cash.service.js";
import * as reportsService from "../src/services/reports.service.js";
import * as salesService from "../src/services/sales.service.js";
import * as settlementService from "../src/services/settlement.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createClosedDrawer as closedDrawer,
  createProduct,
  createStore,
  createUser,
  seedCashierStore,
} from "./helpers/factories.js";

/** Store at 10% operator share with an open drawer, so both card and cash sales can be rung. */
async function storeReadyForSales(): Promise<{
  store: Store;
  cashier: User;
  storeAdmin: User;
  coopAdmin: User;
}> {
  const seeded = await seedCashierStore();
  await prisma.store.update({
    where: { id: seeded.store.id },
    data: { operatorPercent: new Prisma.Decimal(10) },
  });
  await prisma.cashDrawer.create({
    data: {
      storeId: seeded.store.id,
      openedByUserId: seeded.storeAdmin.id,
      openingFloat: new Prisma.Decimal(100),
    },
  });
  return seeded;
}

function sum(...values: string[]): string {
  return values.reduce((acc, v) => acc.add(v), new Prisma.Decimal(0)).toFixed(2);
}

describe("cash handling", () => {
  it("1. cash and card sales split in the settlement summary and sum to the combined total", async () => {
    const { store, cashier } = await storeReadyForSales();
    const pA = await createProduct(store.id, { sku: "A", price: 10, stock: 20 });
    const pB = await createProduct(store.id, { sku: "B", price: 20, stock: 20 });

    const card = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: pB.id, quantity: 1 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    await salesService.finalizePaidSale(card.sale.id);
    await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: pA.id, quantity: 3 }],
      paymentMethod: PaymentMethod.CASH,
    });

    const s = await settlementService.getStoreSettlementSummary(store.id);
    expect(s.grossSales).toBe("50.00");
    expect(s.grossSalesCard).toBe("20.00");
    expect(s.grossSalesCash).toBe("30.00");
    expect(sum(s.grossSalesCard, s.grossSalesCash)).toBe(s.grossSales);
    expect(s.coopAmountCard).toBe("18.00");
    expect(s.coopAmountCash).toBe("27.00");
    expect(sum(s.coopAmountCard, s.coopAmountCash, s.operatorAccrued)).toBe(s.grossSales);
    expect(s.operatorAccrued).toBe("5.00");
  });

  it("2. a recorded deposit does not reduce undeposited cash; only a confirmed one does", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const drawer = await closedDrawer(store.id, storeAdmin.id, { openingFloat: 50, countedCash: 150 });

    const deposit = await cashService.recordDeposit(store.id, 100, [drawer.id], storeAdmin.id);
    expect(deposit.status).toBe(CashDepositStatus.RECORDED);
    expect((await cashService.getUndepositedCash(store.id)).totalUndeposited).toBe("100.00");

    await cashService.confirmDeposit(deposit.id, "BANK-001", 100, coopAdmin.id);
    const after = await cashService.getUndepositedCash(store.id);
    expect(after.totalUndeposited).toBe("0.00");
    expect(after.drawers).toHaveLength(0);
  });

  it("3. confirming for less than recorded flags the discrepancy and banks the actual amount", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const drawer = await closedDrawer(store.id, storeAdmin.id, { openingFloat: 50, countedCash: 150 });
    const deposit = await cashService.recordDeposit(store.id, 100, [drawer.id], storeAdmin.id);

    const confirmed = await cashService.confirmDeposit(deposit.id, "BANK-002", 95, coopAdmin.id);
    expect(confirmed.deposit.status).toBe(CashDepositStatus.CONFIRMED);
    expect(confirmed.deposit.amount.toFixed(2)).toBe("100.00");
    expect(confirmed.deposit.confirmedAmount?.toFixed(2)).toBe("95.00");
    expect(confirmed.hasDiscrepancy).toBe(true);
    expect(confirmed.discrepancy).toBe("-5.00");

    const undeposited = await cashService.getUndepositedCash(store.id);
    expect(undeposited.drawers[0]).toMatchObject({
      drawerId: drawer.id,
      bankableCash: "100.00",
      coveredByConfirmedDeposits: "95.00",
      undeposited: "5.00",
    });

    const audit = await prisma.auditLog.findMany({
      where: { entityType: "CashDeposit", entityId: deposit.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual(["CASH_DEPOSIT_RECORD", "CASH_DEPOSIT_CONFIRM"]);
    expect(audit[1]?.after).toMatchObject({ confirmedAmount: "95.00", discrepancy: "-5.00" });
  });

  it("4. a drawer cannot be covered twice by two confirmed deposits", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const drawer = await closedDrawer(store.id, storeAdmin.id, { openingFloat: 0, countedCash: 100 });

    // Both recorded before either is confirmed, so recordDeposit cannot reject the second.
    const first = await cashService.recordDeposit(store.id, 70, [drawer.id], storeAdmin.id);
    const second = await cashService.recordDeposit(store.id, 70, [drawer.id], storeAdmin.id);

    await cashService.confirmDeposit(first.id, "BANK-A", 70, coopAdmin.id);
    expect((await cashService.getUndepositedCash(store.id)).totalUndeposited).toBe("30.00");

    // The second deposit may only cover the 30 still outstanding — never push coverage past 100.
    await cashService.confirmDeposit(second.id, "BANK-B", 70, coopAdmin.id);
    const after = await cashService.getUndepositedCash(store.id);
    expect(after.totalUndeposited).toBe("0.00");
    expect(after.drawers).toHaveLength(0);

    // Once fully covered, a further deposit against the drawer is rejected outright.
    await expect(
      cashService.recordDeposit(store.id, 10, [drawer.id], storeAdmin.id),
    ).rejects.toMatchObject({ status: 409, details: { drawerIds: [drawer.id] } });
  });

  it("5. refunds net out per payment method", async () => {
    const { store, cashier, storeAdmin } = await storeReadyForSales();
    const product = await createProduct(store.id, { price: 10, stock: 20 });

    const card = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    const cardPaid = await salesService.finalizePaidSale(card.sale.id);
    const { sale: cash } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: PaymentMethod.CASH,
    });

    await salesService.refundSale(cardPaid.id, store.id, {
      items: [{ saleItemId: cardPaid.items[0]!.id, quantity: 1 }],
      createdByUserId: storeAdmin.id,
    });
    let s = await settlementService.getStoreSettlementSummary(store.id);
    expect(s.grossSalesCard).toBe("10.00");
    expect(s.coopAmountCard).toBe("9.00");
    expect(s.grossSalesCash).toBe("20.00");
    expect(s.coopAmountCash).toBe("18.00");

    await salesService.refundSale(cash.id, store.id, {
      items: [{ saleItemId: cash.items[0]!.id, quantity: 1 }],
      createdByUserId: storeAdmin.id,
    });
    s = await settlementService.getStoreSettlementSummary(store.id);
    expect(s.grossSalesCard).toBe("10.00");
    expect(s.coopAmountCard).toBe("9.00");
    expect(s.grossSalesCash).toBe("10.00");
    expect(s.coopAmountCash).toBe("9.00");
    expect(s.cashCollectedButNotDeposited).toBe("9.00");
    expect(sum(s.grossSalesCard, s.grossSalesCash)).toBe(s.grossSales);
  });

  it("6. getUndepositedCash reports age from the oldest uncovered drawer", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const oldestCovered = await closedDrawer(store.id, storeAdmin.id, {
      openingFloat: 0,
      countedCash: 40,
      closedDaysAgo: 6,
    });
    const oldestUncovered = await closedDrawer(store.id, storeAdmin.id, {
      openingFloat: 20,
      countedCash: 70,
      closedDaysAgo: 4,
    });
    await closedDrawer(store.id, storeAdmin.id, { openingFloat: 0, countedCash: 25, closedDaysAgo: 1 });

    const deposit = await cashService.recordDeposit(store.id, 40, [oldestCovered.id], storeAdmin.id);
    await cashService.confirmDeposit(deposit.id, "BANK-6", 40, coopAdmin.id);

    const undeposited = await cashService.getUndepositedCash(store.id);
    expect(undeposited.oldestAgeDays).toBe(4);
    expect(undeposited.drawers.map((d) => [d.drawerId === oldestUncovered.id, d.ageDays])).toEqual([
      [true, 4],
      [false, 1],
    ]);
    expect(undeposited.totalUndeposited).toBe("75.00");
  });

  it("7. drawer variance aggregates correctly by user across shifts", async () => {
    const { store, cashier: alice, storeAdmin } = await seedCashierStore();
    const bob = await createUser({
      email: `bob-${Date.now()}@test.local`,
      role: Role.CASHIER,
      storeId: store.id,
    });
    for (const [variance, daysAgo] of [[-2, 3], [-4, 2], [3, 1]] as const) {
      await closedDrawer(store.id, alice.id, { openingFloat: 0, countedCash: 100, closedDaysAgo: daysAgo, variance });
    }
    // -1.00 is within the $1 tolerance, so it counts as balanced rather than short.
    for (const [variance, daysAgo] of [[6, 2], [-1, 1]] as const) {
      await closedDrawer(store.id, bob.id, { openingFloat: 0, countedCash: 100, closedDaysAgo: daysAgo, variance });
    }

    const report = await reportsService.getDrawerVarianceReport(asAuthUser(storeAdmin), {});
    const byUser = new Map(report.byUser.map((u) => [u.userId, u]));

    expect(byUser.get(alice.id)).toMatchObject({
      shiftCount: 3,
      totalVariance: "-3.00",
      averageVariance: "-1.00",
      shortTotal: "-6.00",
      overTotal: "3.00",
      shortCount: 2,
      overCount: 1,
      overThresholdCount: 0,
    });
    expect(byUser.get(bob.id)).toMatchObject({
      shiftCount: 2,
      totalVariance: "5.00",
      averageVariance: "2.50",
      shortTotal: "-1.00",
      overTotal: "6.00",
      shortCount: 0,
      overCount: 1,
      overThresholdCount: 1,
    });
    expect(report.totals).toMatchObject({ shiftCount: 5, totalVariance: "2.00", overThresholdCount: 1 });
  });
});

describe("cash deposits", () => {
  it("lets a large shift be split across deposits, then rejects it once fully covered", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const drawer = await closedDrawer(store.id, storeAdmin.id, { openingFloat: 0, countedCash: 100 });

    const first = await cashService.recordDeposit(store.id, 60, [drawer.id], storeAdmin.id);
    await cashService.confirmDeposit(first.id, "BANK-1", 60, coopAdmin.id);

    const second = await cashService.recordDeposit(store.id, 40, [drawer.id], storeAdmin.id);
    await cashService.confirmDeposit(second.id, "BANK-2", 40, coopAdmin.id);

    expect((await cashService.getUndepositedCash(store.id)).totalUndeposited).toBe("0.00");
    await expect(
      cashService.recordDeposit(store.id, 10, [drawer.id], storeAdmin.id),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("spreads a multi-shift deposit oldest-first", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const older = await closedDrawer(store.id, storeAdmin.id, {
      openingFloat: 20,
      countedCash: 70,
      closedDaysAgo: 5,
    });
    const newer = await closedDrawer(store.id, storeAdmin.id, {
      openingFloat: 20,
      countedCash: 100,
      closedDaysAgo: 2,
    });

    const deposit = await cashService.recordDeposit(
      store.id,
      70,
      [newer.id, older.id],
      storeAdmin.id,
    );
    await cashService.confirmDeposit(deposit.id, "BANK-3", 70, coopAdmin.id);

    const undeposited = await cashService.getUndepositedCash(store.id);
    // Older shift (50 bankable) fully covered; newer (80 bankable) gets the remaining 20.
    expect(undeposited.drawers).toHaveLength(1);
    expect(undeposited.drawers[0]).toMatchObject({ drawerId: newer.id, undeposited: "60.00" });
    expect(undeposited.oldestAgeDays).toBe(2);
  });

  it("dispute releases coverage, keeps the row, and blocks confirmation", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const drawer = await closedDrawer(store.id, storeAdmin.id, { openingFloat: 0, countedCash: 80 });

    const deposit = await cashService.recordDeposit(store.id, 80, [drawer.id], storeAdmin.id);
    await cashService.confirmDeposit(deposit.id, "BANK-4", 80, coopAdmin.id);
    expect((await cashService.getUndepositedCash(store.id)).totalUndeposited).toBe("0.00");

    await expect(
      cashService.disputeDeposit(deposit.id, "Bank reversed", storeAdmin.id),
    ).rejects.toMatchObject({ status: 403 });

    const disputed = await cashService.disputeDeposit(deposit.id, "Bank reversed", coopAdmin.id);
    expect(disputed.status).toBe(CashDepositStatus.DISPUTED);
    expect(disputed.disputeReason).toBe("Bank reversed");
    expect(await prisma.cashDeposit.count({ where: { id: deposit.id } })).toBe(1);
    expect((await cashService.getUndepositedCash(store.id)).totalUndeposited).toBe("80.00");

    await expect(
      cashService.confirmDeposit(deposit.id, "BANK-5", 80, coopAdmin.id),
    ).rejects.toMatchObject({ status: 409 });

    // Correct by recording a new deposit against the now-uncovered shift.
    const corrected = await cashService.recordDeposit(store.id, 80, [drawer.id], storeAdmin.id);
    expect(corrected.status).toBe(CashDepositStatus.RECORDED);

    const actions = await prisma.auditLog.findMany({
      where: { entityType: "CashDeposit" },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toContain("CASH_DEPOSIT_DISPUTE");
  });

  it("store admin may dispute their own unconfirmed deposit", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const drawer = await closedDrawer(store.id, storeAdmin.id, { openingFloat: 0, countedCash: 30 });
    const deposit = await cashService.recordDeposit(store.id, 300, [drawer.id], storeAdmin.id);

    const disputed = await cashService.disputeDeposit(deposit.id, "Mis-keyed amount", storeAdmin.id);
    expect(disputed.status).toBe(CashDepositStatus.DISPUTED);
  });

  it("enforces roles and drawer eligibility", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const drawer = await closedDrawer(store.id, storeAdmin.id, { openingFloat: 0, countedCash: 50 });

    await expect(
      cashService.recordDeposit(store.id, 50, [drawer.id], cashier.id),
    ).rejects.toMatchObject({ status: 403 });

    const otherStore = await createStore({ name: "Other" });
    const otherAdmin = await createUser({
      email: `other-admin-${Date.now()}@test.local`,
      role: Role.STORE_ADMIN,
      storeId: otherStore.id,
    });
    await expect(
      cashService.recordDeposit(store.id, 50, [drawer.id], otherAdmin.id),
    ).rejects.toMatchObject({ status: 403 });

    const deposit = await cashService.recordDeposit(store.id, 50, [drawer.id], storeAdmin.id);
    await expect(
      cashService.confirmDeposit(deposit.id, "BANK-6", 50, storeAdmin.id),
    ).rejects.toMatchObject({ status: 403 });

    const open = await prisma.cashDrawer.create({
      data: {
        storeId: store.id,
        openedByUserId: storeAdmin.id,
        openingFloat: new Prisma.Decimal(0),
      },
    });
    await expect(
      cashService.recordDeposit(store.id, 10, [open.id], storeAdmin.id),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      cashService.recordDeposit(store.id, 10, [], storeAdmin.id),
    ).rejects.toMatchObject({ status: 400 });
  });
});
