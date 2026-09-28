/**
 * Cash deposit record → confirm → dispute lifecycle and undeposited-cash coverage.
 */
import { CashDepositStatus, Prisma, Role } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as cashService from "../src/services/cash.service.js";
import { prisma } from "./helpers/db.js";
import {
  createClosedDrawer as closedDrawer,
  createStore,
  createUser,
  seedCashierStore,
} from "./helpers/factories.js";

describe("cash deposits", () => {
  it("counts only bank-confirmed money, at the bank's figure, and flags the discrepancy", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const drawer = await closedDrawer(store.id, storeAdmin.id, {
      openingFloat: 50,
      countedCash: 150,
      closedDaysAgo: 3,
    });

    const deposit = await cashService.recordDeposit(store.id, 100, [drawer.id], storeAdmin.id);
    expect(deposit.status).toBe(CashDepositStatus.RECORDED);

    // A recorded claim covers nothing.
    let undeposited = await cashService.getUndepositedCash(store.id);
    expect(undeposited.totalUndeposited).toBe("100.00");
    expect(undeposited.oldestAgeDays).toBe(3);

    const confirmed = await cashService.confirmDeposit(deposit.id, "BANK-001", 95, coopAdmin.id);
    expect(confirmed.deposit.status).toBe(CashDepositStatus.CONFIRMED);
    expect(confirmed.deposit.amount.toFixed(2)).toBe("100.00");
    expect(confirmed.deposit.confirmedAmount?.toFixed(2)).toBe("95.00");
    expect(confirmed.hasDiscrepancy).toBe(true);
    expect(confirmed.discrepancy).toBe("-5.00");

    undeposited = await cashService.getUndepositedCash(store.id);
    expect(undeposited.totalUndeposited).toBe("5.00");
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
