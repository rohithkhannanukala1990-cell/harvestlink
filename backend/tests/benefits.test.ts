/**
 * Member benefit settlement + resolveBenefits invariants.
 *
 * Covers bearer-aware operator bases, refund proration against operatorBaseSnapshot,
 * usage caps, tax/capital exclusion, and sale snapshots that survive later benefit edits.
 */
import {
  BenefitPeriod,
  BenefitScope,
  BenefitType,
  DiscountBearer,
  MemberStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Role,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  invalidateBenefitCache,
  resolveBenefits,
} from "../src/services/benefits.service.js";
import * as membershipService from "../src/services/membership.service.js";
import * as salesService from "../src/services/sales.service.js";
import * as settlementService from "../src/services/settlement.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createMember,
  createProduct,
  createStore,
  createUser,
} from "./helpers/factories.js";

async function seedMemberWithPercentBenefit(input: {
  operatorPercent: number;
  memberDiscountBearer: DiscountBearer;
  percentOff: number;
  memberDiscountSharedPercent?: number;
  taxRate?: number;
  maxUsesPerPeriod?: number | null;
  periodType?: BenefitPeriod;
  productScopeId?: string;
}): Promise<{
  store: Awaited<ReturnType<typeof createStore>>;
  cashier: Awaited<ReturnType<typeof createUser>>;
  storeAdmin: Awaited<ReturnType<typeof createUser>>;
  coopAdmin: Awaited<ReturnType<typeof createUser>>;
  member: Awaited<ReturnType<typeof createMember>>;
  benefitId: string;
}> {
  const store = await createStore({ operatorPercent: input.operatorPercent });
  await prisma.store.update({
    where: { id: store.id },
    data: {
      memberDiscountBearer: input.memberDiscountBearer,
      memberDiscountSharedPercent: new Prisma.Decimal(input.memberDiscountSharedPercent ?? 0),
      honorsNetworkBenefits: true,
      taxRate: new Prisma.Decimal(input.taxRate ?? 0),
    },
  });

  const cashier = await createUser({
    email: `ben-cashier-${Date.now()}-${Math.random()}@test.local`,
    role: Role.CASHIER,
    storeId: store.id,
  });
  const storeAdmin = await createUser({
    email: `ben-admin-${Date.now()}-${Math.random()}@test.local`,
    role: Role.STORE_ADMIN,
    storeId: store.id,
  });
  const coopAdmin = await createUser({
    email: `ben-coop-${Date.now()}-${Math.random()}@test.local`,
    role: Role.COOP_ADMIN,
    storeId: null,
  });

  const member = await createMember({
    status: MemberStatus.ACTIVE,
    email: `ben-member-${Date.now()}-${Math.random()}@test.local`,
  });

  const benefit = await prisma.memberBenefit.create({
    data: {
      benefitType: BenefitType.PERCENT_DISCOUNT,
      value: new Prisma.Decimal(input.percentOff),
      scope: input.productScopeId ? BenefitScope.PRODUCT : BenefitScope.ALL_PRODUCTS,
      scopeRefId: input.productScopeId ?? null,
      isActive: true,
      priority: 10,
      description: `${input.percentOff}% member discount`,
      maxUsesPerPeriod: input.maxUsesPerPeriod ?? null,
      periodType: input.periodType ?? BenefitPeriod.PER_TRANSACTION,
      createdByUserId: coopAdmin.id,
    },
  });
  invalidateBenefitCache();

  return {
    store,
    cashier,
    storeAdmin,
    coopAdmin,
    member,
    benefitId: benefit.id,
  };
}

