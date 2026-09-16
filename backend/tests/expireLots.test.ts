/**
 * expireLots job — past-due ACTIVE lots become EXPIRED write-offs; Product.stock rollup stays true.
 */
import { LotStatus, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { runExpireLotsOnce } from "../src/jobs/expireLots.js";
import { prisma } from "./helpers/db.js";
import { createProduct, seedCashierStore } from "./helpers/factories.js";

describe("expireLots job", () => {
  it("marks past-due ACTIVE lots EXPIRED, writes off, and keeps Product.stock consistent", async () => {
    const { store } = await seedCashierStore();
    const product = await createProduct(store.id, {
      stock: 0,
      cost: 2,
      skipLot: true,
    });
    const expiredLot = await prisma.lot.create({
      data: {
        lotNumber: "EXP-OLD",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 4,
        quantityRemaining: 4,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(2),
        expiryDate: new Date("2020-01-01"),
        receivedAt: new Date("2019-12-01"),
        status: LotStatus.ACTIVE,
      },
    });
    const freshLot = await prisma.lot.create({
      data: {
        lotNumber: "EXP-FRESH",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 6,
        quantityRemaining: 6,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(2),
        expiryDate: new Date("2099-01-01"),
        receivedAt: new Date("2026-01-01"),
        status: LotStatus.ACTIVE,
      },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { stock: 10 },
    });

    const result = await runExpireLotsOnce(new Date("2026-09-15T12:00:00Z"));

    expect(result.expiredLotIds).toContain(expiredLot.id);
    expect(result.expiredLotIds).not.toContain(freshLot.id);

    const expiredAfter = await prisma.lot.findUniqueOrThrow({ where: { id: expiredLot.id } });
    expect(expiredAfter.status).toBe(LotStatus.EXPIRED);

    const freshAfter = await prisma.lot.findUniqueOrThrow({ where: { id: freshLot.id } });
    expect(freshAfter.status).toBe(LotStatus.ACTIVE);
    expect(freshAfter.quantityRemaining).toBe(6);

    const productAfter = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(productAfter.stock).toBe(6);

    const activeSum = await prisma.lot.aggregate({
      where: { productId: product.id, status: LotStatus.ACTIVE },
      _sum: { quantityRemaining: true, quantityReserved: true },
    });
    expect(activeSum._sum.quantityRemaining).toBe(productAfter.stock);
    expect(activeSum._sum.quantityReserved ?? 0).toBe(productAfter.reserved);

    const writeOffs = await prisma.inventoryWriteOff.findMany({
      where: { lotId: expiredLot.id, reason: "EXPIRED" },
    });
    expect(writeOffs).toHaveLength(1);
    expect(writeOffs[0]!.quantity).toBe(4);
    expect(writeOffs[0]!.saleId).toBeNull();
  });

  it("skips lots that still have quantityReserved", async () => {
    const { store } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 0, skipLot: true });
    const lot = await prisma.lot.create({
      data: {
        lotNumber: "HELD",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 2,
        quantityRemaining: 2,
        quantityReserved: 1,
        unitCost: new Prisma.Decimal(1),
        expiryDate: new Date("2020-06-01"),
        receivedAt: new Date("2020-01-01"),
        status: LotStatus.ACTIVE,
      },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { stock: 2, reserved: 1 },
    });

    const result = await runExpireLotsOnce(new Date("2026-09-15T12:00:00Z"));

    expect(result.skippedReserved).toContain(lot.id);
    expect(result.expiredLotIds).not.toContain(lot.id);
    const after = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(after.status).toBe(LotStatus.ACTIVE);
  });
});
