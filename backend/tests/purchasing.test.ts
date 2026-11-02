/**
 * Purchasing / receiving money + stock paths.
 */
import { PurchaseOrderStatus, Role } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as purchasing from "../src/services/purchasing.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createProduct,
  createStore,
  createUser,
  seedCashierStore,
} from "./helpers/factories.js";

describe("purchasing receiveGoods", () => {
  it("increments stock, writes RECEIPT adjustment, and weighted-averages cost", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 10, cost: 2, price: 5, reorderAt: 5 });
    const supplier = await purchasing.createSupplier(asAuthUser(storeAdmin), {
      name: "Acme Foods",
    });
    await purchasing.upsertSupplierProduct(asAuthUser(storeAdmin), {
      supplierId: supplier.id,
      productId: product.id,
      caseSize: 6,
      caseCost: 18,
      unitCost: 3,
      minOrderQty: 6,
      isPreferred: true,
    });

    const po = await purchasing.createPurchaseOrder(asAuthUser(storeAdmin), {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 6, unitCost: 3 }],
    });
    await purchasing.submitPurchaseOrder(asAuthUser(storeAdmin), po.id);

    const result = await purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
      invoiceNumber: "INV-1",
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 6,
          unitCostActual: 4, // differs from Product.cost 2.00
        },
      ],
    });

    expect(result.purchaseOrder.status).toBe(PurchaseOrderStatus.RECEIVED);
    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(updated.stock).toBe(16);
    // WAC: (10*2 + 6*4) / 16 = (20+24)/16 = 2.75
    expect(updated.cost.toFixed(2)).toBe("2.75");

    const adj = await prisma.stockAdjustment.findFirst({
      where: { productId: product.id, reason: "RECEIPT" },
    });
    expect(adj?.delta).toBe(6);
  });

  it("receiving 50 units creates one Lot with quantityRemaining 50 and increases Product.stock by 50", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, {
      stock: 10,
      cost: 1,
      price: 3,
      sku: "LOT50",
    });
    const supplier = await purchasing.createSupplier(asAuthUser(storeAdmin), {
      name: "Lot Farms",
    });
    const po = await purchasing.createPurchaseOrder(asAuthUser(storeAdmin), {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 50, unitCost: 1.5 }],
    });
    await purchasing.submitPurchaseOrder(asAuthUser(storeAdmin), po.id);

    const before = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(before.stock).toBe(10);

    await purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
      invoiceNumber: "INV-LOT-50",
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 50,
          unitCostActual: 1.5,
          lotNumber: "PACK-2026-001",
          expiryDate: new Date("2026-12-31"),
          countryOfOrigin: "US",
        },
      ],
    });

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.stock).toBe(60); // +50 exactly

    const lots = await prisma.lot.findMany({ where: { productId: product.id } });
    // Opening test lot (stock:10) + receipt lot for the 50 units.
    expect(lots).toHaveLength(2);
    const receiptLot = lots.find((l) => l.lotNumber === "PACK-2026-001");
    expect(receiptLot).toBeTruthy();
    expect(receiptLot!.quantityRemaining).toBe(50);
    expect(receiptLot!.quantityReceived).toBe(50);
    expect(receiptLot!.quantityReserved).toBe(0);
    expect(receiptLot!.unitCost.toFixed(2)).toBe("1.50");
    expect(receiptLot!.status).toBe("ACTIVE");
    expect(receiptLot!.supplierId).toBe(supplier.id);
    expect(receiptLot!.countryOfOrigin).toBe("US");

    const adj = await prisma.stockAdjustment.findFirst({
      where: { productId: product.id, reason: "RECEIPT", lotId: receiptLot!.id },
    });
    expect(adj?.delta).toBe(50);
    expect(adj?.previousStock).toBe(10);
    expect(adj?.newStock).toBe(60);
  });

  it("rejects over-receipt without acknowledgeOverReceipt", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 0, cost: 1 });
    const supplier = await purchasing.createSupplier(asAuthUser(storeAdmin), { name: "Bulk Co" });
    const po = await purchasing.createPurchaseOrder(asAuthUser(storeAdmin), {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 2, unitCost: 1 }],
    });
    await purchasing.submitPurchaseOrder(asAuthUser(storeAdmin), po.id);

    await expect(
      purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
        lines: [
          {
            poLineId: po.lines[0]!.id,
            quantityReceived: 5,
            unitCostActual: 1,
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Over-receipt") });
  });

  it("groups low-stock reorder suggestions by preferred supplier with case rounding", async () => {
    const store = await createStore();
    const admin = await createUser({
      email: "buyer@test.local",
      role: Role.STORE_ADMIN,
      storeId: store.id,
    });
    const product = await createProduct(store.id, {
      stock: 2,
      reserved: 0,
      reorderAt: 10,
      cost: 1,
      sku: "LOW1",
    });
    const supplier = await purchasing.createSupplier(asAuthUser(admin), { name: "Preferred Inc" });
    await purchasing.upsertSupplierProduct(asAuthUser(admin), {
      supplierId: supplier.id,
      productId: product.id,
      caseSize: 12,
      caseCost: 24,
      unitCost: 2,
      minOrderQty: 12,
      isPreferred: true,
    });

    const suggestions = await purchasing.suggestReorderDrafts(asAuthUser(admin), store.id);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.supplierId).toBe(supplier.id);
    // deficit = 10-2+1 = 9 → max(9,12)=12 → already on case
    expect(suggestions[0]!.lines[0]!.suggestedQty).toBe(12);
    expect(suggestions[0]!.lines[0]!.onOrder).toBe(0);
    expect(suggestions[0]!.lines[0]!.position).toBe(2);
  });
});

