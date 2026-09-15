/**
 * refundSale full/partial/restock=false and settlement impact.
 */
import { PaymentMethod, PaymentStatus, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as salesService from "../src/services/sales.service.js";
import * as settlementService from "../src/services/settlement.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createProduct, seedCashierStore } from "./helpers/factories.js";
import { mockStripeModule } from "./helpers/stripeMock.js";

async function paidSaleWithTwoItems() {
  const { store, cashier, storeAdmin } = await seedCashierStore();
  await prisma.store.update({
    where: { id: store.id },
    data: { operatorPercent: new Prisma.Decimal(10) },
  });
  const p1 = await createProduct(store.id, { sku: "A", price: 10, stock: 10 });
  const p2 = await createProduct(store.id, { sku: "B", price: 20, stock: 10 });

  const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
    items: [
      { productId: p1.id, quantity: 2 },
      { productId: p2.id, quantity: 1 },
    ],
    paymentMethod: PaymentMethod.TERMINAL,
  });
  const paid = await salesService.finalizePaidSale(sale.id);
  return { store, storeAdmin, p1, p2, sale: paid };
}

describe("refundSale", () => {
  it("full refund restores stock and zeros settlement accrual", async () => {
    const { store, storeAdmin, p1, p2, sale } = await paidSaleWithTwoItems();

    expect(sale.total.toFixed(2)).toBe("40.00");
    expect(sale.operatorAmount.toFixed(2)).toBe("4.00");

    const beforeStock1 = (await prisma.product.findUniqueOrThrow({ where: { id: p1.id } })).stock;
    const beforeStock2 = (await prisma.product.findUniqueOrThrow({ where: { id: p2.id } })).stock;

    const refunded = await salesService.refundSale(sale.id, store.id, {
      createdByUserId: storeAdmin.id,
    });

    expect(refunded.paymentStatus).toBe(PaymentStatus.REFUNDED);
    expect(refunded.refundedAmount.toFixed(2)).toBe("40.00");
    expect(refunded.refundedOperatorAmount.toFixed(2)).toBe("4.00");
    expect(mockStripeModule.getRefundCalls()).toHaveLength(1);
    expect(mockStripeModule.getRefundCalls()[0]?.amount).toBe(4000);

    const after1 = await prisma.product.findUniqueOrThrow({ where: { id: p1.id } });
    const after2 = await prisma.product.findUniqueOrThrow({ where: { id: p2.id } });
    expect(after1.stock).toBe(beforeStock1 + 2);
    expect(after2.stock).toBe(beforeStock2 + 1);

    const summary = await settlementService.getStoreSettlementSummary(store.id);
    expect(summary.operatorAccrued).toBe("0.00");
    expect(summary.grossSales).toBe("0.00");
  });

  it("partial refund claws back proportional operator share and keeps sale PAID", async () => {
    const { store, storeAdmin, p1, sale } = await paidSaleWithTwoItems();
    const line = sale.items.find((i) => i.productId === p1.id)!;

    const refunded = await salesService.refundSale(sale.id, store.id, {
      items: [{ saleItemId: line.id, quantity: 1 }],
      createdByUserId: storeAdmin.id,
    });

    expect(refunded.paymentStatus).toBe(PaymentStatus.PAID);
    expect(refunded.refundedAmount.toFixed(2)).toBe("10.00");
    // 10/40 * 4.00 = 1.00
    expect(refunded.refundedOperatorAmount.toFixed(2)).toBe("1.00");

    const summary = await settlementService.getStoreSettlementSummary(store.id);
    expect(summary.grossSales).toBe("30.00");
    expect(summary.operatorAccrued).toBe("3.00");
  });

  it("restock=false writes off inventory instead of incrementing stock", async () => {
    const { store, storeAdmin, p1, sale } = await paidSaleWithTwoItems();
    const line = sale.items.find((i) => i.productId === p1.id)!;
    const stockBefore = (await prisma.product.findUniqueOrThrow({ where: { id: p1.id } })).stock;

    await salesService.refundSale(sale.id, store.id, {
      items: [{ saleItemId: line.id, quantity: 1 }],
      restock: false,
      createdByUserId: storeAdmin.id,
    });

    const stockAfter = (await prisma.product.findUniqueOrThrow({ where: { id: p1.id } })).stock;
    expect(stockAfter).toBe(stockBefore);

    const writeOffs = await prisma.inventoryWriteOff.findMany({
      where: { productId: p1.id },
    });
    expect(writeOffs).toHaveLength(1);
    expect(writeOffs[0]?.quantity).toBe(1);
    expect(writeOffs[0]?.reason).toBe("REFUND_NO_RESTOCK");
  });
});
