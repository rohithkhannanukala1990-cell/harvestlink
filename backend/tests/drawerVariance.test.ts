/**
 * Drawer variance aggregation and repeated same-direction pattern detection.
 */
import { Prisma, Role, type User } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import * as reportsService from "../src/services/reports.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createStore,
  createUser,
  seedCashierStore,
  signTestToken,
} from "./helpers/factories.js";

const DAY = 24 * 60 * 60 * 1000;

async function shift(
  storeId: string,
  opener: User,
  closer: User,
  variance: number,
  closedDaysAgo: number,
) {
  const closedAt = new Date(Date.now() - closedDaysAgo * DAY);
  const expected = new Prisma.Decimal(200);
  return prisma.cashDrawer.create({
    data: {
      storeId,
      openedByUserId: opener.id,
      closedByUserId: closer.id,
      openingFloat: new Prisma.Decimal(100),
      expectedCash: expected,
      countedCash: expected.add(variance),
      variance: new Prisma.Decimal(variance),
      openedAt: new Date(closedAt.getTime() - 8 * 60 * 60 * 1000),
      closedAt,
    },
  });
}

async function secondCashier(storeId: string, label: string): Promise<User> {
  return createUser({
    email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
    role: Role.CASHIER,
    storeId,
  });
}

describe("drawer variance report", () => {
  it("aggregates by shift, user and store without letting shorts and overs cancel", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    await shift(store.id, cashier, storeAdmin, -2, 3);
    await shift(store.id, cashier, storeAdmin, 8, 2);
    await shift(store.id, cashier, storeAdmin, -6, 1);

    const report = await reportsService.getDrawerVarianceReport(asAuthUser(storeAdmin), {});
    expect(report.storeId).toBe(store.id);
    expect(report.threshold).toBe("5.00");
    expect(report.byShift).toHaveLength(3);
    expect(report.byShift[0]?.variance).toBe("-6.00");
    expect(report.totals).toMatchObject({
      shiftCount: 3,
      totalVariance: "0.00",
      averageVariance: "0.00",
      shortTotal: "-8.00",
      overTotal: "8.00",
      shortCount: 2,
      overCount: 1,
      overThresholdCount: 2,
    });
    expect(report.byUser).toHaveLength(1);
    expect(report.byUser[0]).toMatchObject({ userId: cashier.id, shiftCount: 3 });
    expect(report.byStore[0]).toMatchObject({ storeId: store.id, overThresholdCount: 2 });

    const strict = await reportsService.getDrawerVarianceReport(asAuthUser(storeAdmin), {
      threshold: 1,
    });
    expect(strict.totals.overThresholdCount).toBe(3);
  });

  it("flags repeated shortfalls and repeated overages by one user, but not mixed or balanced runs", async () => {
    const { store, cashier: shortCashier, storeAdmin } = await seedCashierStore();
    const overCashier = await secondCashier(store.id, "over");
    const mixedCashier = await secondCashier(store.id, "mixed");
    const brokenCashier = await secondCashier(store.id, "broken");

    for (const daysAgo of [4, 3, 2]) {
      await shift(store.id, shortCashier, storeAdmin, -2, daysAgo);
      await shift(store.id, overCashier, storeAdmin, 3, daysAgo);
    }
    for (const [v, daysAgo] of [[-2, 4], [3, 3], [-2, 2], [3, 1]] as const) {
      await shift(store.id, mixedCashier, storeAdmin, v, daysAgo);
    }
    // A shift within the $1 tolerance is balanced and breaks the run.
    for (const [v, daysAgo] of [[-2, 4], [-2, 3], [-0.5, 2], [-2, 1]] as const) {
      await shift(store.id, brokenCashier, storeAdmin, v, daysAgo);
    }

    const report = await reportsService.getDrawerVarianceReport(asAuthUser(storeAdmin), {});
    const byUser = new Map(report.patterns.map((p) => [p.userId, p]));

    expect(report.patterns).toHaveLength(2);
    expect(byUser.get(shortCashier.id)).toMatchObject({
      direction: "SHORT",
      shiftCount: 3,
      totalVariance: "-6.00",
      ongoing: true,
    });
    expect(byUser.get(overCashier.id)).toMatchObject({
      direction: "OVER",
      shiftCount: 3,
      totalVariance: "9.00",
    });
    expect(byUser.has(mixedCashier.id)).toBe(false);
    expect(byUser.has(brokenCashier.id)).toBe(false);
  });

  it("only surfaces the pattern — no audit rows, no account changes", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    for (const daysAgo of [3, 2, 1]) {
      await shift(store.id, cashier, storeAdmin, -4, daysAgo);
    }

    const report = await reportsService.getDrawerVarianceReport(asAuthUser(storeAdmin), {});
    expect(report.patterns).toHaveLength(1);

    expect(await prisma.auditLog.count()).toBe(0);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: cashier.id } });
    expect(after.lockedUntil).toBeNull();
    expect(after.role).toBe(Role.CASHIER);
  });

  it("scopes store admins to their store and lets co-op admins see every store", async () => {
    const { store, cashier, storeAdmin, coopAdmin } = await seedCashierStore();
    const other = await createStore({ name: "Other" });
    const otherCashier = await secondCashier(other.id, "other");
    await shift(store.id, cashier, storeAdmin, -2, 1);
    await shift(other.id, otherCashier, coopAdmin, 2, 1);

    await expect(
      reportsService.getDrawerVarianceReport(asAuthUser(storeAdmin), { storeId: other.id }),
    ).rejects.toMatchObject({ status: 403 });

    const network = await reportsService.getDrawerVarianceReport(asAuthUser(coopAdmin), {});
    expect(network.storeId).toBeNull();
    expect(network.byStore.map((s) => s.storeId).sort()).toEqual([store.id, other.id].sort());

    const app = createApp();
    const denied = await request(app)
      .get("/reports/drawer-variance")
      .set("Authorization", `Bearer ${signTestToken(cashier)}`);
    expect(denied.status).toBe(403);

    const ok = await request(app)
      .get(`/reports/drawer-variance?storeId=${other.id}&threshold=1`)
      .set("Authorization", `Bearer ${signTestToken(coopAdmin)}`);
    expect(ok.status).toBe(200);
    expect(ok.body.totals).toMatchObject({ shiftCount: 1, overThresholdCount: 1 });
  });

  it("daily close carries that day's shifts and the trailing-window patterns", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    for (const daysAgo of [3, 2, 0]) {
      await shift(store.id, cashier, storeAdmin, -3, daysAgo);
    }

    const today = new Date().toISOString().slice(0, 10);
    const report = await reportsService.getDailyCloseReport(store.id, today, asAuthUser(storeAdmin));
    expect(report.drawerVariance.windowTo).toBe(today);
    expect(report.drawerVariance.shifts.every((s) => s.closedAt.toISOString().startsWith(today))).toBe(
      true,
    );
    expect(report.drawerVariance.patterns[0]).toMatchObject({
      userId: cashier.id,
      direction: "SHORT",
      shiftCount: 3,
    });
  });
});
