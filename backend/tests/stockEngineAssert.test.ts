/**
 * Dev-mode ownership check: a locked Product must not be paired with another product's Lot.
 */
import { LotStatus, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { LockedLotRow, LockedProductRow } from "../src/lib/locks.js";
import { leaveSellableRollup, reserve } from "../src/services/stockEngine.js";
import { prisma } from "./helpers/db.js";

function fakeProduct(id: string): LockedProductRow {
  return {
    id,
    storeId: "store-a",
    sku: "SKU-A",
    name: "A",
    category: "Grocery",
    price: new Prisma.Decimal(1),
    stock: 10,
    reserved: 0,
    taxExempt: false,
  };
}

function fakeLot(id: string, productId: string): LockedLotRow {
  return {
    id,
    lotNumber: "L1",
    productId,
    storeId: "store-a",
    quantityRemaining: 10,
    quantityReserved: 0,
    unitCost: new Prisma.Decimal(1),
    expiryDate: null,
    receivedAt: new Date(),
    status: "ACTIVE",
  };
}

describe("stockEngine lot/product ownership assert", () => {
  it("throws in dev when a lot belongs to a different product than the locked row", async () => {
    const productA = fakeProduct("product-a");
    const lotOfB = fakeLot("lot-b", "product-b");

    await expect(
      prisma.$transaction(async (tx) =>
        reserve(tx, productA, [lotOfB], [
          { lotId: lotOfB.id, quantity: 1, unitCost: new Prisma.Decimal(1) },
        ]),
      ),
    ).rejects.toThrow(/belongs to product product-b, not locked product product-a/);

    await expect(
      prisma.$transaction(async (tx) =>
        leaveSellableRollup(tx, productA, lotOfB, LotStatus.QUARANTINED),
      ),
    ).rejects.toThrow(/belongs to product product-b, not locked product product-a/);
  });
});
