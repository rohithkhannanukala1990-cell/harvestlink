/**
 * Settlement accrual and currentlyOwed math.
 */
import { PaymentMethod, PaymentStatus, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as salesService from "../src/services/sales.service.js";
import * as settlementService from "../src/services/settlement.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createProduct, seedCashierStore } from "./helpers/factories.js";

describe("settlement", () => {
  it("excludes PENDING and FAILED from operatorAccrued; nets REFUNDED to zero", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    await prisma.store.update({
      where: { id: store.id },
      data: { operatorPercent: new Prisma.Decimal(10) },
    });
    const product = await createProduct(store.id, { price: 100, stock: 20 });

    const pending = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    expect(pending.sale.paymentStatus).toBe(PaymentStatus.PENDING);

    const failed = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    await salesService.markSalePaymentFailed(failed.sale.id);

    const paid = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    await salesService.finalizePaidSale(paid.sale.id);

    let summary = await settlementService.getStoreSettlementSummary(store.id);
    expect(summary.grossSales).toBe("100.00");
    expect(summary.operatorAccrued).toBe("10.00");
    expect(summary.currentlyOwed).toBe("10.00");

    const toRefund = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    await salesService.finalizePaidSale(toRefund.sale.id);
    await salesService.refundSale(toRefund.sale.id, store.id, {
      createdByUserId: storeAdmin.id,
    });

    summary = await settlementService.getStoreSettlementSummary(store.id);
    // Only the non-refunded PAID sale remains in the net accrual.
    expect(summary.grossSales).toBe("100.00");
    expect(summary.operatorAccrued).toBe("10.00");
    expect(summary.currentlyOwed).toBe("10.00");
  });

  it("computes currentlyOwed as operatorAccrued minus payouts", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    await prisma.store.update({
      where: { id: store.id },
      data: { operatorPercent: new Prisma.Decimal(20) },
    });
    const product = await createProduct(store.id, { price: 50, stock: 10 });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    await salesService.finalizePaidSale(sale.id);

    let summary = await settlementService.getStoreSettlementSummary(store.id);
    expect(summary.operatorAccrued).toBe("20.00");
    expect(summary.currentlyOwed).toBe("20.00");

    await settlementService.createPayout(store.id, asAuthUser(storeAdmin), {
      amount: 7.5,
      note: "partial",
    });

    summary = await settlementService.getStoreSettlementSummary(store.id);
    expect(summary.operatorAccrued).toBe("20.00");
    expect(summary.totalPaidOut).toBe("7.50");
    expect(summary.currentlyOwed).toBe("12.50");
  });

  it("splits co-op share by payment method and nets refunds per method", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    await prisma.store.update({
      where: { id: store.id },
      data: { operatorPercent: new Prisma.Decimal(10) },
    });
    await prisma.cashDrawer.create({
      data: {
        storeId: store.id,
        openedByUserId: storeAdmin.id,
        openingFloat: new Prisma.Decimal(100),
      },
    });
    const pA = await createProduct(store.id, { sku: "A", price: 10, stock: 20 });
    const pB = await createProduct(store.id, { sku: "B", price: 20, stock: 20 });

    const card = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: pB.id, quantity: 1 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    await salesService.finalizePaidSale(card.sale.id);

    const { sale: cash } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [
        { productId: pA.id, quantity: 2 },
        { productId: pB.id, quantity: 1 },
      ],
      paymentMethod: PaymentMethod.CASH,
    });
    const cashLineA = cash.items.find((i) => i.productId === pA.id)!;
    await salesService.refundSale(cash.id, store.id, {
      items: [{ saleItemId: cashLineA.id, quantity: 1 }],
      createdByUserId: storeAdmin.id,
    });

    const summary = await settlementService.getStoreSettlementSummary(store.id);
    // Card 20 (op 2); cash 40 − 10 refunded = 30 (op 4 − 1 = 3).
    expect(summary.grossSales).toBe("50.00");
    expect(summary.operatorAccrued).toBe("5.00");
    expect(summary.grossSalesCard).toBe("20.00");
    expect(summary.grossSalesCash).toBe("30.00");
    expect(summary.coopAmountCard).toBe("18.00");
    expect(summary.coopAmountCash).toBe("27.00");
    expect(summary.cashCollectedButNotDeposited).toBe("27.00");

    const network = await settlementService.getNetworkSettlementSummary();
    expect(network.coopAmountCash).toBe("27.00");
    expect(network.cashCollectedButNotDeposited).toBe("27.00");
  });

  it("treats a legacy sale with no payment method or Stripe reference as cash", async () => {
    const { store, cashier } = await seedCashierStore();
    await prisma.store.update({
      where: { id: store.id },
      data: { operatorPercent: new Prisma.Decimal(10) },
    });
    const product = await createProduct(store.id, { price: 100, stock: 5 });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    await salesService.finalizePaidSale(sale.id);
    await prisma.sale.update({
      where: { id: sale.id },
      data: { paymentMethod: null, stripePaymentIntentId: null, stripeCheckoutSessionId: null },
    });

    const summary = await settlementService.getStoreSettlementSummary(store.id);
    expect(summary.grossSalesCard).toBe("0.00");
    expect(summary.grossSalesCash).toBe("100.00");
    expect(summary.coopAmountCash).toBe("90.00");
  });
});