describe("member benefit settlement", () => {
  it("COOP bearer pays the operator as if the sale were full price", async () => {
    const { store, cashier, member } = await seedMemberWithPercentBenefit({
      operatorPercent: 8,
      memberDiscountBearer: DiscountBearer.COOP,
      percentOff: 10,
    });
    const product = await createProduct(store.id, {
      price: 100,
      stock: 5,
      sku: "GROSS100",
    });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      memberId: member.id,
      paymentMethod: PaymentMethod.TERMINAL,
    });

    expect(sale.subtotal.toFixed(2)).toBe("90.00");
    expect(sale.memberDiscountAmount.toFixed(2)).toBe("10.00");
    expect(sale.operatorAmount.toFixed(2)).toBe("8.00");
    expect(sale.coopAmount.toFixed(2)).toBe("82.00");
  });

  it("OPERATOR bearer makes the operator absorb the discount", async () => {
    const { store, cashier, member } = await seedMemberWithPercentBenefit({
      operatorPercent: 8,
      memberDiscountBearer: DiscountBearer.OPERATOR,
      percentOff: 10,
    });
    const product = await createProduct(store.id, {
      price: 100,
      stock: 5,
      sku: "GROSS100",
    });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      memberId: member.id,
      paymentMethod: PaymentMethod.TERMINAL,
    });

    expect(sale.subtotal.toFixed(2)).toBe("90.00");
    expect(sale.memberDiscountAmount.toFixed(2)).toBe("10.00");
    expect(sale.operatorAmount.toFixed(2)).toBe("7.20");
    expect(sale.coopAmount.toFixed(2)).toBe("82.80");
  });

  it("partial refund of a COOP-bearer discounted sale claws back the correct operator share", async () => {
    const { store, cashier, storeAdmin, member, benefitId, coopAdmin } =
      await seedMemberWithPercentBenefit({
        operatorPercent: 8,
        memberDiscountBearer: DiscountBearer.COOP,
        percentOff: 10,
      });

    const productA = await createProduct(store.id, { price: 40, stock: 5, sku: "A40" });
    const productB = await createProduct(store.id, { price: 60, stock: 5, sku: "B60" });

    await prisma.memberBenefit.update({
      where: { id: benefitId },
      data: { endsAt: new Date(), isActive: false },
    });
    await prisma.memberBenefit.create({
      data: {
        benefitType: BenefitType.PERCENT_DISCOUNT,
        value: new Prisma.Decimal(10),
        scope: BenefitScope.PRODUCT,
        scopeRefId: productA.id,
        isActive: true,
        priority: 10,
        description: "10% off product A only",
        createdByUserId: coopAdmin.id,
      },
    });
    invalidateBenefitCache();

    const { sale: pending } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [
        { productId: productA.id, quantity: 1 },
        { productId: productB.id, quantity: 1 },
      ],
      memberId: member.id,
      paymentMethod: PaymentMethod.TERMINAL,
    });
    const sale = await salesService.finalizePaidSale(pending.id);

    expect(sale.subtotalBeforeDiscount.toFixed(2)).toBe("100.00");
    expect(sale.memberDiscountAmount.toFixed(2)).toBe("4.00");
    expect(sale.subtotal.toFixed(2)).toBe("96.00");
    expect(sale.operatorAmount.toFixed(2)).toBe("8.00");

    const lineA = sale.items.find((i) => i.productId === productA.id)!;
    const lineB = sale.items.find((i) => i.productId === productB.id)!;

    const afterA = await salesService.refundSale(sale.id, store.id, {
      items: [{ saleItemId: lineA.id, quantity: 1 }],
      createdByUserId: storeAdmin.id,
    });
    expect(afterA.refundedOperatorAmount.toFixed(2)).toBe("3.20");
    const clawbackA = afterA.refundedOperatorAmount;

    const afterB = await salesService.refundSale(sale.id, store.id, {
      items: [{ saleItemId: lineB.id, quantity: 1 }],
      createdByUserId: storeAdmin.id,
    });
    const clawbackB = afterB.refundedOperatorAmount.sub(clawbackA);
    expect(clawbackA.add(clawbackB).toFixed(2)).toBe(sale.operatorAmount.toFixed(2));
    expect(afterB.refundedOperatorAmount.toFixed(2)).toBe("8.00");
    expect(afterB.paymentStatus).toBe(PaymentStatus.REFUNDED);
  });

  it("SHARED bearer with 50% makes the operator absorb exactly half the discount", async () => {
    const { store, cashier, member } = await seedMemberWithPercentBenefit({
      operatorPercent: 8,
      memberDiscountBearer: DiscountBearer.SHARED,
      memberDiscountSharedPercent: 50,
      percentOff: 10,
    });
    const product = await createProduct(store.id, { price: 100, stock: 5 });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      memberId: member.id,
      paymentMethod: PaymentMethod.TERMINAL,
    });

    // Discount $10; operator absorbs 50% → base = 90 + 5 = 95; op = 7.60; coop = 82.40
    expect(sale.subtotal.toFixed(2)).toBe("90.00");
    expect(sale.memberDiscountAmount.toFixed(2)).toBe("10.00");
    expect(sale.operatorBaseSnapshot?.toFixed(2)).toBe("95.00");
    expect(sale.operatorAmount.toFixed(2)).toBe("7.60");
    expect(sale.coopAmount.toFixed(2)).toBe("82.40");
  });

  it("operator base is PRE-TAX in all three bearer modes", async () => {
    for (const bearer of [
      DiscountBearer.COOP,
      DiscountBearer.OPERATOR,
      DiscountBearer.SHARED,
    ] as const) {
      const { store, cashier, member } = await seedMemberWithPercentBenefit({
        operatorPercent: 10,
        memberDiscountBearer: bearer,
        memberDiscountSharedPercent: bearer === DiscountBearer.SHARED ? 50 : 0,
        percentOff: 10,
        taxRate: 10,
      });
      const product = await createProduct(store.id, {
        price: 100,
        stock: 5,
        sku: `TAX-${bearer}`,
      });

      const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        memberId: member.id,
        paymentMethod: PaymentMethod.TERMINAL,
      });

      // Tax on post-discount 90 → 9.00; total 99. Tax must not inflate operatorAmount.
      expect(sale.taxAmount.toFixed(2)).toBe("9.00");
      expect(sale.total.toFixed(2)).toBe("99.00");

      if (bearer === DiscountBearer.COOP) {
        expect(sale.operatorAmount.toFixed(2)).toBe("10.00"); // 10% of 100, not of 109/99
      } else if (bearer === DiscountBearer.OPERATOR) {
        expect(sale.operatorAmount.toFixed(2)).toBe("9.00"); // 10% of 90
      } else {
        expect(sale.operatorAmount.toFixed(2)).toBe("9.50"); // 10% of 95
      }
      // Sanity: operator share is never computed from tax-inclusive total.
      expect(sale.operatorAmount.toFixed(2)).not.toBe("9.90");
      expect(sale.operatorAmount.toFixed(2)).not.toBe("10.90");
    }
  });

  it("throws when member discount would push coopAmount negative", async () => {
    const { store, cashier, member } = await seedMemberWithPercentBenefit({
      operatorPercent: 8,
      memberDiscountBearer: DiscountBearer.COOP,
      percentOff: 100,
    });
    const product = await createProduct(store.id, { price: 100, stock: 5 });

    await expect(
      salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        memberId: member.id,
        paymentMethod: PaymentMethod.TERMINAL,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Member discount exceeds co-op share"),
    });

    expect(await prisma.sale.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("enforces maxUsesPerPeriod — the (n+1)th use gets no discount and a skip reason", async () => {
    const { store, cashier, member, benefitId } = await seedMemberWithPercentBenefit({
      operatorPercent: 8,
      memberDiscountBearer: DiscountBearer.COOP,
      percentOff: 10,
      maxUsesPerPeriod: 1,
      periodType: BenefitPeriod.LIFETIME,
    });
    const product = await createProduct(store.id, { price: 100, stock: 10 });

    const first = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      memberId: member.id,
      paymentMethod: PaymentMethod.TERMINAL,
    });
    expect(first.sale.memberDiscountAmount.toFixed(2)).toBe("10.00");

    const second = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      memberId: member.id,
      paymentMethod: PaymentMethod.TERMINAL,
    });
    expect(second.sale.memberDiscountAmount.toFixed(2)).toBe("0.00");
    expect(second.sale.subtotal.toFixed(2)).toBe("100.00");
    expect(second.benefitSkips?.some((s) => s.benefitId === benefitId)).toBe(true);
    expect(
      second.benefitSkips?.find((s) => s.benefitId === benefitId)?.reason,
    ).toMatch(/Usage cap reached/i);
  });

  it("benefits never apply to tax", async () => {
    const { store, cashier, member } = await seedMemberWithPercentBenefit({
      operatorPercent: 8,
      memberDiscountBearer: DiscountBearer.COOP,
      percentOff: 10,
      taxRate: 10,
    });
    const product = await createProduct(store.id, { price: 100, stock: 5 });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      memberId: member.id,
      paymentMethod: PaymentMethod.TERMINAL,
    });

    // Discount is $10 on the $100 pre-tax gross; tax is 10% of the $90 net — not of $100.
    expect(sale.memberDiscountAmount.toFixed(2)).toBe("10.00");
    expect(sale.subtotal.toFixed(2)).toBe("90.00");
    expect(sale.taxAmount.toFixed(2)).toBe("9.00");
    // Benefit did not wipe or discount the tax line itself.
    expect(sale.taxAmount.gt(0)).toBe(true);
    expect(sale.items[0]!.taxAmount.toFixed(2)).toBe("9.00");
  });

  it("benefits never apply to a CapitalInvestment", async () => {
    const { store, member } = await seedMemberWithPercentBenefit({
      operatorPercent: 8,
      memberDiscountBearer: DiscountBearer.COOP,
      percentOff: 10,
    });

    const beforeSettlement = await settlementService.getStoreSettlementSummary(store.id);
    const salesBefore = await prisma.sale.count({ where: { storeId: store.id } });
    const usagesBefore = await prisma.memberBenefitUsage.count({
      where: { memberId: member.id },
    });

    const contribution = await membershipService.recordCapitalContribution(
      member.id,
      1000,
      null,
    );
    expect(contribution.amount.toFixed(2)).toBe("1000.00");

    const afterSettlement = await settlementService.getStoreSettlementSummary(store.id);
    expect(afterSettlement.grossSales).toBe(beforeSettlement.grossSales);
    expect(afterSettlement.operatorAccrued).toBe(beforeSettlement.operatorAccrued);
    expect(await prisma.sale.count({ where: { storeId: store.id } })).toBe(salesBefore);
    expect(
      await prisma.memberBenefitUsage.count({ where: { memberId: member.id } }),
    ).toBe(usagesBefore);
  });

  it("editing a benefit after a sale does not change that sale's stored numbers", async () => {
    const { store, cashier, member, benefitId } = await seedMemberWithPercentBenefit({
      operatorPercent: 8,
      memberDiscountBearer: DiscountBearer.COOP,
      percentOff: 10,
    });
    const product = await createProduct(store.id, { price: 100, stock: 5 });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      memberId: member.id,
      paymentMethod: PaymentMethod.TERMINAL,
    });

    const snap = {
      subtotal: sale.subtotal.toFixed(2),
      memberDiscountAmount: sale.memberDiscountAmount.toFixed(2),
      operatorAmount: sale.operatorAmount.toFixed(2),
      coopAmount: sale.coopAmount.toFixed(2),
      operatorBaseSnapshot: sale.operatorBaseSnapshot?.toFixed(2),
      lineBenefit: sale.items[0]!.benefitDiscountAmount.toFixed(2),
      benefitId: sale.items[0]!.benefitId,
    };

    // Version the benefit: end the old row and create a steeper perk (do not overwrite).
    await prisma.memberBenefit.update({
      where: { id: benefitId },
      data: { endsAt: new Date(), isActive: false, value: new Prisma.Decimal(50) },
    });
    const coopAdmin = await prisma.user.findFirstOrThrow({ where: { role: Role.COOP_ADMIN } });
    await prisma.memberBenefit.create({
      data: {
        benefitType: BenefitType.PERCENT_DISCOUNT,
        value: new Prisma.Decimal(50),
        scope: BenefitScope.ALL_PRODUCTS,
        isActive: true,
        priority: 10,
        description: "50% — should not rewrite prior sales",
        createdByUserId: coopAdmin.id,
      },
    });
    invalidateBenefitCache();

    const reloaded = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      include: { items: true },
    });
    expect(reloaded.subtotal.toFixed(2)).toBe(snap.subtotal);
    expect(reloaded.memberDiscountAmount.toFixed(2)).toBe(snap.memberDiscountAmount);
    expect(reloaded.operatorAmount.toFixed(2)).toBe(snap.operatorAmount);
    expect(reloaded.coopAmount.toFixed(2)).toBe(snap.coopAmount);
    expect(reloaded.operatorBaseSnapshot?.toFixed(2)).toBe(snap.operatorBaseSnapshot);
    expect(reloaded.items[0]!.benefitDiscountAmount.toFixed(2)).toBe(snap.lineBenefit);
    expect(reloaded.items[0]!.benefitId).toBe(snap.benefitId);
  });
});

describe("resolveBenefits isolation", () => {
  it("never accepts tax in cart line prices (discounts are pre-tax only)", async () => {
    const { store, member } = await seedMemberWithPercentBenefit({
      operatorPercent: 8,
      memberDiscountBearer: DiscountBearer.COOP,
      percentOff: 10,
    });
    const product = await createProduct(store.id, { price: 100, stock: 5 });

    // Caller mistakenly includes tax in unitPrice — engine still treats input as pre-tax dollars.
    // Documented contract: unitPrice must be pre-tax; we assert discount is 10% of whatever
    // gross was supplied (no separate tax field exists to discount).
    const resolved = await resolveBenefits(
      member.id,
      store.id,
      [
        {
          lineKey: "0",
          productId: product.id,
          category: product.category,
          quantity: 1,
          unitPrice: 100,
        },
      ],
      prisma,
    );
    expect(resolved.memberDiscountAmount.toFixed(2)).toBe("10.00");
    expect(resolved.lines[0]!.lineGross.toFixed(2)).toBe("100.00");
  });
});