describe("suggestReorderDrafts open-PO pipeline", () => {
  async function seedLowStockWithPreferred(sku: string) {
    const store = await createStore();
    const admin = await createUser({
      email: `reorder-${sku}-${Date.now()}@test.local`,
      role: Role.STORE_ADMIN,
      storeId: store.id,
    });
    const product = await createProduct(store.id, {
      stock: 2,
      reserved: 0,
      reorderAt: 10,
      cost: 1,
      sku,
    });
    const supplier = await purchasing.createSupplier(asAuthUser(admin), {
      name: `Supplier ${sku}`,
    });
    await purchasing.upsertSupplierProduct(asAuthUser(admin), {
      supplierId: supplier.id,
      productId: product.id,
      caseSize: 1,
      caseCost: 2,
      unitCost: 2,
      minOrderQty: 1,
      isPreferred: true,
    });
    return { store, admin, product, supplier };
  }

  it("does not suggest a SKU already covered by an open SUBMITTED PO", async () => {
    const { store, admin, product, supplier } = await seedLowStockWithPreferred("COV1");
    const po = await purchasing.createPurchaseOrder(asAuthUser(admin), {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 20, unitCost: 2 }],
    });
    await purchasing.submitPurchaseOrder(asAuthUser(admin), po.id);

    const suggestions = await purchasing.suggestReorderDrafts(asAuthUser(admin), store.id);
    expect(suggestions).toHaveLength(0);
  });

  it("PARTIALLY_RECEIVED onOrder uses outstanding only (ordered − received)", async () => {
    const store = await createStore();
    const admin = await createUser({
      email: `partial-${Date.now()}@test.local`,
      role: Role.STORE_ADMIN,
      storeId: store.id,
    });
    const product = await createProduct(store.id, {
      stock: 0,
      reserved: 0,
      reorderAt: 20,
      cost: 1,
      sku: `PART-${Date.now()}`,
      skipLot: true,
    });
    const supplier = await purchasing.createSupplier(asAuthUser(admin), { name: "Partial Co" });
    await purchasing.upsertSupplierProduct(asAuthUser(admin), {
      supplierId: supplier.id,
      productId: product.id,
      caseSize: 1,
      caseCost: 2,
      unitCost: 2,
      minOrderQty: 1,
      isPreferred: true,
    });

    const po = await purchasing.createPurchaseOrder(asAuthUser(admin), {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 10, unitCost: 2 }],
    });
    await purchasing.submitPurchaseOrder(asAuthUser(admin), po.id);
    await purchasing.receiveGoods(asAuthUser(admin), po.id, {
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 3,
          unitCostActual: 2,
        },
      ],
    });

    const suggestions = await purchasing.suggestReorderDrafts(asAuthUser(admin), store.id);
    expect(suggestions).toHaveLength(1);
    const line = suggestions[0]!.lines[0]!;
    // available = 3 (received), onOrder = 7 outstanding, position = 10
    expect(line.available).toBe(3);
    expect(line.onOrder).toBe(7);
    expect(line.position).toBe(10);
    expect(line.openPoNumbers).toEqual([po.poNumber]);
    // deficit = 20 - 10 + 1 = 11
    expect(line.suggestedQty).toBe(11);
  });

  it("shortClosed outstanding does not count toward onOrder", async () => {
    const store = await createStore();
    const admin = await createUser({
      email: `short-${Date.now()}@test.local`,
      role: Role.STORE_ADMIN,
      storeId: store.id,
    });
    const product = await createProduct(store.id, {
      stock: 2,
      reserved: 0,
      reorderAt: 10,
      cost: 1,
      sku: `SHORT-${Date.now()}`,
    });
    const supplier = await purchasing.createSupplier(asAuthUser(admin), { name: "Short Co" });
    await purchasing.upsertSupplierProduct(asAuthUser(admin), {
      supplierId: supplier.id,
      productId: product.id,
      caseSize: 1,
      caseCost: 2,
      unitCost: 2,
      minOrderQty: 1,
      isPreferred: true,
    });

    const po = await purchasing.createPurchaseOrder(asAuthUser(admin), {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 20, unitCost: 2 }],
    });
    await purchasing.submitPurchaseOrder(asAuthUser(admin), po.id);
    // Receive 1 and close short — without shortClosed, onOrder would cover the SKU.
    await purchasing.receiveGoods(asAuthUser(admin), po.id, {
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 1,
          unitCostActual: 2,
          closeShort: true,
          acknowledgeShortReceipt: true,
        },
      ],
    });

    const suggestions = await purchasing.suggestReorderDrafts(asAuthUser(admin), store.id);
    expect(suggestions).toHaveLength(1);
    const line = suggestions[0]!.lines[0]!;
    // available = 2+1 = 3; shortClosed ⇒ onOrder 0; position 3 ≤ 10
    expect(line.onOrder).toBe(0);
    expect(line.openPoNumbers).toEqual([]);
    expect(line.position).toBe(3);
    expect(line.suggestedQty).toBe(10 - 3 + 1);
  });

  it("DRAFT POs are listed as draftOnOrder but do not cover position", async () => {
    const { store, admin, product, supplier } = await seedLowStockWithPreferred("DRAFT1");
    const draft = await purchasing.createPurchaseOrder(asAuthUser(admin), {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 50, unitCost: 2 }],
    });
    expect(draft.status).toBe(PurchaseOrderStatus.DRAFT);

    const suggestions = await purchasing.suggestReorderDrafts(asAuthUser(admin), store.id);
    expect(suggestions).toHaveLength(1);
    const line = suggestions[0]!.lines[0]!;
    expect(line.onOrder).toBe(0);
    expect(line.openPoNumbers).toEqual([]);
    expect(line.draftOnOrder).toBe(50);
    expect(line.draftPoNumbers).toEqual([draft.poNumber]);
    // Still suggested: position = available 2 (draft ignored)
    expect(line.position).toBe(2);
    expect(line.suggestedQty).toBe(10 - 2 + 1);
  });
});
