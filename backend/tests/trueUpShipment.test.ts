/**
 * trueUpShipment — consumed-unit check, variance booking, idempotency, restock reversal,
 * concurrent sale identity.
 */
import {
  CostAllocationBasis,
  ImportShipmentStatus,
  Incoterm,
  LandedCostVarianceReason,
  LocationType,
  LotStatus,
  PaymentMethod,
  Prisma,
  ShipmentCostType,
  ShipmentDocType,
  ShipmentMode,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import { moneyDec, unitCostDec } from "../src/lib/money.js";
import * as compliance from "../src/services/compliance.service.js";
import * as documents from "../src/services/document.service.js";
import {
  previewTrueUp,
  trueUpShipment,
  unitsConsumedFromLot,
} from "../src/services/landedCost.service.js";
import * as purchasing from "../src/services/purchasing.service.js";
import * as salesService from "../src/services/sales.service.js";
import * as shipment from "../src/services/shipment.service.js";
import { prisma } from "./helpers/db.js";
import * as inventory from "../src/services/inventory.service.js";
import {
  asAuthUser,
  createProduct,
  createStore,
  seedCashierStore,
} from "./helpers/factories.js";

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

async function attachFda(admin: ReturnType<typeof asAuthUser>, shipmentId: string) {
  const doc = await documents.uploadDocument(admin, {
    buffer: Buffer.from("%PDF-1.4\npn\n%%EOF\n"),
    fileName: "pn.pdf",
    mimeType: "application/pdf",
  });
  await compliance.attachShipmentDocument(admin, {
    shipmentId,
    docType: ShipmentDocType.FDA_PRIOR_NOTICE,
    documentId: doc.id,
  });
}

async function openCashDrawer(storeId: string, userId: string) {
  await prisma.cashDrawer.create({
    data: {
      storeId,
      openedByUserId: userId,
      openingFloat: new Prisma.Decimal(100),
      openedAt: new Date(),
    },
  });
}

async function receiveImportWithEstimate(opts?: { qty?: number; unitCost?: number; freight?: number }) {
  const qty = opts?.qty ?? 100;
  const unitCost = opts?.unitCost ?? 5;
  const freight = opts?.freight ?? 200;
  const { store, cashier, coopAdmin } = await seedCashierStore();
  const admin = asAuthUser(coopAdmin);
  await warehouseForCoop();
  await openCashDrawer(store.id, cashier.id);
  const product = await createProduct(store.id, {
    stock: 0,
    cost: unitCost,
    price: 20,
    skipLot: true,
  });
  const supplier = await purchasing.createSupplier(admin, { name: `TU-${Date.now()}` });
  const po = await purchasing.createPurchaseOrder(admin, {
    supplierId: supplier.id,
    storeId: store.id,
    lines: [{ productId: product.id, orderedQty: qty, unitCost }],
  });
  await purchasing.submitPurchaseOrder(admin, po.id);

  const s = await shipment.createShipment(admin, {
    mode: ShipmentMode.SEA_FCL,
    incoterm: Incoterm.FOB,
  });
  await shipment.attachPurchaseOrder(admin, s.id, po.id);
  await shipment.upsertShipmentLines(admin, s.id, [
    { poLineId: po.lines[0]!.id, quantity: qty },
  ]);
  await attachFda(admin, s.id);
  const withCost = await shipment.addCost(admin, s.id, {
    costType: ShipmentCostType.OCEAN_FREIGHT,
    amountForeign: freight,
    allocationBasis: CostAllocationBasis.VALUE,
  });
  const estimateId = withCost.costs[0]!.id;

  for (const status of [
    ImportShipmentStatus.BOOKED,
    ImportShipmentStatus.IN_TRANSIT,
    ImportShipmentStatus.AT_PORT,
    ImportShipmentStatus.CLEARED,
    ImportShipmentStatus.DELIVERED,
  ] as const) {
    await shipment.transitionStatus(admin, s.id, { status });
  }

  await purchasing.receiveGoods(admin, po.id, {
    lines: [{ poLineId: po.lines[0]!.id, quantityReceived: qty, unitCostActual: unitCost }],
  });

  const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });
  return { store, cashier, admin, product, po, s, estimateId, lot, unitCost, freight, qty };
}

