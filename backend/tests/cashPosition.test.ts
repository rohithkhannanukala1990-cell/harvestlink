/**
 * Undeposited cash age vs CooperativeSettings.cashDepositGraceDays, network ordering, and the
 * daily past-grace flag job.
 */
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { runFlagUndepositedCashOnce } from "../src/jobs/flagUndepositedCash.js";
import * as cashService from "../src/services/cash.service.js";
import * as membershipService from "../src/services/membership.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createClosedDrawer,
  createStore,
  seedCashierStore,
  signTestToken,
} from "./helpers/factories.js";

describe("cash position", () => {
  it("reports days outstanding against the default 3-day grace and its double", async () => {
    const { store, storeAdmin } = await seedCashierStore();

    let position = await cashService.getStoreCashPosition(store.id);
    expect(position).toMatchObject({
      graceDays: 3,
      undepositedTotal: "0.00",
      oldestUndepositedAt: null,
      daysOutstanding: 0,
      pastGrace: false,
      pastDoubleGrace: false,
    });

    await createClosedDrawer(store.id, storeAdmin.id, {
      openingFloat: 50,
      countedCash: 90,
      closedDaysAgo: 3,
    });
    position = await cashService.getStoreCashPosition(store.id);
    expect(position.daysOutstanding).toBe(3);
    expect(position.pastGrace).toBe(false);

    const oldest = await createClosedDrawer(store.id, storeAdmin.id, {
      openingFloat: 50,
      countedCash: 70,
      closedDaysAgo: 4,
    });
    position = await cashService.getStoreCashPosition(store.id);
    expect(position.undepositedTotal).toBe("60.00");
    expect(position.cashOnHandByDrawer.map((d) => d.drawerId)[0]).toBe(oldest.id);
    expect(position.oldestUndepositedAt?.toISOString()).toBe(oldest.closedAt?.toISOString());
    expect(position.daysOutstanding).toBe(4);
    expect(position.pastGrace).toBe(true);
    expect(position.pastDoubleGrace).toBe(false);

    await createClosedDrawer(store.id, storeAdmin.id, {
      openingFloat: 0,
      countedCash: 10,
      closedDaysAgo: 7,
    });
    position = await cashService.getStoreCashPosition(store.id);
    expect(position.daysOutstanding).toBe(7);
    expect(position.pastDoubleGrace).toBe(true);
  });

  it("follows a changed grace period and rejects invalid values", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    await createClosedDrawer(store.id, storeAdmin.id, {
      openingFloat: 0,
      countedCash: 40,
      closedDaysAgo: 4,
    });

    await membershipService.updateCooperativeSettings(asAuthUser(coopAdmin), {
      cashDepositGraceDays: 5,
    });
    const position = await cashService.getStoreCashPosition(store.id);
    expect(position.graceDays).toBe(5);
    expect(position.pastGrace).toBe(false);

    await expect(
      membershipService.updateCooperativeSettings(asAuthUser(coopAdmin), {
        cashDepositGraceDays: 0,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("orders the network worst first: oldest cash before largest amount", async () => {
    const { store: bigRecent, storeAdmin } = await seedCashierStore();
    await createClosedDrawer(bigRecent.id, storeAdmin.id, {
      openingFloat: 0,
      countedCash: 500,
      closedDaysAgo: 1,
    });
    const smallOld = await createStore({ name: "Small old" });
    await createClosedDrawer(smallOld.id, storeAdmin.id, {
      openingFloat: 0,
      countedCash: 10,
      closedDaysAgo: 5,
    });
    const banked = await createStore({ name: "All banked" });

    const { stores } = await cashService.getNetworkCashPositions();
    expect(stores.map((s) => s.storeId)).toEqual([smallOld.id, bigRecent.id, banked.id]);
  });

  it("GET /settlement/:storeId/cash-position is scoped like settlement", async () => {
    const app = createApp();
    const { store, cashier, storeAdmin } = await seedCashierStore();
    await createClosedDrawer(store.id, storeAdmin.id, {
      openingFloat: 0,
      countedCash: 25,
      closedDaysAgo: 2,
    });

    const ok = await request(app)
      .get(`/settlement/${store.id}/cash-position`)
      .set("Authorization", `Bearer ${signTestToken(storeAdmin)}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ undepositedTotal: "25.00", daysOutstanding: 2, pastGrace: false });

    const denied = await request(app)
      .get(`/settlement/${store.id}/cash-position`)
      .set("Authorization", `Bearer ${signTestToken(cashier)}`);
    expect(denied.status).toBe(403);
  });
});

describe("flagUndepositedCash job", () => {
  it("audits stores past grace once per day and skips stores within grace", async () => {
    const { store: late, storeAdmin } = await seedCashierStore();
    await createClosedDrawer(late.id, storeAdmin.id, {
      openingFloat: 0,
      countedCash: 80,
      closedDaysAgo: 4,
    });
    const onTime = await createStore({ name: "On time" });
    await createClosedDrawer(onTime.id, storeAdmin.id, {
      openingFloat: 0,
      countedCash: 80,
      closedDaysAgo: 1,
    });

    const first = await runFlagUndepositedCashOnce();
    expect(first.flaggedStoreIds).toEqual([late.id]);

    const rows = await prisma.auditLog.findMany({
      where: { action: "CASH_DEPOSIT_PAST_GRACE" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ storeId: late.id, entityType: "Store", userId: null });
    expect(rows[0]?.after).toMatchObject({
      undepositedTotal: "80.00",
      daysOutstanding: 4,
      graceDays: 3,
      pastDoubleGrace: false,
    });

    const second = await runFlagUndepositedCashOnce();
    expect(second.flaggedStoreIds).toEqual([]);
    expect(second.alreadyFlaggedToday).toEqual([late.id]);
    expect(await prisma.auditLog.count({ where: { action: "CASH_DEPOSIT_PAST_GRACE" } })).toBe(1);
  });
});
