/**
 * receiveGoods applies shipment landed-cost allocation onto lots / Product.cost.
 */
import {
  CostAllocationBasis,
  ImportShipmentStatus,
  Incoterm,
  LocationType,
  ShipmentCostType,
  ShipmentDocType,
  ShipmentMode,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/errors.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createProduct,
  createStore,
  seedCashierStore,
} from "./helpers/factories.js";
import * as compliance from "../src/services/compliance.service.js";
import * as documents from "../src/services/document.service.js";
import * as purchasing from "../src/services/purchasing.service.js";
import * as landedCost from "../src/services/landedCost.service.js";
import * as shipment from "../src/services/shipment.service.js";

async function attachFdaPriorNotice(
  admin: ReturnType<typeof asAuthUser>,
  shipmentId: string,
) {
  const doc = await documents.uploadDocument(admin, {
    buffer: Buffer.from("%PDF-1.4\nprior\n%%EOF\n"),
    fileName: "prior-notice.pdf",
    mimeType: "application/pdf",
  });
  await compliance.attachShipmentDocument(admin, {
    shipmentId,
    docType: ShipmentDocType.FDA_PRIOR_NOTICE,
    documentId: doc.id,
  });
}

async function warehouseForCoop() {
  const wh = await createStore({
    name: `WH-${Date.now()}`,
    locationType: LocationType.WAREHOUSE,
  });
  await prisma.cooperativeSettings.create({
    data: {
      legalEntityName: "Test Co-op",
      mainWarehouseId: wh.id,
      operatingState: "TX",
      stateOfIncorporation: "OH",
    },
  });
  return wh;
}

