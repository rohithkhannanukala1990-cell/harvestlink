/**
 * Import shipments — currency/FX on POs, create/attach/lines/costs/status/payment/summary.
 */
import {
  ImportShipmentStatus,
  Incoterm,
  LocationType,
  ShipmentCostType,
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
import * as purchasing from "../src/services/purchasing.service.js";
import * as shipment from "../src/services/shipment.service.js";

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

async function submittedPo(
  actor: ReturnType<typeof asAuthUser>,
  storeId: string,
  supplierId: string,
  productId: string,
  opts?: {
    qty?: number;
    unitCost?: number;
    currency?: string;
    fxRateToUsd?: number;
    unitCostForeign?: number;
  },
) {
  const po = await purchasing.createPurchaseOrder(actor, {
    supplierId,
    storeId,
    currency: opts?.currency,
    fxRateToUsd: opts?.fxRateToUsd,
    lines: [
      {
        productId,
        orderedQty: opts?.qty ?? 10,
        unitCost: opts?.unitCost,
        unitCostForeign: opts?.unitCostForeign,
      },
    ],
  });
  return purchasing.submitPurchaseOrder(actor, po.id);
}

describe("import shipments", () => {
  it("USD PO keeps rate 1 and null unitCostForeign; INR converts to USD unitCost", async () => {
    const { store, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    const product = await createProduct(store.id, { stock: 0, cost: 2, price: 5 });
    const supplier = await purchasing.createSupplier(admin, { name: `FX-${Date.now()}` });

    const usd = await purchasing.createPurchaseOrder(admin, {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 2, unitCost: 10 }],
    });
    expect(usd.currency).toBe("USD");
    expect(Number(usd.fxRateToUsd)).toBe(1);
    expect(usd.lines[0]!.unitCostForeign).toBeNull();
    expect(Number(usd.lines[0]!.unitCost)).toBe(10);

    const inr = await purchasing.createPurchaseOrder(admin, {
      supplierId: supplier.id,
      storeId: store.id,
      currency: "INR",
      fxRateToUsd: 0.012,
      lines: [{ productId: product.id, orderedQty: 2, unitCostForeign: 100 }],
    });
    expect(inr.currency).toBe("INR");
    expect(Number(inr.lines[0]!.unitCostForeign)).toBe(100);
    expect(Number(inr.lines[0]!.unitCost)).toBe(1.2); // 100 × 0.012
    expect(Number(inr.total)).toBe(2.4);
  });

  it("createShipment defaults destination to main warehouse; STORE_ADMIN blocked", async () => {
    const { storeAdmin, coopAdmin } = await seedCashierStore();
    const wh = await warehouseForCoop();

    await expect(
      shipment.createShipment(asAuthUser(storeAdmin), {
        mode: ShipmentMode.SEA_FCL,
        incoterm: Incoterm.FOB,
      }),
    ).rejects.toMatchObject({ status: 403 });

    const created = await shipment.createShipment(asAuthUser(coopAdmin), {
      mode: ShipmentMode.SEA_FCL,
      incoterm: Incoterm.FOB,
      originPort: "INNSA",
    });
    expect(created.shipmentNumber).toMatch(/^IMP-\d{4}-\d{4}$/);
    expect(created.destinationStoreId).toBe(wh.id);
    expect(created.destinationPort).toBe("USHOU");
    expect(created.status).toBe(ImportShipmentStatus.PLANNED);
  });

  it("CASHIER cannot list or read shipments (or add costs)", async () => {
    const { cashier, coopAdmin } = await seedCashierStore();
    await warehouseForCoop();
    const admin = asAuthUser(coopAdmin);
    const created = await shipment.createShipment(admin, {
      mode: ShipmentMode.SEA_FCL,
      incoterm: Incoterm.FOB,
    });
    const cashierActor = asAuthUser(cashier);

    await expect(shipment.listShipments(cashierActor)).rejects.toMatchObject({
      status: 403,
    });
    await expect(shipment.getShipment(cashierActor, created.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      shipment.addCost(cashierActor, created.id, {
        costType: ShipmentCostType.OCEAN_FREIGHT,
        amountForeign: 10,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("attach PO, lines, costs, transitions, value on the water, supersede, payment", async () => {
    const { store, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    await warehouseForCoop();
    const product = await createProduct(store.id, { stock: 0, cost: 2, price: 5 });
    const supplier = await purchasing.createSupplier(admin, { name: `IMP-${Date.now()}` });

    const po = await submittedPo(admin, store.id, supplier.id, product.id, {
      qty: 100,
      unitCost: 5,
    });
    // goods value = 100 × 5 = 500 (+ tax/shipping 0)

    const s = await shipment.createShipment(admin, {
      mode: ShipmentMode.SEA_LCL,
      incoterm: Incoterm.CIF,
    });

    await shipment.attachPurchaseOrder(admin, s.id, po.id);
    const withLines = await shipment.upsertShipmentLines(admin, s.id, [
      {
        poLineId: po.lines[0]!.id,
        quantity: 100,
        grossWeightKg: 250,
        volumeCbm: 1.5,
        dutyAmountUsd: 40,
      },
    ]);
    expect(Number(withLines.goodsValueUsd)).toBe(500);
    expect(Number(withLines.lines[0]!.customsValueUsd)).toBe(500);

    // LCL freight defaults to VOLUME
    const withCost = await shipment.addCost(admin, s.id, {
      costType: ShipmentCostType.OCEAN_FREIGHT,
      amountForeign: 200,
      vendorName: "Maersk",
    });
    expect(withCost.costs[0]!.allocationBasis).toBe("VOLUME");
    expect(Number(withCost.estimatedCostsUsd)).toBe(200);
    expect(Number(withCost.upliftPercent)).toBe(40); // 200/500

    // Illegal jump PLANNED → IN_TRANSIT
    await expect(
      shipment.transitionStatus(admin, s.id, { status: ImportShipmentStatus.IN_TRANSIT }),
    ).rejects.toBeInstanceOf(AppError);

    await shipment.transitionStatus(admin, s.id, { status: ImportShipmentStatus.BOOKED });
    const inTransit = await shipment.transitionStatus(admin, s.id, {
      status: ImportShipmentStatus.IN_TRANSIT,
    });
    expect(inTransit.status).toBe(ImportShipmentStatus.IN_TRANSIT);
    expect(inTransit.actualDeparture).toBeTruthy();

    // Hold requires reason
    await expect(
      shipment.transitionStatus(admin, s.id, { status: ImportShipmentStatus.CUSTOMS_HOLD }),
    ).rejects.toMatchObject({ status: 400 });

    await shipment.transitionStatus(admin, s.id, {
      status: ImportShipmentStatus.CUSTOMS_HOLD,
      holdReason: "FDA exam",
    });

    const listed = await shipment.listShipments(admin, { onTheWater: true });
    expect(listed.shipments.some((x) => x.id === s.id)).toBe(true);
    expect(Number(listed.valueOnTheWater)).toBeGreaterThanOrEqual(500);

    // PO cannot sit on two active shipments
    const s2 = await shipment.createShipment(admin, {
      mode: ShipmentMode.AIR,
      incoterm: Incoterm.FOB,
    });
    await expect(shipment.attachPurchaseOrder(admin, s2.id, po.id)).rejects.toMatchObject({
      status: 409,
    });

    // Supersede estimate with final
    const estId = withCost.costs[0]!.id;
    const afterFinal = await shipment.supersedeCost(admin, s.id, estId, {
      amountForeign: 220,
    });
    expect(afterFinal.costs).toHaveLength(2);
    expect(Number(afterFinal.finalCostsUsd)).toBe(220);
    expect(Number(afterFinal.estimatedCostsUsd)).toBe(200); // original estimate still reported
    expect(Number(afterFinal.landedCostsUsd)).toBe(220); // effective prefers FINAL

    const paid = await shipment.recordSupplierPayment(admin, {
      poId: po.id,
      paidAmountUsd: 500,
      paymentReference: "WIRE-1",
    });
    expect(Number(paid.purchaseOrder.paidAmountUsd)).toBe(500);
    expect(paid.purchaseOrder.paymentReference).toBe("WIRE-1");
  });
});