describe("unitsConsumedFromLot", () => {
  it("worked check: 100 received, 40 sold, 5 restocked, 3 write-off → 38", async () => {
    const { store, cashier } = await seedCashierStore();
    await openCashDrawer(store.id, cashier.id);
    const product = await createProduct(store.id, { stock: 0, cost: 1, price: 5, skipLot: true });
    const lot = await prisma.lot.create({
      data: {
        lotNumber: "C-1",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 100,
        quantityRemaining: 100,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(1),
        receivedAt: new Date(),
        status: LotStatus.ACTIVE,
      },
    });
    await prisma.product.update({ where: { id: product.id }, data: { stock: 100 } });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 40 }],
      paymentMethod: PaymentMethod.CASH,
    });
    const sil = await prisma.saleItemLot.findFirstOrThrow({ where: { lotId: lot.id } });
    expect(sil.quantity).toBe(40);

    // Simulate +5 restock and −3 count shortfall → remaining 62
    const refund = await prisma.saleRefund.create({
      data: {
        saleId: sale.id,
        amount: new Prisma.Decimal(25),
        operatorAmount: new Prisma.Decimal(0),
        restock: true,
        status: "SUCCEEDED",
        completedAt: new Date(),
      },
    });
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });
    await prisma.refundRestockLot.create({
      data: {
        saleRefundId: refund.id,
        saleItemId: saleItem.id,
        lotId: lot.id,
        quantity: 5,
        unitCostSnapshot: new Prisma.Decimal(1),
      },
    });
    await prisma.inventoryWriteOff.create({
      data: {
        storeId: store.id,
        productId: product.id,
        lotId: lot.id,
        quantity: 3,
        reason: "STOCK_COUNT:short",
        unitCost: new Prisma.Decimal(1),
        value: new Prisma.Decimal(3),
      },
    });
    await prisma.lot.update({
      where: { id: lot.id },
      data: { quantityRemaining: 62 },
    });
    const lotForCheck = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });

    const c = await unitsConsumedFromLot(prisma, lotForCheck);
    expect(c.fromState).toBe(38); // 100 + 0 - 62 - 0
    expect(c.fromLedger).toBe(38); // 40 - 5 + 3
  });

  it("A and B agree across sales, refund restock, count short/over, manual ±, EXPIRED, RECALLED", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    await openCashDrawer(store.id, cashier.id);
    const admin = asAuthUser(storeAdmin);

    async function agree(lotId: string) {
      const lot = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
      const c = await unitsConsumedFromLot(prisma, lot);
      expect(c.fromState).toBe(c.fromLedger);
      return c;
    }

    // Multi-sale + partial refund restock
    const pSales = await createProduct(store.id, {
      stock: 0,
      cost: 1,
      price: 5,
      skipLot: true,
      sku: `UCS-S-${Date.now()}`,
    });
    const lotSales = await prisma.lot.create({
      data: {
        lotNumber: "UCS-SALES",
        productId: pSales.id,
        storeId: store.id,
        quantityReceived: 100,
        quantityRemaining: 100,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(1),
        receivedAt: new Date(),
        status: LotStatus.ACTIVE,
      },
    });
    await prisma.product.update({ where: { id: pSales.id }, data: { stock: 100 } });
    await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: pSales.id, quantity: 10 }],
      paymentMethod: PaymentMethod.CASH,
    });
    const { sale: sale2 } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: pSales.id, quantity: 20 }],
      paymentMethod: PaymentMethod.CASH,
    });
    expect((await agree(lotSales.id)).soldPaid).toBe(30);

    // Partial refund restock of 7 (ledger + remaining) — A/B must agree
    const refund = await prisma.saleRefund.create({
      data: {
        saleId: sale2.id,
        amount: new Prisma.Decimal(35),
        operatorAmount: new Prisma.Decimal(0),
        restock: true,
        status: "SUCCEEDED",
        completedAt: new Date(),
      },
    });
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale2.id } });
    await prisma.refundRestockLot.create({
      data: {
        saleRefundId: refund.id,
        saleItemId: saleItem.id,
        lotId: lotSales.id,
        quantity: 7,
        unitCostSnapshot: new Prisma.Decimal(1),
      },
    });
    await prisma.lot.update({
      where: { id: lotSales.id },
      data: { quantityRemaining: 77 }, // 100 − 30 + 7
    });
    const salesCheck = await agree(lotSales.id);
    expect(salesCheck.soldPaid).toBe(30);
    expect(salesCheck.restocked).toBe(7);
    expect(salesCheck.fromState).toBe(23); // 100 − 77

    // Count shortfall via write-off + remaining drop
    await prisma.inventoryWriteOff.create({
      data: {
        storeId: store.id,
        productId: pSales.id,
        lotId: lotSales.id,
        quantity: 4,
        reason: "STOCK_COUNT:short",
        unitCost: new Prisma.Decimal(1),
        value: new Prisma.Decimal(4),
      },
    });
    await prisma.lot.update({
      where: { id: lotSales.id },
      data: { quantityRemaining: 73 },
    });
    expect((await agree(lotSales.id)).writtenOff).toBe(4);

    // Count overage — StockAdjustment increase (not RECEIPT) + remaining up
    const beforeOverage = await prisma.lot.findUniqueOrThrow({ where: { id: lotSales.id } });
    await prisma.stockAdjustment.create({
      data: {
        productId: pSales.id,
        storeId: store.id,
        adjustedById: storeAdmin.id,
        previousStock: beforeOverage.quantityRemaining,
        newStock: beforeOverage.quantityRemaining + 5,
        delta: 5,
        reason: "STOCK_COUNT:over",
        lotId: lotSales.id,
        lotPreviousQty: beforeOverage.quantityRemaining,
        lotNewQty: beforeOverage.quantityRemaining + 5,
      },
    });
    await prisma.lot.update({
      where: { id: lotSales.id },
      data: { quantityRemaining: beforeOverage.quantityRemaining + 5 },
    });
    const overage = await agree(lotSales.id);
    expect(overage.increases).toBe(5);
    expect(overage.fromState).toBe(overage.fromLedger);

    // Manual increase + decrease via adjustLot
    const pManual = await createProduct(store.id, {
      stock: 0,
      cost: 1,
      price: 4,
      skipLot: true,
      sku: `UCS-M-${Date.now()}`,
    });
    const lotManual = await prisma.lot.create({
      data: {
        lotNumber: "UCS-MANUAL",
        productId: pManual.id,
        storeId: store.id,
        quantityReceived: 50,
        quantityRemaining: 50,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(1),
        receivedAt: new Date(),
        status: LotStatus.ACTIVE,
      },
    });
    await prisma.product.update({ where: { id: pManual.id }, data: { stock: 50 } });
    await inventory.adjustLot(pManual.id, store.id, admin, {
      lotId: lotManual.id,
      newQuantity: 55,
      reason: "found cases",
    });
    expect((await agree(lotManual.id)).increases).toBe(5);
    await inventory.adjustLot(pManual.id, store.id, admin, {
      lotId: lotManual.id,
      newQuantity: 48,
      reason: "damaged",
    });
    const afterManual = await agree(lotManual.id);
    expect(afterManual.writtenOff).toBe(7); // 55 → 48
    expect(afterManual.fromState).toBe(afterManual.fromLedger);

    // EXPIRED — held=0; write-off equals remaining at expire
    const pExp = await createProduct(store.id, {
      stock: 0,
      cost: 1,
      price: 3,
      skipLot: true,
      sku: `UCS-E-${Date.now()}`,
    });
    const lotExp = await prisma.lot.create({
      data: {
        lotNumber: "UCS-EXP",
        productId: pExp.id,
        storeId: store.id,
        quantityReceived: 30,
        quantityRemaining: 30,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(1),
        receivedAt: new Date(),
        status: LotStatus.EXPIRED,
      },
    });
    await prisma.inventoryWriteOff.create({
      data: {
        storeId: store.id,
        productId: pExp.id,
        lotId: lotExp.id,
        quantity: 30,
        reason: "EXPIRED",
        unitCost: new Prisma.Decimal(1),
        value: new Prisma.Decimal(30),
      },
    });
    const exp = await agree(lotExp.id);
    expect(exp.held).toBe(0);
    expect(exp.fromState).toBe(30);
    expect(exp.fromLedger).toBe(30);

    // RECALLED — held=0; remaining zeroed; write-off for units left sellable
    const pRec = await createProduct(store.id, {
      stock: 0,
      cost: 1,
      price: 3,
      skipLot: true,
      sku: `UCS-R-${Date.now()}`,
    });
    const lotRec = await prisma.lot.create({
      data: {
        lotNumber: "UCS-REC",
        productId: pRec.id,
        storeId: store.id,
        quantityReceived: 20,
        quantityRemaining: 0,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(1),
        receivedAt: new Date(),
        status: LotStatus.RECALLED,
      },
    });
    await prisma.inventoryWriteOff.create({
      data: {
        storeId: store.id,
        productId: pRec.id,
        lotId: lotRec.id,
        quantity: 20,
        reason: "RECALL",
        unitCost: new Prisma.Decimal(1),
        value: new Prisma.Decimal(20),
      },
    });
    const rec = await agree(lotRec.id);
    expect(rec.held).toBe(0);
    expect(rec.fromState).toBe(20);
    expect(rec.fromLedger).toBe(20);
  });
});

