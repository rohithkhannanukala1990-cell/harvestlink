/**
 * Co-op equity membership invariants:
 * - Capital is never store revenue / settlement / sales reports
 * - Multiple contributions sum for dividends; voting stays one-per-member
 * - Dividends require a PASSED BoardResolution
 * - POS accepts ACTIVE members only
 */
import {
  BoardResolutionOutcome,
  DividendAllocationMethod,
  MemberStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/errors.js";
import * as membershipService from "../src/services/membership.service.js";
import * as reportsService from "../src/services/reports.service.js";
import * as salesService from "../src/services/sales.service.js";
import * as settlementService from "../src/services/settlement.service.js";
import * as storesService from "../src/services/stores.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createMember,
  createProduct,
  seedCashierStore,
} from "./helpers/factories.js";

describe("membership equity", () => {
  it("never counts a capital contribution in store revenue, settlement, or sales reports", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    await prisma.store.update({
      where: { id: store.id },
      data: { operatorPercent: new Prisma.Decimal(10) },
    });
    const member = await createMember({ status: MemberStatus.ACTIVE });

    const beforeSettlement = await settlementService.getStoreSettlementSummary(store.id);
    const beforeStats = (await storesService.listStores(asAuthUser(storeAdmin))).find(
      (s) => s.id === store.id,
    )!;
    const today = new Date().toISOString().slice(0, 10);
    const beforeReport = await reportsService.getDailyCloseReport(
      store.id,
      today,
      asAuthUser(storeAdmin),
    );
    const salesBefore = await prisma.sale.count({ where: { storeId: store.id } });

    await membershipService.recordCapitalContribution(member.id, 1000, null);

    const equity = await membershipService.getMemberEquity(member.id);
    expect(equity.totalContributed.toFixed(2)).toBe("1000.00");
    expect(equity.contributions).toHaveLength(1);

    const afterSettlement = await settlementService.getStoreSettlementSummary(store.id);
    expect(afterSettlement.grossSales).toBe(beforeSettlement.grossSales);
    expect(afterSettlement.operatorAccrued).toBe(beforeSettlement.operatorAccrued);
    expect(afterSettlement.currentlyOwed).toBe(beforeSettlement.currentlyOwed);

    const afterStats = (await storesService.listStores(asAuthUser(storeAdmin))).find(
      (s) => s.id === store.id,
    )!;
    expect(afterStats.todaysSales).toBe(beforeStats.todaysSales);
    expect(afterStats.currentlyOwed).toBe(beforeStats.currentlyOwed);

    const afterReport = await reportsService.getDailyCloseReport(
      store.id,
      today,
      asAuthUser(storeAdmin),
    );
    expect(afterReport.operatorShareAccrued).toBe(beforeReport.operatorShareAccrued);
    expect(afterReport.salesByPaymentMethod).toEqual(beforeReport.salesByPaymentMethod);

    const salesAfter = await prisma.sale.count({ where: { storeId: store.id } });
    expect(salesAfter).toBe(salesBefore);

    // Sanity: a real grocery sale still moves settlement — capital path is separate.
    const product = await createProduct(store.id, { price: 50, stock: 5 });
    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    await salesService.finalizePaidSale(sale.id);
    const withSale = await settlementService.getStoreSettlementSummary(store.id);
    expect(withSale.grossSales).toBe("50.00");
    expect(withSale.operatorAccrued).toBe("5.00");

    // Capital still not blended into that grocery accrual.
    expect(withSale.operatorAccrued).not.toBe("105.00");
  });

  it("sums two contributions for dividend weight but allows exactly one vote", async () => {
    const member = await createMember({ status: MemberStatus.ACTIVE });
    await membershipService.recordCapitalContribution(member.id, 100, null);
    await membershipService.recordCapitalContribution(member.id, 1000, null);

    const equity = await membershipService.getMemberEquity(member.id);
    expect(equity.totalContributed.toFixed(2)).toBe("1100.00");
    expect(equity.contributions).toHaveLength(2);

    // Dividend BY_CAPITAL weight uses total contributed capital.
    const resolution = await prisma.boardResolution.create({
      data: {
        title: "Declare FY dividend",
        outcome: BoardResolutionOutcome.PASSED,
        votedAt: new Date(),
      },
    });
    const dividend = await membershipService.declareDividend(
      resolution.id,
      new Date().getUTCFullYear(),
      110,
      DividendAllocationMethod.BY_CAPITAL,
    );
    const allocated = await membershipService.allocateDividend(dividend.id);
    const mine = allocated.allocations.find((a) => a.memberId === member.id);
    expect(mine).toBeTruthy();
    expect(Number(mine!.memberWeight)).toBe(1100);
    expect(mine!.amount.toFixed(2)).toBe("110.00");

    // One member, one vote — second cast is rejected regardless of capital size.
    const ballot = await prisma.ballot.create({
      data: {
        title: "Board slate",
        options: {
          create: [
            { label: "Yes", sortOrder: 0 },
            { label: "No", sortOrder: 1 },
          ],
        },
      },
      include: { options: true },
    });
    const yes = ballot.options[0]!;
    const no = ballot.options[1]!;

    await membershipService.castVote({
      ballotId: ballot.id,
      memberId: member.id,
      ballotOptionId: yes.id,
    });

    await expect(
      membershipService.castVote({
        ballotId: ballot.id,
        memberId: member.id,
        ballotOptionId: no.id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already voted"),
    });

    const voteCount = await prisma.memberVote.count({
      where: { ballotId: ballot.id, memberId: member.id },
    });
    expect(voteCount).toBe(1);
  });

  it("rejects declareDividend without an approved BoardResolution", async () => {
    await expect(
      membershipService.declareDividend(
        "missing-resolution",
        2026,
        100,
        DividendAllocationMethod.BY_CAPITAL,
      ),
    ).rejects.toMatchObject({ status: 404 });

    const pending = await prisma.boardResolution.create({
      data: { title: "Not yet voted", outcome: BoardResolutionOutcome.PENDING },
    });

    await expect(
      membershipService.declareDividend(
        pending.id,
        2026,
        100,
        DividendAllocationMethod.BY_CAPITAL,
      ),
    ).rejects.toBeInstanceOf(AppError);

    await expect(
      membershipService.declareDividend(
        pending.id,
        2026,
        100,
        DividendAllocationMethod.BY_CAPITAL,
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/PASSED|approved/i),
    });
  });

  it("POS accepts an ACTIVE member and rejects a SUSPENDED one", async () => {
    const { store, cashier } = await seedCashierStore();
    const product = await createProduct(store.id, { price: 10, stock: 5 });
    const active = await createMember({ status: MemberStatus.ACTIVE });
    const suspended = await createMember({
      status: MemberStatus.SUSPENDED,
      email: `suspended-${Date.now()}@test.local`,
    });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      memberId: active.id,
      paymentMethod: PaymentMethod.TERMINAL,
    });
    expect(sale.memberId).toBe(active.id);
    expect(sale.paymentStatus).toBe(PaymentStatus.PENDING);

    await expect(
      salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        memberId: suspended.id,
        paymentMethod: PaymentMethod.TERMINAL,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("not ACTIVE"),
    });
  });
});
