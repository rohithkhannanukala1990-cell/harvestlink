/**
 * createSale money math, stock/store/member guards, and last-unit concurrency.
 */
import { PaymentMethod, PaymentStatus, Prisma, MemberStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/errors.js";
import * as salesService from "../src/services/sales.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createMember,
  createProduct,
  createStore,
  createUser,
  seedCashierStore,
} from "./helpers/factories.js";
import { Role } from "@prisma/client";

describe("createSale", () => {
  it("computes correct subtotal and operatorAmount at various percentages", async () => {
    for (const percent of [0, 10, 12.5, 33.33, 100]) {
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
          "AuditLog","ProcessedStripeEvent","InventoryWriteOff","SaleRefundLine","SaleRefund",
          "StockReconciliation","MemberVote","BallotOption","Ballot","DividendAllocation","Dividend","BoardResolution",
          "CapitalInvestment","MembershipFee","MemberEquityAccount","SaleItemLot","SaleItem","Sale","StockAdjustment","Payout","CashDrawer",
          "Lot","Product","Member","CooperativeSettings","User","Store"
        RESTART IDENTITY CASCADE
      `);

      const store = await createStore({ operatorPercent: percent });
      const cashier = await createUser({
        email: `c-${percent}@test.local`,
        role: Role.CASHIER,
        storeId: store.id,
      });
      const product = await createProduct(store.id, { price: 20, stock: 5 });

      const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 2 }],
        paymentMethod: PaymentMethod.TERMINAL,
      });

      expect(sale.subtotal.toFixed(2)).toBe("40.00");
      expect(sale.total.toFixed(2)).toBe("40.00");
      const expectedOp = new Prisma.Decimal(40)
        .mul(percent)
        .div(100)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      expect(sale.operatorAmount.toFixed(2)).toBe(expectedOp.toFixed(2));
      expect(sale.coopAmount.toFixed(2)).toBe(
        new Prisma.Decimal(40).sub(expectedOp).toFixed(2),
      );
      expect(sale.paymentStatus).toBe(PaymentStatus.PENDING);
    }
  });

  it("rounds operatorAmount at the half-cent boundary (ROUND_HALF_UP)", async () => {
    // 1.11 * 50% = 0.555 → 0.56
    const store = await createStore({ operatorPercent: 50 });
    const cashier = await createUser({
      email: "halfcent@test.local",
      role: Role.CASHIER,
      storeId: store.id,
    });
    const product = await createProduct(store.id, { price: 1.11, stock: 3 });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });

    expect(sale.subtotal.toFixed(2)).toBe("1.11");
    expect(sale.operatorAmount.toFixed(2)).toBe("0.56");
    expect(sale.coopAmount.toFixed(2)).toBe("0.55");
  });

  it("rejects insufficient stock", async () => {
    const { store, cashier } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 1 });

    await expect(
      salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 2 }],
        paymentMethod: PaymentMethod.TERMINAL,
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Insufficient stock") });
  });

  it("never allocates a QUARANTINED lot", async () => {
    const { store, cashier } = await seedCashierStore();
    const product = await createProduct(store.id, {
      stock: 0,
      price: 10,
      skipLot: true,
    });
    await prisma.lot.create({
      data: {
        lotNumber: "Q-1",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 5,
        quantityRemaining: 5,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(4),
        receivedAt: new Date(),
        status: "QUARANTINED",
      },
    });

    await expect(
      salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: PaymentMethod.TERMINAL,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Product unavailable — stock is quarantined or recalled",
    });

    const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });
    expect(lot.quantityReserved).toBe(0);
    expect(lot.status).toBe("QUARANTINED");
  });

  it("returns quarantined/recalled error when only RECALLED stock remains", async () => {
    const { store, cashier } = await seedCashierStore();
    const product = await createProduct(store.id, {
      stock: 0,
      sku: "RECALL1",
      skipLot: true,
    });
    await prisma.lot.create({
      data: {
        lotNumber: "R-1",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 3,
        quantityRemaining: 3,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(2),
        receivedAt: new Date(),
        status: "RECALLED",
      },
    });

    await expect(
      salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: PaymentMethod.TERMINAL,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Product unavailable — stock is quarantined or recalled",
    });
  });

  it("rejects inactive store", async () => {
    const store = await createStore({ isActive: false });
    const cashier = await createUser({
      email: "inactive@test.local",
      role: Role.CASHIER,
      storeId: store.id,
    });
    const product = await createProduct(store.id, { stock: 5 });

    await expect(
      salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: PaymentMethod.TERMINAL,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("inactive"),
    });
  });

  it("rejects non-ACTIVE members on sale", async () => {
    const { store, cashier } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 5 });
    const member = await createMember({
      status: MemberStatus.SUSPENDED,
    });

    await expect(
      salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        memberId: member.id,
        paymentMethod: PaymentMethod.TERMINAL,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("not ACTIVE"),
    });
  });

  it("applies tax on non-exempt lines and computes operator share from PRE-TAX subtotal", async () => {
    const store = await createStore({ operatorPercent: 10 });
    await prisma.store.update({
      where: { id: store.id },
      data: { taxRate: new Prisma.Decimal(8) },
    });
    const cashier = await createUser({
      email: "tax@test.local",
      role: Role.CASHIER,
      storeId: store.id,
    });
    const taxable = await createProduct(store.id, { price: 100, stock: 5, sku: "TAX" });
    const exempt = await createProduct(store.id, {
      price: 50,
      stock: 5,
      sku: "EXEMPT",
    });
    await prisma.product.update({
      where: { id: exempt.id },
      data: { taxExempt: true },
    });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [
        { productId: taxable.id, quantity: 1 },
        { productId: exempt.id, quantity: 1 },
      ],
      paymentMethod: PaymentMethod.TERMINAL,
    });

    // subtotal = 100 + 50 = 150; tax = 8% of 100 only = 8; total = 158
    // operator = 10% of 150 (pre-tax) = 15 — NOT 10% of 158
    expect(sale.subtotal.toFixed(2)).toBe("150.00");
    expect(sale.taxAmount.toFixed(2)).toBe("8.00");
    expect(sale.total.toFixed(2)).toBe("158.00");
    expect(sale.operatorAmount.toFixed(2)).toBe("15.00");
  });

  it("finalizes cash sales immediately when a drawer is open", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 3, price: 10 });
    await prisma.cashDrawer.create({
      data: {
        storeId: store.id,
        openedByUserId: storeAdmin.id,
        openingFloat: new Prisma.Decimal(100),
      },
    });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.CASH,
    });

    expect(sale.paymentStatus).toBe(PaymentStatus.PAID);
    expect(sale.paymentMethod).toBe(PaymentMethod.CASH);
    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(updated.stock).toBe(2);
    expect(updated.reserved).toBe(0);
  });

  it("allows only one of two concurrent createSale calls for the last unit", async () => {
    // Phase 11 regression: without reserved + FOR UPDATE, both cashiers could PENDING the last unit.
    const { store, cashier } = await seedCashierStore();
    const secondCashier = await createUser({
      email: "cashier2@test.local",
      role: Role.CASHIER,
      storeId: store.id,
    });
    const product = await createProduct(store.id, { stock: 1, reserved: 0 });

    const results = await Promise.allSettled([
      salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: PaymentMethod.TERMINAL,
      }),
      salesService.createSale(store.id, asAuthUser(secondCashier), {
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: PaymentMethod.TERMINAL,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(409);

    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(updated.stock).toBe(1);
    expect(updated.reserved).toBe(1);

    const lots = await prisma.lot.findMany({ where: { productId: product.id, status: "ACTIVE" } });
    expect(lots.reduce((s, l) => s + l.quantityRemaining, 0)).toBe(updated.stock);
    expect(lots.reduce((s, l) => s + l.quantityReserved, 0)).toBe(updated.reserved);

    const pendingCount = await prisma.sale.count({
      where: { storeId: store.id, paymentStatus: PaymentStatus.PENDING },
    });
    expect(pendingCount).toBe(1);
  });

  it("allows only one of two concurrent createSale calls for the last unit on a single named lot", async () => {
    // Same concurrency discipline as above, but the race is explicitly on ONE Lot row (not a product rollup).
    const { store, cashier } = await seedCashierStore();
    const secondCashier = await createUser({
      email: "cashier2-lot@test.local",
      role: Role.CASHIER,
      storeId: store.id,
    });
    const product = await createProduct(store.id, {
      stock: 0,
      reserved: 0,
      skipLot: true,
      sku: "ONELOT",
    });
    const lot = await prisma.lot.create({
      data: {
        lotNumber: "SOLE-UNIT",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 1,
        quantityRemaining: 1,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(4),
        receivedAt: new Date(),
        status: "ACTIVE",
      },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { stock: 1, reserved: 0 },
    });

    const results = await Promise.allSettled([
      salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: PaymentMethod.TERMINAL,
      }),
      salesService.createSale(store.id, asAuthUser(secondCashier), {
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: PaymentMethod.TERMINAL,
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const lotAfter = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(lotAfter.quantityRemaining).toBe(1);
    expect(lotAfter.quantityReserved).toBe(1);

    const productAfter = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(productAfter.stock).toBe(1);
    expect(productAfter.reserved).toBe(1);
  });

  it("keeps Product.stock/reserved equal to SUM of ACTIVE lot remaining/reserved", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    await prisma.cashDrawer.create({
      data: {
        storeId: store.id,
        openedByUserId: storeAdmin.id,
        openingFloat: new Prisma.Decimal(100),
      },
    });
    const product = await createProduct(store.id, { stock: 5, price: 10 });

    await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });

    let p = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    let lots = await prisma.lot.findMany({
      where: { productId: product.id, status: "ACTIVE" },
    });
    expect(lots.reduce((s, l) => s + l.quantityRemaining, 0)).toBe(p.stock);
    expect(lots.reduce((s, l) => s + l.quantityReserved, 0)).toBe(p.reserved);

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.CASH,
    });
    expect(sale.paymentStatus).toBe(PaymentStatus.PAID);

    p = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    lots = await prisma.lot.findMany({
      where: { productId: product.id, status: "ACTIVE" },
    });
    expect(lots.reduce((s, l) => s + l.quantityRemaining, 0)).toBe(p.stock);
    expect(lots.reduce((s, l) => s + l.quantityReserved, 0)).toBe(p.reserved);
  });

  it("allocates across lots in FEFO order when a line spans multiple lots", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    await prisma.cashDrawer.create({
      data: {
        storeId: store.id,
        openedByUserId: storeAdmin.id,
        openingFloat: new Prisma.Decimal(50),
      },
    });
    const product = await createProduct(store.id, { stock: 0, price: 10, cost: 2, skipLot: true });
    const later = await prisma.lot.create({
      data: {
        lotNumber: "LATER",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 3,
        quantityRemaining: 3,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(2),
        expiryDate: new Date("2027-06-01"),
        receivedAt: new Date("2026-01-01"),
        status: "ACTIVE",
      },
    });
    const sooner = await prisma.lot.create({
      data: {
        lotNumber: "SOONER",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 2,
        quantityRemaining: 2,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(3),
        expiryDate: new Date("2026-10-01"),
        receivedAt: new Date("2026-02-01"),
        status: "ACTIVE",
      },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { stock: 5 },
    });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 4 }],
      paymentMethod: PaymentMethod.CASH,
    });

    const allocs = await prisma.saleItemLot.findMany({
      where: { saleItem: { saleId: sale.id } },
      orderBy: { quantity: "desc" },
    });
    expect(allocs).toHaveLength(2);
    const byLot = new Map(allocs.map((a) => [a.lotId, a]));
    expect(byLot.get(sooner.id)?.quantity).toBe(2);
    expect(byLot.get(later.id)?.quantity).toBe(2);

    const soonerAfter = await prisma.lot.findUniqueOrThrow({ where: { id: sooner.id } });
    const laterAfter = await prisma.lot.findUniqueOrThrow({ where: { id: later.id } });
    expect(soonerAfter.quantityRemaining).toBe(0);
    expect(soonerAfter.status).toBe("DEPLETED");
    expect(laterAfter.quantityRemaining).toBe(1);
    expect(laterAfter.status).toBe("ACTIVE");
  });

  it("returns the same sale when idempotencyKey is replayed", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 5, price: 10 });
    await prisma.cashDrawer.create({
      data: {
        storeId: store.id,
        openedByUserId: storeAdmin.id,
        openingFloat: new Prisma.Decimal(50),
      },
    });

    const key = "idem-test-key-001";
    const first = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.CASH,
      idempotencyKey: key,
    });
    const second = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.CASH,
      idempotencyKey: key,
    });

    expect(second.replayed).toBe(true);
    expect(second.sale.id).toBe(first.sale.id);
    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(updated.stock).toBe(4); // decremented once, not twice
    expect(await prisma.sale.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("accepts offlineSync cash sale with insufficient stock, goes negative, and queues reconciliation", async () => {
    const { store, cashier } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 1, price: 10, sku: "LAST" });

    const { sale, stockReconciliationQueued } = await salesService.createSale(
      store.id,
      asAuthUser(cashier),
      {
        items: [{ productId: product.id, quantity: 3 }],
        paymentMethod: PaymentMethod.CASH,
        idempotencyKey: "offline-neg-stock-001",
        offlineSync: true,
      },
    );

    expect(sale.paymentStatus).toBe(PaymentStatus.PAID);
    expect(stockReconciliationQueued).toBe(true);
    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(updated.stock).toBe(-2);
    const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });
    expect(lot.quantityRemaining).toBe(-2);
    const flags = await prisma.stockReconciliation.findMany({ where: { saleId: sale.id } });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reason).toBe("OFFLINE_SALE_NEGATIVE_STOCK");
    expect(flags[0]?.stockAfter).toBe(-2);
  });
});