describe("trueUpShipment", () => {
  it("books variance for consumed units, updates remaining cost, is idempotent, moves to COSTED", async () => {
    const ctx = await receiveImportWithEstimate({ qty: 100, unitCost: 5, freight: 200 });
    // add-on at receive = 200/100 = 2 → unitCost 7
    expect(Number(ctx.lot.unitCost)).toBe(7);
    expect(Number(ctx.lot.landedAddOnApplied)).toBe(2);

    // Sell 40
    await salesService.createSale(ctx.store.id, asAuthUser(ctx.cashier), {
      items: [{ productId: ctx.product.id, quantity: 40 }],
      paymentMethod: PaymentMethod.CASH,
    });

    // Final freight 300 → new add-on 3, delta +1
    await shipment.supersedeCost(ctx.admin, ctx.s.id, ctx.estimateId, {
      amountForeign: 300,
    });

    const preview = await previewTrueUp(ctx.admin, ctx.s.id);
    expect(preview.hasChanges).toBe(true);
    expect(Number(preview.lots[0]!.deltaPerUnit)).toBe(1);
    expect(preview.lots[0]!.unitsConsumed).toBe(40);
    expect(Number(preview.totalVarianceUsd)).toBe(40); // 40 × $1

    const result = await trueUpShipment(ctx.admin, ctx.s.id);
    expect(result.wroteChanges).toBe(true);
    expect(result.movedToCosted).toBe(true);

    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: ctx.lot.id } });
    expect(Number(lot.landedAddOnApplied)).toBe(3);
    expect(Number(lot.unitCost)).toBe(8); // 5 + 3
    expect(lot.quantityRemaining).toBe(60);

    const variance = await prisma.landedCostVariance.findFirstOrThrow({
      where: { lotId: lot.id, reason: LandedCostVarianceReason.TRUE_UP },
    });
    expect(variance.units).toBe(40);
    expect(Number(variance.amountUsd)).toBe(40);

    const ship = await prisma.importShipment.findUniqueOrThrow({ where: { id: ctx.s.id } });
    expect(ship.status).toBe(ImportShipmentStatus.COSTED);

    // Sale snapshots stay at the pre-true-up landed cost (invoice 5 + estimate add-on 2).
    const sil = await prisma.saleItemLot.findFirstOrThrow({ where: { lotId: lot.id } });
    expect(Number(sil.unitCostSnapshot)).toBe(7);
    expect(sil.quantity).toBe(40);

    // Idempotent — second run writes nothing
    const again = await trueUpShipment(ctx.admin, ctx.s.id);
    expect(again.wroteChanges).toBe(false);
    const varianceCount = await prisma.landedCostVariance.count({
      where: { lotId: lot.id, reason: LandedCostVarianceReason.TRUE_UP },
    });
    expect(varianceCount).toBe(1);

    // Identity: sold×snapshot + variance + remaining×new = received×final
    const soldValue = moneyDec(sil.unitCostSnapshot.mul(sil.quantity));
    const remValue = moneyDec(lot.unitCost.mul(lot.quantityRemaining));
    const lhs = moneyDec(soldValue.add(variance.amountUsd).add(remValue));
    const rhs = moneyDec(unitCostDec(8).mul(100));
    expect(lhs.toFixed(2)).toBe(rhs.toFixed(2));
  });

  it("refund restock after true-up writes RESTOCK_REVERSAL", async () => {
    const ctx = await receiveImportWithEstimate({ qty: 50, unitCost: 4, freight: 100 });
    // add-on 2, unit 6
    const { sale } = await salesService.createSale(ctx.store.id, asAuthUser(ctx.cashier), {
      items: [{ productId: ctx.product.id, quantity: 10 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    await salesService.finalizePaidSale(sale.id);

    await shipment.supersedeCost(ctx.admin, ctx.s.id, ctx.estimateId, {
      amountForeign: 150, // add-on 3, delta +1
    });
    await trueUpShipment(ctx.admin, ctx.s.id);

    await salesService.refundSale(sale.id, ctx.store.id, {
      createdByUserId: ctx.admin.id,
      restock: true,
    });

    const reversal = await prisma.landedCostVariance.findFirst({
      where: { lotId: ctx.lot.id, reason: LandedCostVarianceReason.RESTOCK_REVERSAL },
    });
    expect(reversal).toBeTruthy();
    expect(reversal!.units).toBe(-10);
    expect(Number(reversal!.deltaPerUnit)).toBe(1);
    expect(Number(reversal!.amountUsd)).toBe(-10);
  });

  it("true-up and concurrent sale keep cent identity; no deadlock", async () => {
    const { isDeadlockError } = await import("../src/lib/locks.js");
    // Several races — lock order (ImportShipment → Product → Lot) must not deadlock.
    for (let run = 0; run < 3; run++) {
      const ctx = await receiveImportWithEstimate({ qty: 80, unitCost: 5, freight: 160 });
      await shipment.supersedeCost(ctx.admin, ctx.s.id, ctx.estimateId, {
        amountForeign: 240, // add-on 3, delta +1
      });

      let trueUpResult: Awaited<ReturnType<typeof trueUpShipment>>;
      let saleResult: { id: string };
      try {
        [trueUpResult, saleResult] = await Promise.all([
          trueUpShipment(ctx.admin, ctx.s.id),
          salesService
            .createSale(ctx.store.id, asAuthUser(ctx.cashier), {
              items: [{ productId: ctx.product.id, quantity: 15 }],
              paymentMethod: PaymentMethod.CASH,
            })
            .then((r) => r.sale),
        ]);
      } catch (err) {
        expect(isDeadlockError(err)).toBe(false);
        throw err;
      }
      expect(trueUpResult.wroteChanges).toBe(true);

      const lot = await prisma.lot.findUniqueOrThrow({ where: { id: ctx.lot.id } });
      const finalUnit = unitCostDec(lot.unitCost);
      expect(Number(finalUnit)).toBe(8);

      const sils = await prisma.saleItemLot.findMany({ where: { lotId: lot.id } });
      const soldQty = sils.reduce((s, r) => s + r.quantity, 0);
      const soldValue = sils.reduce(
        (s, r) => s.add(moneyDec(r.unitCostSnapshot.mul(r.quantity))),
        new Prisma.Decimal(0),
      );
      const variances = await prisma.landedCostVariance.findMany({
        where: { lotId: lot.id, reason: LandedCostVarianceReason.TRUE_UP },
      });
      const varianceSum = variances.reduce(
        (s, v) => s.add(v.amountUsd),
        new Prisma.Decimal(0),
      );
      const remValue = moneyDec(lot.unitCost.mul(lot.quantityRemaining));
      const lhs = moneyDec(soldValue.add(varianceSum).add(remValue));
      const rhs = moneyDec(finalUnit.mul(ctx.qty));
      expect(lhs.toFixed(2)).toBe(rhs.toFixed(2));
      expect(soldQty + lot.quantityRemaining).toBe(ctx.qty);
      void saleResult;
    }
  });

  it("aborts whole shipment when consumed-unit checks disagree", async () => {
    const ctx = await receiveImportWithEstimate({ qty: 20, unitCost: 2, freight: 40 });
    await shipment.supersedeCost(ctx.admin, ctx.s.id, ctx.estimateId, {
      amountForeign: 60,
    });
    // Corrupt remaining without a matching ledger entry (after supersede — preview must not run first)
    await prisma.lot.update({
      where: { id: ctx.lot.id },
      data: { quantityRemaining: 10 },
    });
    await expect(trueUpShipment(ctx.admin, ctx.s.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("ledger drift"),
    });
  });

  it("recordSupplierPayment FX_DIFFERENCE flows through the same true-up", async () => {
    const ctx = await receiveImportWithEstimate({ qty: 50, unitCost: 4, freight: 100 });
    // Invoice total = 50 × 4 = 200. Pay 210 → FX_DIFFERENCE +10 → add-on 2.2, delta +0.2
    await shipment.supersedeCost(ctx.admin, ctx.s.id, ctx.estimateId, {
      amountForeign: 100, // keep freight FINAL so all costs final after FX
    });

    const paid = await shipment.recordSupplierPayment(ctx.admin, {
      poId: ctx.po.id,
      paidAmountUsd: 210,
      paymentReference: "WIRE-FX",
      confirmTrueUp: true,
    });
    expect(Number(paid.fxDifferenceUsd)).toBe(10);
    expect(paid.fxCostId).toBeTruthy();
    expect(paid.trueUpPreview?.hasChanges).toBe(true);
    expect(paid.trueUpResult?.wroteChanges).toBe(true);

    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: ctx.lot.id } });
    // freight 100/50=2 + FX 10/50=0.2 → add-on 2.2, unit 6.2
    expect(Number(lot.landedAddOnApplied)).toBe(2.2);
    expect(Number(lot.unitCost)).toBe(6.2);
  });
});
