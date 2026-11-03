/**
 * Unit costs are Decimal(14,4); totals = unit × qty then rounded to 2 dp.
 */
import { describe, expect, it } from "vitest";
import { moneyDec, unitCostDec } from "../src/lib/money.js";
import * as purchasing from "../src/services/purchasing.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createProduct, seedCashierStore } from "./helpers/factories.js";

describe("unitCostDec / moneyDec", () => {
  it("1,000 units at 1.2345 value at $1,234.50", () => {
    const unit = unitCostDec(1.2345);
    expect(unit.toFixed(4)).toBe("1.2345");
    expect(moneyDec(unit.mul(1000)).toFixed(2)).toBe("1234.50");
  });

  it("does not round the unit before multiplying", () => {
    // 1.23456 → unitCostDec 1.2346; × 1000 = 1234.60
    const unit = unitCostDec(1.23456);
    expect(unit.toFixed(4)).toBe("1.2346");
    expect(moneyDec(unit.mul(1000)).toFixed(2)).toBe("1234.60");
  });
});

describe("receiveGoods persists 4 dp unit cost", () => {
  it("stores Lot.unitCost 1.2345 and write-off value would be 1234.50 for 1000 units", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, {
      stock: 0,
      cost: 1,
      price: 3,
      skipLot: true,
      sku: "UCP-4DP",
    });
    const supplier = await purchasing.createSupplier(asAuthUser(storeAdmin), {
      name: "Precision Farms",
    });
    const po = await purchasing.createPurchaseOrder(asAuthUser(storeAdmin), {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 1000, unitCost: 1.2345 }],
    });
    expect(po.lines[0]!.unitCost.toFixed(4)).toBe("1.2345");
    expect(po.lines[0]!.lineTotal.toFixed(2)).toBe("1234.50");

    await purchasing.submitPurchaseOrder(asAuthUser(storeAdmin), po.id);
    await purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
      invoiceNumber: "INV-4DP",
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 1000,
          unitCostActual: 1.2345,
          lotNumber: "LOT-4DP",
        },
      ],
    });

    const lot = await prisma.lot.findFirstOrThrow({
      where: { productId: product.id, lotNumber: "LOT-4DP" },
    });
    expect(lot.unitCost.toFixed(4)).toBe("1.2345");
    expect(moneyDec(lot.unitCost.mul(lot.quantityRemaining)).toFixed(2)).toBe("1234.50");

    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(updated.cost.toFixed(4)).toBe("1.2345");
  });
});
