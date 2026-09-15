/**
 * finalizePaidSale idempotency.
 */
import { PaymentMethod, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as salesService from "../src/services/sales.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createProduct, seedCashierStore } from "./helpers/factories.js";

describe("finalizePaidSale", () => {
  it("is idempotent when called twice for the same sale", async () => {
    const { store, cashier } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 5, price: 10 });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });

    const first = await salesService.finalizePaidSale(sale.id);
    expect(first.paymentStatus).toBe(PaymentStatus.PAID);

    const afterFirst = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(afterFirst.stock).toBe(3);
    expect(afterFirst.reserved).toBe(0);

    const second = await salesService.finalizePaidSale(sale.id);
    expect(second.paymentStatus).toBe(PaymentStatus.PAID);
    expect(second.id).toBe(first.id);

    const afterSecond = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(afterSecond.stock).toBe(3);
    expect(afterSecond.reserved).toBe(0);
  });
});
