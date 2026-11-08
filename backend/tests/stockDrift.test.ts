/**
 * Product.stock must stay equal to the ACTIVE lot rollup.
 * Opening stock → addLot; adjustLot via setLotRemaining; restock refuses RECALLED/EXPIRED;
 * QUARANTINED restock updates lot only; Product.cost edits are COOP_ADMIN-only.
 */
import { LotStatus, PaymentMethod, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/errors.js";
import { findStockRollupMismatches } from "../src/lib/stockInvariant.js";
import * as inventoryService from "../src/services/inventory.service.js";
import * as salesService from "../src/services/sales.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createProduct, seedCashierStore } from "./helpers/factories.js";

async function catalogItem(sku: string, maxShelfPrice = 20) {
  return prisma.catalogItem.create({
    data: {
      sku,
      name: `Catalog ${sku}`,
      category: "Test",
      taxExempt: false,
      unitsPerCase: 1,
      maxShelfPrice: new Prisma.Decimal(maxShelfPrice),
    },
  });
}

describe("stock drift closures", () => {
  it("createProduct with opening stock creates one lot and keeps Product.stock = lot remaining", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const catalog = await catalogItem(`OPEN-${Date.now()}`);

    const view = await inventoryService.createProduct(
      store.id,
      {
        catalogItemId: catalog.id,
        price: 10,
        cost: 3.25,
        stock: 15,
        reorderAt: 2,
      },
      asAuthUser(storeAdmin),
    );

    const product = await prisma.product.findUniqueOrThrow({ where: { id: view.id } });
    const lots = await prisma.lot.findMany({ where: { productId: product.id } });
    expect(lots).toHaveLength(1);
    const lot = lots[0]!;
    const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(lot.lotNumber).toBe(`OPENING-${catalog.sku}-${yyyymmdd}`);
    expect(lot.quantityRemaining).toBe(15);
    expect(lot.unitCost.toFixed(4)).toBe("3.2500");
    expect(lot.supplierId).toBeNull();
    expect(product.stock).toBe(15);

    const adj = await prisma.stockAdjustment.findFirstOrThrow({
      where: { productId: product.id, reason: "OPENING_STOCK" },
    });
    expect(adj.lotId).toBe(lot.id);
    expect(adj.delta).toBe(15);

    const check = await findStockRollupMismatches({ storeId: store.id });
    expect(check.mismatches).toEqual([]);
  });

  it("adjustLot down/up moves lot and Product.stock together; decrease writes write-off at lot cost", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 10, cost: 2.5 });
    const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });

    const down = await inventoryService.adjustLot(product.id, store.id, asAuthUser(storeAdmin), {
      lotId: lot.id,
      newQuantity: 7,
      reason: "Damaged case",
    });
    expect(down.delta).toBe(-3);
    expect(down.product.stock).toBe(7);

    const writeOff = await prisma.inventoryWriteOff.findFirstOrThrow({
      where: { productId: product.id, lotId: lot.id },
    });
    expect(writeOff.quantity).toBe(3);
    expect(writeOff.reason).toBe("MANUAL:Damaged case");
    expect(writeOff.unitCost!.toFixed(4)).toBe("2.5000");
    expect(writeOff.value!.toFixed(2)).toBe("7.50");

    const up = await inventoryService.adjustLot(product.id, store.id, asAuthUser(storeAdmin), {
      lotId: lot.id,
      newQuantity: 9,
      reason: "Found on shelf",
    });
    expect(up.delta).toBe(2);
    expect(up.product.stock).toBe(9);

    const stockAdj = await prisma.stockAdjustment.findFirstOrThrow({
      where: { productId: product.id, lotId: lot.id, reason: "MANUAL:Found on shelf" },
    });
    expect(stockAdj.delta).toBe(2);
    expect(stockAdj.lotPreviousQty).toBe(7);
    expect(stockAdj.lotNewQty).toBe(9);

    const refreshed = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(refreshed.quantityRemaining).toBe(9);
    const check = await findStockRollupMismatches({ storeId: store.id });
    expect(check.mismatches).toEqual([]);
  });

  it("refund with restock into a QUARANTINED lot raises lot remaining but not Product.stock", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 5, cost: 2, price: 10 });
    const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    await salesService.finalizePaidSale(sale.id);

    await inventoryService.quarantineLot(asAuthUser(storeAdmin), store.id, lot.id, "Hold for QA");

    const before = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    const lotBefore = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(before.stock).toBe(0);
    expect(lotBefore.status).toBe(LotStatus.QUARANTINED);
    expect(lotBefore.quantityRemaining).toBe(3);

    await salesService.refundSale(sale.id, store.id, {
      createdByUserId: storeAdmin.id,
      restock: true,
    });

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    const lotAfter = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(lotAfter.quantityRemaining).toBe(5);
    expect(after.stock).toBe(0);
  });

  it("refund with restock from a RECALLED lot returns 409; restock=false writes off", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 5, cost: 2, price: 10, sku: "REC-1" });
    const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    await salesService.finalizePaidSale(sale.id);

    await inventoryService.quarantineLot(asAuthUser(storeAdmin), store.id, lot.id, "Suspect");
    await prisma.lot.update({
      where: { id: lot.id },
      data: { status: LotStatus.RECALLED },
    });

    await expect(
      salesService.refundSale(sale.id, store.id, {
        createdByUserId: storeAdmin.id,
        restock: true,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("recalled/expired"),
    });

    // Stripe succeeded before restock refused — abort the stuck REFUNDING claim so we can
    // re-issue with restock=false (the recall workflow path).
    const stuck = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(stuck.pendingRefundId).toBeTruthy();
    await salesService.abortFailedRefund(stuck.pendingRefundId!);

    const stockBefore = (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock;
    await salesService.refundSale(sale.id, store.id, {
      createdByUserId: storeAdmin.id,
      restock: false,
    });

    const writeOff = await prisma.inventoryWriteOff.findFirstOrThrow({
      where: { productId: product.id, reason: "REFUND_NO_RESTOCK" },
    });
    expect(writeOff.quantity).toBe(1);
    expect(writeOff.saleId).toBe(sale.id);
    const stockAfter = (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock;
    expect(stockAfter).toBe(stockBefore);
    const lotAfter = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(lotAfter.quantityRemaining).toBe(4); // unchanged — write-off, not restock
  });

  it("STORE_ADMIN cost edit → 403; COOP_ADMIN cost edit is audited", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 3, cost: 4 });

    try {
      await inventoryService.updateProduct(
        product.id,
        store.id,
        { cost: 5 },
        asAuthUser(storeAdmin),
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(403);
    }

    await inventoryService.updateProduct(
      product.id,
      store.id,
      { cost: 5.5 },
      asAuthUser(coopAdmin),
    );

    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(updated.cost.toFixed(4)).toBe("5.5000");

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        entityId: product.id,
        action: "PRODUCT_COST_CHANGE",
      },
    });
    expect(audit.userId).toBe(coopAdmin.id);
    expect(audit.before).toMatchObject({ cost: "4.0000" });
    expect(audit.after).toMatchObject({ cost: "5.5000", reason: "MANUAL" });
  });
});
