/**
 * Traceability — forward recall must return every member who bought a lot, and no others.
 * Provenance (backward / genealogy / product labels) returns only recorded facts.
 */
import { OrganicStatus, PaymentMethod, Prisma, SupplierType } from "@prisma/client";
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
    expect(genealogy.upstream.sourcingOrigin).toBeNull();
    expect(genealogy.lot.landedAddOnApplied).toBe("0.0000");
    expect(genealogy.upstream.goodsReceipt?.unitCostActual).toBe("2.0000");
    expect(genealogy.upstream.goodsReceipt?.landedAddOnPerUnit).toBe("0.0000");
    expect(genealogy.upstream.goodsReceipt?.landedUnitCost).toBe("2.0000");
  });

  it("traceBackward / genealogy surface origin, FPO, and receipt costs when recorded", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const purchasing = await import("../src/services/purchasing.service.js");
    const admin = asAuthUser(coopAdmin);

    const product = await createProduct(store.id, {
      stock: 0,
      cost: 2,
      skipLot: true,
      sku: "PROV-FPO",
    });
    const fpo = await purchasing.createSupplier(admin, {
      name: "Shivneri FPO",
      supplierType: SupplierType.FPO,
      country: "IN",
    });
    await purchasing.upsertFpoProfile(admin, {
      supplierId: fpo.id,
      legalForm: "PRODUCER_COMPANY",
      state: "Maharashtra",
      district: "Latur",
      memberFarmerCount: 214,
      memberFarmerCountAsOf: "2026-01-01T00:00:00.000Z",
    });

    const po = await purchasing.createPurchaseOrder(admin, {
      supplierId: fpo.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 5, unitCost: 2 }],
    });
    await purchasing.submitPurchaseOrder(admin, po.id);
    await purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
      invoiceNumber: "INV-PROV",
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 5,
          unitCostActual: 2.25,
          lotNumber: "LATUR-RABI",
          origin: {
            state: "Maharashtra",
            district: "Latur",
            crop: "turmeric",
            harvestSeason: "Rabi 2026",
            contributingFarmerCount: 214,
            organicStatus: OrganicStatus.CERTIFIED_ORGANIC,
          },
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
    const cashier = await prisma.user.findFirstOrThrow({
      where: { storeId: store.id, role: "CASHIER" },
    });
    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.CASH,
    });

    const backward = await traceability.traceBackward(asAuthUser(storeAdmin), {
      saleId: sale.id,
    });
    const lot = backward.lots[0]!;
    expect(lot.lotNumber).toBe("LATUR-RABI");
    expect(lot.supplier?.name).toBe("Shivneri FPO");
    expect(lot.goodsReceipt?.unitCostActual).toBe("2.2500");
    expect(lot.goodsReceipt?.landedAddOnPerUnit).toBe("0.0000");
    expect(lot.goodsReceipt?.landedUnitCost).toBe("2.2500");
    expect(lot.sourcingOrigin).toMatchObject({
      district: "Latur",
      harvestSeason: "Rabi 2026",
      contributingFarmerCount: 214,
      crop: "turmeric",
      organicStatus: OrganicStatus.CERTIFIED_ORGANIC,
    });
    expect(lot.fpo).toMatchObject({
      name: "Shivneri FPO",
      memberFarmerCount: 214,
      legalForm: "PRODUCER_COMPANY",
    });
    expect(lot.fpo?.memberFarmerCountAsOf.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(lot.farm?.fpo.name).toBe("Shivneri FPO");
    expect(lot.importShipment).toBeNull();

    const genealogy = await traceability.getLotGenealogy(asAuthUser(storeAdmin), lot.lotId);
    expect(genealogy.upstream.sourcingOrigin?.district).toBe("Latur");
    expect(genealogy.upstream.fpo?.name).toBe("Shivneri FPO");
    expect(genealogy.upstream.farm?.sourcingOrigin.district).toBe("Latur");
    expect(genealogy.upstream.importShipment).toBeNull();
    expect(genealogy.upstream.goodsReceipt?.landedUnitCost).toBe("2.2500");

    const provenance = await traceability.getProductProvenance(
      asAuthUser(storeAdmin),
      product.catalogItemId!,
    );
    expect(provenance.lots).toHaveLength(1);
    expect(provenance.lots[0]!.label).toBe(
      "Latur district, Rabi 2026, 214 farmers, via Shivneri FPO",
    );
    expect(provenance.lots[0]!.organicStatus).toBe(OrganicStatus.CERTIFIED_ORGANIC);
  });

  it("getProductProvenance omits inactive lots and builds labels from recorded facts only", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const purchasing = await import("../src/services/purchasing.service.js");
    const admin = asAuthUser(coopAdmin);

    const product = await createProduct(store.id, {
      stock: 0,
      cost: 1,
      skipLot: true,
      sku: "PROV-PARTIAL",
    });
    const fpo = await purchasing.createSupplier(admin, {
      name: "Partial FPO",
      supplierType: SupplierType.FPO,
      country: "IN",
    });
    await purchasing.upsertFpoProfile(admin, {
      supplierId: fpo.id,
      memberFarmerCount: 10,
      memberFarmerCountAsOf: "2026-02-01T00:00:00.000Z",
    });

    const po = await purchasing.createPurchaseOrder(admin, {
      supplierId: fpo.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 4, unitCost: 1 }],
    });
    await purchasing.submitPurchaseOrder(admin, po.id);
    const received = await purchasing.receiveGoods(admin, po.id, {
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 4,
          unitCostActual: 1,
          lotNumber: "PARTIAL-1",
          origin: {
            state: "Maharashtra",
            district: "Nashik",
            crop: "onion",
            // no harvestSeason / farmer count — label must not invent them
          },
        },
      ],
    });

    const lotId = (
      await prisma.lot.findFirstOrThrow({
        where: { goodsReceiptLineId: received.receipt.lines[0]!.id },
      })
    ).id;

    const active = await traceability.getProductProvenance(
      asAuthUser(storeAdmin),
      product.catalogItemId!,
    );
    expect(active.lots).toHaveLength(1);
    expect(active.lots[0]!.label).toBe("Nashik district, via Partial FPO");
    expect(active.lots[0]!.harvestSeason).toBeNull();
    expect(active.lots[0]!.contributingFarmerCount).toBeNull();

    await prisma.lot.update({
      where: { id: lotId },
      data: { status: "DEPLETED", quantityRemaining: 0 },
    });

    const after = await traceability.getProductProvenance(
      asAuthUser(storeAdmin),
      product.catalogItemId!,
    );
    expect(after.lots).toHaveLength(0);
  });
});
