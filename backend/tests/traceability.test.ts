/**
 * Traceability — forward recall must return every member who bought a lot, and no others.
 */
import { PaymentMethod, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as salesService from "../src/services/sales.service.js";
import * as traceability from "../src/services/traceability.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createMember,
  createProduct,
  seedCashierStore,
} from "./helpers/factories.js";

describe("traceability", () => {
  it("traceForward returns exactly the three members who bought the lot", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    await prisma.cashDrawer.create({
      data: {
        storeId: store.id,
        openedByUserId: storeAdmin.id,
        openingFloat: new Prisma.Decimal(100),
      },
    });

    const product = await createProduct(store.id, {
      stock: 10,
      price: 5,
      sku: "TRACE-LOT",
    });
    const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });

    const m1 = await createMember({ email: "buyer1@test.local" });
    const m2 = await createMember({ email: "buyer2@test.local" });
    const m3 = await createMember({ email: "buyer3@test.local" });
    const outsider = await createMember({ email: "outsider@test.local" });

    // Unrelated sale on a different product — must not appear in this lot's forward trace.
    const other = await createProduct(store.id, { stock: 5, price: 3, sku: "OTHER" });
    await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: other.id, quantity: 1 }],
      memberId: outsider.id,
      paymentMethod: PaymentMethod.CASH,
    });

    for (const member of [m1, m2, m3]) {
      const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        memberId: member.id,
        paymentMethod: PaymentMethod.CASH,
      });
      expect(sale.paymentStatus).toBe("PAID");
    }

    const forward = await traceability.traceForward(asAuthUser(storeAdmin), lot.id);

    expect(forward.sales).toHaveLength(3);
    expect(forward.quantitySold).toBe(3);
    expect(forward.members).toHaveLength(3);

    const memberIds = forward.members.map((m) => m.memberId).sort();
    expect(memberIds).toEqual([m1.id, m2.id, m3.id].sort());
    expect(memberIds).not.toContain(outsider.id);

    for (const m of forward.members) {
      expect(m.email).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.quantityPurchased).toBe(1);
      expect(m.saleIds).toHaveLength(1);
    }

    const emails = forward.members.map((m) => m.email).sort();
    expect(emails).toEqual(
      ["buyer1@test.local", "buyer2@test.local", "buyer3@test.local"].sort(),
    );
  });

  it("traceBackward returns lot → receipt → PO → supplier chain when received via purchasing", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const purchasing = await import("../src/services/purchasing.service.js");

    const product = await createProduct(store.id, { stock: 0, cost: 2, skipLot: true });
    const supplier = await purchasing.createSupplier(asAuthUser(storeAdmin), {
      name: "Valley FPO",
      contactName: "Ada",
      email: "ada@valley.test",
      phone: "555-0100",
    });
    const po = await purchasing.createPurchaseOrder(asAuthUser(storeAdmin), {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 5, unitCost: 2 }],
    });
    await purchasing.submitPurchaseOrder(asAuthUser(storeAdmin), po.id);
    await purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
      invoiceNumber: "INV-TRACE",
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 5,
          unitCostActual: 2,
          lotNumber: "BATCH-99",
          countryOfOrigin: "US",
        },
      ],
    });

    await prisma.cashDrawer.create({
      data: {
        storeId: store.id,
        openedByUserId: storeAdmin.id,
        openingFloat: new Prisma.Decimal(50),
      },
    });
    const cashier = (
      await prisma.user.findFirstOrThrow({
        where: { storeId: store.id, role: "CASHIER" },
      })
    );
    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: PaymentMethod.CASH,
    });

    const backward = await traceability.traceBackward(asAuthUser(storeAdmin), {
      saleId: sale.id,
    });

    expect(backward.lots).toHaveLength(1);
    expect(backward.lots[0]!.lotNumber).toBe("BATCH-99");
    expect(backward.lots[0]!.supplier?.name).toBe("Valley FPO");
    expect(backward.lots[0]!.purchaseOrder?.poId).toBe(po.id);
    expect(backward.lots[0]!.goodsReceipt?.invoiceNumber).toBe("INV-TRACE");
    expect(backward.lots[0]!.farm).toBeNull();
    expect(backward.lots[0]!.importShipment).toBeNull();

    const genealogy = await traceability.getLotGenealogy(
      asAuthUser(storeAdmin),
      backward.lots[0]!.lotId,
    );
    expect(genealogy.upstream.supplier?.name).toBe("Valley FPO");
    expect(genealogy.downstream.quantitySold).toBe(2);
    expect(genealogy.upstream.farm).toBeNull();
  });
});
