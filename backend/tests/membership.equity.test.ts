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

  it("rejects voting when member only paid the $100 joining fee", async () => {
    await membershipService.getCooperativeSettings();
    const admin = await prisma.user.create({
      data: {
        email: `coop-vote-${Date.now()}@test.local`,
        passwordHash: "x",
        role: "COOP_ADMIN",
      },
    });
    const member = await membershipService.createMember(asAuthUser(admin), {
      name: "Fee Only",
      email: `fee-only-${Date.now()}@test.local`,
      activate: true,
      joiningFeeAmount: 100,
    });
    const fee = await prisma.membershipFee.findFirstOrThrow({
      where: { memberId: member.id },
    });
    await membershipService.confirmMembershipFee(asAuthUser(admin), fee.id);

    const refreshed = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(refreshed.hasVotingRights).toBe(false);
    expect(Number(refreshed.totalInvested)).toBe(0);

    const ballot = await prisma.ballot.create({
      data: {
        title: "Fee-only ballot",
        options: { create: [{ label: "Yes", sortOrder: 0 }] },
      },
      include: { options: true },
    });

    await expect(
      membershipService.castVote({
        ballotId: ballot.id,
        memberId: member.id,
        ballotOptionId: ballot.options[0]!.id,
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/voting rights|threshold/i),
    });
  });

  it("$1,000 and $5,000 investors each get exactly ONE vote; dividend weight 1:5", async () => {
    const investor1k = await createMember({
      status: MemberStatus.ACTIVE,
      email: `inv-1k-${Date.now()}@test.local`,
    });
    const investor5k = await createMember({
      status: MemberStatus.ACTIVE,
      email: `inv-5k-${Date.now()}@test.local`,
    });
    await membershipService.recordCapitalInvestment(investor1k.id, 1000);
    await membershipService.recordCapitalInvestment(investor5k.id, 5000);

    const eq1 = await membershipService.getMemberEquity(investor1k.id);
    const eq5 = await membershipService.getMemberEquity(investor5k.id);
    expect(eq1.hasVotingRights).toBe(true);
    expect(eq5.hasVotingRights).toBe(true);
    expect(eq1.totalInvested.toFixed(2)).toBe("1000.00");
    expect(eq5.totalInvested.toFixed(2)).toBe("5000.00");

    // Dividend BY_CAPITAL weight is proportional to totalInvested (1:5).
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
      600,
      DividendAllocationMethod.BY_CAPITAL,
    );
    const allocated = await membershipService.allocateDividend(dividend.id);
    const a1 = allocated.allocations.find((a) => a.memberId === investor1k.id)!;
    const a5 = allocated.allocations.find((a) => a.memberId === investor5k.id)!;
    expect(Number(a1.memberWeight)).toBe(1000);
    expect(Number(a5.memberWeight)).toBe(5000);
    expect(a1.amount.toFixed(2)).toBe("100.00");
    expect(a5.amount.toFixed(2)).toBe("500.00");

    // Each voting member gets exactly ONE vote — capital size never multiplies votes.
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
      memberId: investor1k.id,
      ballotOptionId: yes.id,
    });
    await membershipService.castVote({
      ballotId: ballot.id,
      memberId: investor5k.id,
      ballotOptionId: yes.id,
    });

    await expect(
      membershipService.castVote({
        ballotId: ballot.id,
        memberId: investor1k.id,
        ballotOptionId: no.id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already voted"),
    });

    const voteCount = await prisma.memberVote.count({ where: { ballotId: ballot.id } });
    expect(voteCount).toBe(2);
  });

  it("an UNCONFIRMED investment does not grant voting rights", async () => {
    const member = await createMember({ status: MemberStatus.ACTIVE });
    await membershipService.recordCapitalInvestment(member.id, 5000, { confirm: false });

    const equity = await membershipService.getMemberEquity(member.id);
    expect(equity.hasVotingRights).toBe(false);
    expect(equity.totalInvested.toFixed(2)).toBe("0.00");
    expect(equity.investments).toHaveLength(1);
    expect(equity.investments[0]!.paymentStatus).toBe("PENDING");

    const ballot = await prisma.ballot.create({
      data: {
        title: "Pending capital ballot",
        options: { create: [{ label: "Yes", sortOrder: 0 }] },
      },
      include: { options: true },
    });

    await expect(
      membershipService.castVote({
        ballotId: ballot.id,
        memberId: member.id,
        ballotOptionId: ballot.options[0]!.id,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lowering votingThresholdAmount re-enfranchises members correctly", async () => {
    const admin = await prisma.user.create({
      data: {
        email: `threshold-admin-${Date.now()}@test.local`,
        passwordHash: "x",
        role: "COOP_ADMIN",
      },
    });
    await membershipService.getCooperativeSettings();
    // Reset threshold to $1000 for this test.
    await membershipService.updateCooperativeSettings(asAuthUser(admin), {
      votingThresholdAmount: 1000,
    });

    const member = await createMember({
      status: MemberStatus.ACTIVE,
      email: `threshold-mem-${Date.now()}@test.local`,
    });
    await membershipService.recordCapitalInvestment(member.id, 500);

    let refreshed = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(refreshed.hasVotingRights).toBe(false);

    await membershipService.updateCooperativeSettings(asAuthUser(admin), {
      votingThresholdAmount: 500,
    });

    refreshed = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(refreshed.hasVotingRights).toBe(true);
    expect(Number(refreshed.totalInvested)).toBe(500);

    const ballot = await prisma.ballot.create({
      data: {
        title: "Re-enfranchise ballot",
        options: { create: [{ label: "Yes", sortOrder: 0 }] },
      },
      include: { options: true },
    });
    await membershipService.castVote({
      ballotId: ballot.id,
      memberId: member.id,
      ballotOptionId: ballot.options[0]!.id,
    });
    expect(
      await prisma.memberVote.count({
        where: { ballotId: ballot.id, memberId: member.id },
      }),
    ).toBe(1);

    // Restore default for other tests.
    await membershipService.updateCooperativeSettings(asAuthUser(admin), {
      votingThresholdAmount: 1000,
    });
  });

  it("sums two investments for dividend weight but allows exactly one vote", async () => {
    const member = await createMember({ status: MemberStatus.ACTIVE });
    await membershipService.recordCapitalInvestment(member.id, 1000);
    await membershipService.recordCapitalInvestment(member.id, 1000);

    const equity = await membershipService.getMemberEquity(member.id);
    expect(equity.totalContributed.toFixed(2)).toBe("2000.00");
    expect(equity.investments).toHaveLength(2);
    expect(equity.hasVotingRights).toBe(true);

    const resolution = await prisma.boardResolution.create({
      data: {
        title: "Declare FY dividend sum",
        outcome: BoardResolutionOutcome.PASSED,
        votedAt: new Date(),
      },
    });
    const dividend = await membershipService.declareDividend(
      resolution.id,
      new Date().getUTCFullYear(),
      200,
      DividendAllocationMethod.BY_CAPITAL,
    );
    const allocated = await membershipService.allocateDividend(dividend.id);
    const mine = allocated.allocations.find((a) => a.memberId === member.id);
    expect(mine).toBeTruthy();
    expect(Number(mine!.memberWeight)).toBe(2000);
    expect(mine!.amount.toFixed(2)).toBe("200.00");

    const ballot = await prisma.ballot.create({
      data: {
        title: "Board slate sum",
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