describe("landed cost on receive", () => {
  it("domestic PO still receives at invoice cost (add-on 0)", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    const product = await createProduct(store.id, { stock: 0, cost: 2, price: 5 });
    const supplier = await purchasing.createSupplier(admin, { name: `DOM-${Date.now()}` });
    const po = await purchasing.createPurchaseOrder(admin, {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 5, unitCost: 2 }],
    });
    await purchasing.submitPurchaseOrder(admin, po.id);

    const result = await purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
      lines: [{ poLineId: po.lines[0]!.id, quantityReceived: 5, unitCostActual: 2.5 }],
    });

    expect(Number(result.receipt.lines[0]!.landedAddOnPerUnit)).toBe(0);
    expect(Number(result.receipt.lines[0]!.receivedValue)).toBe(12.5);
    const lot = await prisma.lot.findFirst({ where: { productId: product.id } });
    expect(Number(lot!.unitCost)).toBe(2.5);
    expect(Number(lot!.landedAddOnApplied)).toBe(0);
  });

  it("shipment without costs requires acknowledgeNoLandedCost (COOP_ADMIN)", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    await warehouseForCoop();
    const product = await createProduct(store.id, { stock: 0, cost: 2, price: 5 });
    const supplier = await purchasing.createSupplier(admin, { name: `IMP-${Date.now()}` });
    const po = await purchasing.createPurchaseOrder(admin, {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 10, unitCost: 5 }],
    });
    await purchasing.submitPurchaseOrder(admin, po.id);

    const s = await shipment.createShipment(admin, {
      mode: ShipmentMode.SEA_FCL,
      incoterm: Incoterm.FOB,
    });
    await shipment.attachPurchaseOrder(admin, s.id, po.id);
    await attachFdaPriorNotice(admin, s.id);

    await expect(
      purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
        lines: [{ poLineId: po.lines[0]!.id, quantityReceived: 10, unitCostActual: 5 }],
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
        acknowledgeNoLandedCost: true,
        lines: [{ poLineId: po.lines[0]!.id, quantityReceived: 10, unitCostActual: 5 }],
      }),
    ).rejects.toMatchObject({ status: 403 });

    const ok = await purchasing.receiveGoods(admin, po.id, {
      acknowledgeNoLandedCost: true,
      lines: [{ poLineId: po.lines[0]!.id, quantityReceived: 10, unitCostActual: 5 }],
    });
    expect(ok.acknowledgedNoLandedCost).toBe(true);
    expect(Number(ok.receipt.lines[0]!.landedAddOnPerUnit)).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "RECEIVE_NO_LANDED_COST", entityId: s.id },
    });
    expect(audit).toBeTruthy();
    expect(audit!.userId).toBe(coopAdmin.id);
  });

  it("applies allocation to lot unitCost; preview matches; marks shipment RECEIVED", async () => {
    const { store, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    await warehouseForCoop();
    const product = await createProduct(store.id, { stock: 0, cost: 2, price: 8 });
    const supplier = await purchasing.createSupplier(admin, { name: `LC-${Date.now()}` });
    const po = await purchasing.createPurchaseOrder(admin, {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 100, unitCost: 5 }],
    });
    await purchasing.submitPurchaseOrder(admin, po.id);

    const s = await shipment.createShipment(admin, {
      mode: ShipmentMode.SEA_LCL,
      incoterm: Incoterm.CIF,
    });
    await shipment.attachPurchaseOrder(admin, s.id, po.id);
    await shipment.upsertShipmentLines(admin, s.id, [
      {
        poLineId: po.lines[0]!.id,
        quantity: 100,
        volumeCbm: 2,
        grossWeightKg: 200,
      },
    ]);
    await attachFdaPriorNotice(admin, s.id);
    // $200 freight on VALUE → all on this one line → $2.00/unit
    await shipment.addCost(admin, s.id, {
      costType: ShipmentCostType.OCEAN_FREIGHT,
      amountForeign: 200,
      allocationBasis: CostAllocationBasis.VALUE,
    });

    const preview = await landedCost.previewAllocation(admin, s.id);
    expect(preview.lines[0]!.landedAddOnPerUnit).toBe("2.0000");

    // Advance to DELIVERED so status machine can settle to RECEIVED after receive
    for (const status of [
      ImportShipmentStatus.BOOKED,
      ImportShipmentStatus.IN_TRANSIT,
      ImportShipmentStatus.AT_PORT,
      ImportShipmentStatus.CLEARED,
      ImportShipmentStatus.DELIVERED,
    ] as const) {
      await shipment.transitionStatus(admin, s.id, {
        status,
        ...(status === ImportShipmentStatus.CUSTOMS_HOLD
          ? { holdReason: "n/a" }
          : {}),
      });
    }

    const result = await purchasing.receiveGoods(admin, po.id, {
      lines: [{ poLineId: po.lines[0]!.id, quantityReceived: 100, unitCostActual: 5 }],
    });

    expect(Number(result.receipt.lines[0]!.unitCostActual)).toBe(5);
    expect(Number(result.receipt.lines[0]!.landedAddOnPerUnit)).toBe(2);
    expect(Number(result.receipt.lines[0]!.receivedValue)).toBe(700); // 100 × 7
    expect(result.receipt.lines[0]!.shipmentId).toBe(s.id);
    expect(result.shipmentMarkedReceived).toBe(true);
    // Allocation is server-side — client cannot supply a different landed add-on.
    expect(result.costChanges[0]!.landedUnitCost).toBeDefined();
    expect(Number(result.costChanges[0]!.unitCostActual)).toBe(5);
    expect(Number(result.costChanges[0]!.landedUnitCost)).toBe(7);

    const lot = await prisma.lot.findFirst({ where: { productId: product.id } });
    expect(Number(lot!.unitCost)).toBe(7); // invoice 5 + add-on 2
    expect(Number(lot!.landedAddOnApplied)).toBe(2);

    const productAfter = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(Number(productAfter.cost)).toBe(7);

    const ship = await prisma.importShipment.findUniqueOrThrow({ where: { id: s.id } });
    expect(ship.status).toBe(ImportShipmentStatus.RECEIVED);
  });

  it("rejects receive when shipment has costs but no lines", async () => {
    const { store, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    await warehouseForCoop();
    const product = await createProduct(store.id, { stock: 0, cost: 2, price: 5 });
    const supplier = await purchasing.createSupplier(admin, { name: `NL-${Date.now()}` });
    const po = await purchasing.createPurchaseOrder(admin, {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 5, unitCost: 3 }],
    });
    await purchasing.submitPurchaseOrder(admin, po.id);
    const s = await shipment.createShipment(admin, {
      mode: ShipmentMode.AIR,
      incoterm: Incoterm.FOB,
    });
    await shipment.attachPurchaseOrder(admin, s.id, po.id);
    await attachFdaPriorNotice(admin, s.id);
    await shipment.addCost(admin, s.id, {
      costType: ShipmentCostType.AIR_FREIGHT,
      amountForeign: 50,
    });

    await expect(
      purchasing.receiveGoods(admin, po.id, {
        lines: [{ poLineId: po.lines[0]!.id, quantityReceived: 5, unitCostActual: 3 }],
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
