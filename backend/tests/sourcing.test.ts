/**
 * FPO profiles, SourcingOrigin on receive, and getSourcingSummary (12-month active FPOs).
 */
import { OrganicStatus, SupplierType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as purchasing from "../src/services/purchasing.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createProduct, seedCashierStore } from "./helpers/factories.js";

async function submittedPo(
  actor: ReturnType<typeof asAuthUser>,
  storeId: string,
  supplierId: string,
  productId: string,
  qty = 10,
) {
  const po = await purchasing.createPurchaseOrder(actor, {
    supplierId,
    storeId,
    lines: [{ productId, orderedQty: qty, unitCost: 2 }],
  });
  return purchasing.submitPurchaseOrder(actor, po.id);
}

describe("FPO sourcing", () => {
  it("STORE_ADMIN cannot upsert an FPO profile", async () => {
    const { storeAdmin } = await seedCashierStore();
    const fpo = await purchasing.createSupplier(asAuthUser(storeAdmin), {
      name: "Blocked FPO",
      supplierType: SupplierType.FPO,
      country: "IN",
    });
    await expect(
      purchasing.upsertFpoProfile(asAuthUser(storeAdmin), {
        supplierId: fpo.id,
        memberFarmerCount: 50,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("receiveGoods from FPO requires origin; creates SourcingOrigin; summary counts only received FPOs", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    const product = await createProduct(store.id, { stock: 0, cost: 2, price: 5 });

    const fpo = await purchasing.createSupplier(admin, {
      name: `FPO-${Date.now()}`,
      supplierType: SupplierType.FPO,
      country: "IN",
    });
    await purchasing.upsertFpoProfile(admin, {
      supplierId: fpo.id,
      state: "Maharashtra",
      district: "Pune",
      memberFarmerCount: 120,
      memberFarmerCountAsOf: "2026-01-15T00:00:00.000Z",
      primaryCrops: ["turmeric", "onion"],
    });

    const neverReceived = await purchasing.createSupplier(admin, {
      name: `FPO-idle-${Date.now()}`,
      supplierType: SupplierType.FPO,
      country: "IN",
    });
    await purchasing.upsertFpoProfile(admin, {
      supplierId: neverReceived.id,
      state: "Karnataka",
      memberFarmerCount: 999,
      memberFarmerCountAsOf: "2026-01-01T00:00:00.000Z",
    });

    const po = await submittedPo(admin, store.id, fpo.id, product.id, 5);
    const lineId = po.lines[0]!.id;

    await expect(
      purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
        lines: [{ poLineId: lineId, quantityReceived: 5, unitCostActual: 2.1 }],
      }),
    ).rejects.toMatchObject({ status: 400 });

    const result = await purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
      lines: [
        {
          poLineId: lineId,
          quantityReceived: 5,
          unitCostActual: 2.1,
          origin: {
            state: "Maharashtra",
            district: "Pune",
            village: "Example",
            crop: "turmeric",
            harvestSeason: "Rabi 2026",
            organicStatus: OrganicStatus.IN_CONVERSION,
            contributingFarmerCount: 40,
          },
        },
      ],
    });

    const receiptLineId = result.receipt.lines[0]!.id;
    const origin = await prisma.sourcingOrigin.findUniqueOrThrow({
      where: { goodsReceiptLineId: receiptLineId },
    });
    expect(origin.fpoSupplierId).toBe(fpo.id);
    expect(origin.crop).toBe("turmeric");
    expect(origin.harvestSeason).toBe("Rabi 2026");

    const lot = await prisma.lot.findFirstOrThrow({
      where: { goodsReceiptLineId: receiptLineId },
    });
    expect(lot.supplierId).toBe(fpo.id);

    const summary = await purchasing.getSourcingSummary(admin);
    expect(summary.activeFpoCount).toBe(1);
    expect(summary.totalMemberFarmers).toBe(120);
    expect(summary.states).toEqual(["Maharashtra"]);
    expect(summary.asOfDates).toContain("2026-01-15T00:00:00.000Z");
  });

  it("exporter invoice keeps Lot.supplierId as exporter and origin.fpoSupplierId as FPO", async () => {
    const { store, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    const product = await createProduct(store.id, { stock: 0, cost: 1, price: 4, sku: "EXP-CROP" });

    const fpo = await purchasing.createSupplier(admin, {
      name: `Grower-${Date.now()}`,
      supplierType: SupplierType.FPO,
      country: "IN",
    });
    await purchasing.upsertFpoProfile(admin, {
      supplierId: fpo.id,
      memberFarmerCount: 10,
      state: "Gujarat",
    });
    const exporter = await purchasing.createSupplier(admin, {
      name: `Exporter-${Date.now()}`,
      supplierType: SupplierType.EXPORTER,
      country: "IN",
    });

    const po = await submittedPo(admin, store.id, exporter.id, product.id, 3);
    const result = await purchasing.receiveGoods(admin, po.id, {
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 3,
          unitCostActual: 1.5,
          origin: {
            fpoSupplierId: fpo.id,
            state: "Gujarat",
            district: "Anand",
            crop: "cumin",
          },
        },
      ],
    });

    const receiptLineId = result.receipt.lines[0]!.id;
    const lot = await prisma.lot.findFirstOrThrow({
      where: { goodsReceiptLineId: receiptLineId },
    });
    expect(lot.supplierId).toBe(exporter.id);
    const origin = await prisma.sourcingOrigin.findUniqueOrThrow({
      where: { goodsReceiptLineId: receiptLineId },
    });
    expect(origin.fpoSupplierId).toBe(fpo.id);
  });

  it("exporter receipt without origin is 400", async () => {
    const { store, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    const product = await createProduct(store.id, {
      stock: 0,
      cost: 1,
      price: 4,
      sku: `EXP-NO-ORIGIN-${Date.now()}`,
    });
    const exporter = await purchasing.createSupplier(admin, {
      name: `Exporter-no-origin-${Date.now()}`,
      supplierType: SupplierType.EXPORTER,
      country: "IN",
    });
    const po = await submittedPo(admin, store.id, exporter.id, product.id, 2);
    await expect(
      purchasing.receiveGoods(admin, po.id, {
        lines: [{ poLineId: po.lines[0]!.id, quantityReceived: 2, unitCostActual: 1 }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("getSourcingSummary ignores FPOs whose only receipt is older than 12 months", async () => {
    const { store, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    const product = await createProduct(store.id, {
      stock: 0,
      cost: 2,
      price: 5,
      sku: `OLD-FPO-${Date.now()}`,
    });
    const stale = await purchasing.createSupplier(admin, {
      name: `FPO-stale-${Date.now()}`,
      supplierType: SupplierType.FPO,
      country: "IN",
    });
    await purchasing.upsertFpoProfile(admin, {
      supplierId: stale.id,
      state: "Kerala",
      memberFarmerCount: 50,
      memberFarmerCountAsOf: "2024-01-01T00:00:00.000Z",
    });
    const po = await submittedPo(admin, store.id, stale.id, product.id, 4);
    const received = await purchasing.receiveGoods(admin, po.id, {
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 4,
          unitCostActual: 2,
          origin: {
            state: "Kerala",
            district: "Thrissur",
            crop: "pepper",
          },
        },
      ],
    });
    const receiptId = received.receipt.id;
    const old = new Date();
    old.setUTCFullYear(old.getUTCFullYear() - 2);
    await prisma.goodsReceipt.update({
      where: { id: receiptId },
      data: { receivedAt: old },
    });

    const summary = await purchasing.getSourcingSummary(admin);
    expect(summary.states).not.toContain("Kerala");
    expect(summary.activeFpoCount).toBe(0);
  });
});
