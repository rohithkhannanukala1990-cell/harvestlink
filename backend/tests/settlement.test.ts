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
});
