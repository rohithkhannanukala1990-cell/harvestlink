/**
 * Landed-cost allocation — pure split of shipment costs onto lines, plus preview/receive helpers.
 *
 * allocateShipmentCosts is PURE (no DB) and reused in Phase 3 for pallet freight.
 * Cents are allocated by the largest-remainder method so pieces sum EXACTLY to amountUsd.
 *
 * trueUpShipment recomputes add-ons after FINAL costs change and books LandedCostVariance for
 * units already consumed. unitsConsumedFromLot is the SINGLE place consumed units are computed —
 * Phase 3 changes ONLY transferredOut and adds recursion into child lots.
 */
import {
  CostAllocationBasis,
  ImportShipmentStatus,
  LandedCostVarianceReason,
  LotStatus,
  Prisma,
  Role,
  ShipmentCostStatus,
  type Lot,
  type ShipmentCostType,
} from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { lockImportShipment, lockLots, lockProducts } from "../lib/locks.js";
import { moneyDec, unitCostDec } from "../lib/money.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

type Tx = Prisma.TransactionClient;

const money = moneyDec;

export type AllocatableLine = {
  id: string;
  customsValueUsd: Prisma.Decimal | string | number;
  grossWeightKg?: Prisma.Decimal | string | number | null;
  volumeCbm?: Prisma.Decimal | string | number | null;
  quantity: number;
  dutyAmountUsd?: Prisma.Decimal | string | number | null;
};

export type AllocatableCost = {
  id: string;
  costType: ShipmentCostType | string;
  amountUsd: Prisma.Decimal | string | number;
  allocationBasis: CostAllocationBasis;
  status: ShipmentCostStatus;
  supersedesCostId?: string | null;
};

export type LineAllocationResult = {
  lineId: string;
  goodsValueUsd: Prisma.Decimal;
  /** USD allocated to this line, keyed by costType (multiple costs of same type are summed). */
  allocatedByCostType: Record<string, Prisma.Decimal>;
  landedAddOnTotal: Prisma.Decimal;
  landedAddOnPerUnit: Prisma.Decimal;
  /** customs unit (goodsValue/qty) + landedAddOnPerUnit — preview; receive uses invoice + add-on. */
  landedUnitCost: Prisma.Decimal;
  upliftPercent: Prisma.Decimal;
};

function toDec(value: Prisma.Decimal | string | number | null | undefined): Prisma.Decimal {
  if (value == null) return new Prisma.Decimal(0);
  return new Prisma.Decimal(value);
}

function usdToCents(amount: Prisma.Decimal): number {
  return money(amount).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

function centsToUsd(cents: number): Prisma.Decimal {
  return money(new Prisma.Decimal(cents).div(100));
}

/**
 * Active costs: a FINAL row replaces the ESTIMATED one it supersedes.
 * Superseded estimates are dropped; everything else (unsuperseded estimates + finals) counts.
 */
export function selectActiveCosts<T extends AllocatableCost>(costs: T[]): T[] {
  const supersededIds = new Set(
    costs.filter((c) => c.supersedesCostId).map((c) => c.supersedesCostId!),
  );
  return costs.filter((c) => !supersededIds.has(c.id));
}

/**
 * Split `totalCents` across lines by non-negative weights using largest remainder.
 * Pieces are integers that sum EXACTLY to totalCents.
 * Negative totals (FX_DIFFERENCE credits) allocate the absolute amount then flip the sign.
 */
export function allocateCentsByLargestRemainder(
  totalCents: number,
  weights: number[],
): number[] {
  if (weights.length === 0) return [];
  if (!Number.isInteger(totalCents)) {
    throw new AppError(400, "totalCents must be an integer");
  }
  if (totalCents < 0) {
    return allocateCentsByLargestRemainder(-totalCents, weights).map((c) => -c);
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    throw new AppError(400, "Allocation basis weights must sum to a positive value");
  }

  const exact = weights.map((w) => (totalCents * w) / weightSum);
  const floors = exact.map((e) => Math.floor(e));
  const remainder = totalCents - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((e, i) => ({ i, frac: e - floors[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const result = [...floors];
  for (let k = 0; k < remainder; k++) {
    const idx = order[k]!.i;
    result[idx] = result[idx]! + 1;
  }
  return result;
}

function basisWeights(
  lines: AllocatableLine[],
  basis: CostAllocationBasis,
): number[] {
  return lines.map((line) => {
    switch (basis) {
      case CostAllocationBasis.VALUE:
        return toDec(line.customsValueUsd).toNumber();
      case CostAllocationBasis.WEIGHT:
        return toDec(line.grossWeightKg).toNumber();
      case CostAllocationBasis.VOLUME:
        return toDec(line.volumeCbm).toNumber();
      case CostAllocationBasis.QUANTITY:
        return line.quantity;
      case CostAllocationBasis.LINE_SPECIFIC:
        return toDec(line.dutyAmountUsd).toNumber();
      default:
        throw new AppError(400, `Unknown allocation basis: ${basis as string}`);
    }
  });
}

/**
 * PURE: split each cost's amountUsd across lines by its basis.
 * Allocate in cents by largest remainder so pieces sum EXACTLY to amountUsd.
 * A FINAL cost counts instead of the ESTIMATED one it supersedes.
 */
export function allocateShipmentCosts(
  lines: AllocatableLine[],
  costs: AllocatableCost[],
): LineAllocationResult[] {
  if (!lines.length) {
    throw new AppError(400, "allocateShipmentCosts requires at least one line");
  }
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new AppError(400, "Shipment line quantity must be a positive integer", {
        lineId: line.id,
      });
    }
  }

  const active = selectActiveCosts(costs);
  const addOnCentsByLine = new Map<string, number>(lines.map((l) => [l.id, 0]));
  const byTypeCents = new Map<string, Map<string, number>>();
  for (const line of lines) {
    byTypeCents.set(line.id, new Map());
  }

  for (const cost of active) {
    const totalCents = usdToCents(toDec(cost.amountUsd));
    const costType = String(cost.costType);

    if (cost.allocationBasis === CostAllocationBasis.LINE_SPECIFIC) {
      const dutyCents = lines.map((l) => usdToCents(toDec(l.dutyAmountUsd)));
      const dutySum = dutyCents.reduce((a, b) => a + b, 0);
      if (dutySum !== totalCents) {
        throw new AppError(
          400,
          "LINE_SPECIFIC dutyAmountUsd on lines must sum exactly to the cost amountUsd",
          {
            costId: cost.id,
            costType,
            costCents: totalCents,
            dutySumCents: dutySum,
          },
        );
      }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const cents = dutyCents[i]!;
        addOnCentsByLine.set(line.id, (addOnCentsByLine.get(line.id) ?? 0) + cents);
        const typeMap = byTypeCents.get(line.id)!;
        typeMap.set(costType, (typeMap.get(costType) ?? 0) + cents);
      }
      continue;
    }

    const weights = basisWeights(lines, cost.allocationBasis);
    const pieces = allocateCentsByLargestRemainder(totalCents, weights);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const cents = pieces[i]!;
      addOnCentsByLine.set(line.id, (addOnCentsByLine.get(line.id) ?? 0) + cents);
      const typeMap = byTypeCents.get(line.id)!;
      typeMap.set(costType, (typeMap.get(costType) ?? 0) + cents);
    }
  }

  return lines.map((line) => {
    const goodsValueUsd = money(toDec(line.customsValueUsd));
    const addOnCents = addOnCentsByLine.get(line.id) ?? 0;
    const landedAddOnTotal = centsToUsd(addOnCents);
    const landedAddOnPerUnit = unitCostDec(landedAddOnTotal.div(line.quantity));
    const customsUnit = unitCostDec(goodsValueUsd.div(line.quantity));
    const landedUnitCost = unitCostDec(customsUnit.add(landedAddOnPerUnit));
    const upliftPercent = goodsValueUsd.gt(0)
      ? money(landedAddOnTotal.div(goodsValueUsd).mul(100))
      : money(0);

    const allocatedByCostType: Record<string, Prisma.Decimal> = {};
    for (const [type, cents] of byTypeCents.get(line.id) ?? []) {
      allocatedByCostType[type] = centsToUsd(cents);
    }

    return {
      lineId: line.id,
      goodsValueUsd,
      allocatedByCostType,
      landedAddOnTotal,
      landedAddOnPerUnit,
      landedUnitCost,
      upliftPercent,
    };
  });
}

function assertCoopAdmin(actor: AuthUser): void {
  if (actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only COOP_ADMIN may manage landed-cost allocation / true-up");
  }
}

/**
 * Read-only preview of per-line / per-product landed cost before receiving.
 */
export async function previewAllocation(actor: AuthUser, shipmentId: string) {
  assertCoopAdmin(actor);

  const shipment = await prisma.importShipment.findUnique({
    where: { id: shipmentId },
    include: {
      lines: {
        include: {
          poLine: {
            include: {
              product: { select: { id: true, sku: true, name: true } },
              po: { select: { id: true, poNumber: true } },
            },
          },
        },
      },
      costs: true,
    },
  });
  if (!shipment) throw new AppError(404, "Shipment not found");
  if (shipment.status === ImportShipmentStatus.CANCELLED) {
    throw new AppError(409, "Cannot preview allocation on a cancelled shipment");
  }
  if (!shipment.lines.length) {
    throw new AppError(400, "Shipment has no lines — upsert shipment lines first");
  }

  const allocations = allocateShipmentCosts(
    shipment.lines.map((l) => ({
      id: l.id,
      customsValueUsd: l.customsValueUsd,
      grossWeightKg: l.grossWeightKg,
      volumeCbm: l.volumeCbm,
      quantity: l.quantity,
      dutyAmountUsd: l.dutyAmountUsd,
    })),
    shipment.costs,
  );

  const byLineId = new Map(allocations.map((a) => [a.lineId, a]));

  return {
    shipmentId: shipment.id,
    shipmentNumber: shipment.shipmentNumber,
    status: shipment.status,
    costCount: selectActiveCosts(shipment.costs).length,
    lines: shipment.lines.map((l) => {
      const alloc = byLineId.get(l.id)!;
      return {
        shipmentLineId: l.id,
        poLineId: l.poLineId,
        poId: l.poLine.po.id,
        poNumber: l.poLine.po.poNumber,
        productId: l.poLine.product.id,
        sku: l.poLine.product.sku,
        name: l.poLine.product.name,
        quantity: l.quantity,
        customsValueUsd: alloc.goodsValueUsd,
        allocatedByCostType: Object.fromEntries(
          Object.entries(alloc.allocatedByCostType).map(([k, v]) => [k, v.toFixed(2)]),
        ),
        landedAddOnTotal: alloc.landedAddOnTotal.toFixed(2),
        landedAddOnPerUnit: alloc.landedAddOnPerUnit.toFixed(4),
        landedUnitCost: alloc.landedUnitCost.toFixed(4),
        upliftPercent: alloc.upliftPercent.toFixed(2),
      };
    }),
  };
}

// ─── Consumed units + true-up ────────────────────────────────────────────────

export type LotConsumedUnits = {
  fromState: number;
  fromLedger: number;
  increases: number;
  held: number;
  transferredOut: number;
  soldPaid: number;
  restocked: number;
  writtenOff: number;
};

/**
 * Count consumed units two independent ways. Refuse to book cost unless they agree.
 *
 * A — from the lot's state:
 *       consumed = quantityReceived + increases − held − transferredOut
 * B — from the ledger:
 *       consumed = Σ paid SaleItemLot − Σ RefundRestockLot + Σ InventoryWriteOff(lotId)
 *
 * Phase 3 changes ONLY transferredOut and adds recursion into child lots.
 */
export async function unitsConsumedFromLot(
  tx: Tx,
  lot: Pick<Lot, "id" | "quantityReceived" | "quantityRemaining" | "status">,
): Promise<LotConsumedUnits> {
  const adjustments = await tx.stockAdjustment.findMany({
    where: { lotId: lot.id },
    select: { delta: true, reason: true, lotPreviousQty: true, lotNewQty: true },
  });

  let increases = 0;
  for (const adj of adjustments) {
    if (adj.reason === "RECEIPT" || adj.reason === "OPENING_STOCK") continue;
    const lotDelta =
      adj.lotNewQty != null && adj.lotPreviousQty != null
        ? adj.lotNewQty - adj.lotPreviousQty
        : adj.delta;
    if (lotDelta > 0) increases += lotDelta;
  }

  const status = lot.status as LotStatus;
  let held: number;
  if (
    status === LotStatus.ACTIVE ||
    status === LotStatus.DEPLETED ||
    status === LotStatus.QUARANTINED
  ) {
    // May be negative after an offline oversell — keep the sign.
    held = lot.quantityRemaining;
  } else if (status === LotStatus.EXPIRED || status === LotStatus.RECALLED) {
    // Expiry job writes units off but leaves quantityRemaining as it was.
    held = 0;
  } else {
    held = lot.quantityRemaining;
  }

  const transferredOut = 0; // Phase 3 fills this in
  const fromState = lot.quantityReceived + increases - held - transferredOut;

  const soldAgg = await tx.saleItemLot.aggregate({
    where: {
      lotId: lot.id,
      saleItem: { sale: { paidAt: { not: null } } },
    },
    _sum: { quantity: true },
  });
  const soldPaid = soldAgg._sum.quantity ?? 0;

  const restockAgg = await tx.refundRestockLot.aggregate({
    where: { lotId: lot.id },
    _sum: { quantity: true },
  });
  const restocked = restockAgg._sum.quantity ?? 0;

  const writeOffAgg = await tx.inventoryWriteOff.aggregate({
    where: { lotId: lot.id },
    _sum: { quantity: true },
  });
  const writtenOff = writeOffAgg._sum.quantity ?? 0;

  const fromLedger = soldPaid - restocked + writtenOff;

  return {
    fromState,
    fromLedger,
    increases,
    held,
    transferredOut,
    soldPaid,
    restocked,
    writtenOff,
  };
}

export type TrueUpLotPreview = {
  lotId: string;
  productId: string;
  poLineId: string;
  quantityReceived: number;
  unitsConsumed: number;
  previousAddOn: string;
  newAddOn: string;
  deltaPerUnit: string;
  previousUnitCost: string;
  newUnitCost: string;
  varianceAmountUsd: string;
};

export type TrueUpPreview = {
  shipmentId: string;
  shipmentNumber: string;
  status: ImportShipmentStatus;
  hasChanges: boolean;
  allCostsFinal: boolean;
  totalVarianceUsd: string;
  lots: TrueUpLotPreview[];
};

async function buildTrueUpPlan(
  tx: Tx,
  shipmentId: string,
): Promise<{
  shipmentNumber: string;
  status: ImportShipmentStatus;
  destinationStoreId: string;
  allCostsFinal: boolean;
  plans: Array<{
    lot: Lot;
    poLineId: string;
    newAddOn: Prisma.Decimal;
    deltaPerUnit: Prisma.Decimal;
    unitsConsumed: number;
    varianceAmountUsd: Prisma.Decimal;
    newUnitCost: Prisma.Decimal;
  }>;
}> {
  const shipment = await tx.importShipment.findUnique({
    where: { id: shipmentId },
    include: {
      lines: true,
      costs: true,
    },
  });
  if (!shipment) throw new AppError(404, "Shipment not found");
  if (
    shipment.status !== ImportShipmentStatus.RECEIVED &&
    shipment.status !== ImportShipmentStatus.COSTED
  ) {
    throw new AppError(
      409,
      "True-up requires shipment status RECEIVED or COSTED",
      { status: shipment.status },
    );
  }
  if (!shipment.lines.length) {
    throw new AppError(400, "Shipment has no lines");
  }

  const allocations = allocateShipmentCosts(
    shipment.lines.map((l) => ({
      id: l.id,
      customsValueUsd: l.customsValueUsd,
      grossWeightKg: l.grossWeightKg,
      volumeCbm: l.volumeCbm,
      quantity: l.quantity,
      dutyAmountUsd: l.dutyAmountUsd,
    })),
    shipment.costs,
  );
  const addOnByShipLine = new Map(allocations.map((a) => [a.lineId, a.landedAddOnPerUnit]));
  const poLineByShipLine = new Map(shipment.lines.map((l) => [l.id, l.poLineId]));
  const addOnByPoLine = new Map<string, Prisma.Decimal>();
  for (const [shipLineId, addOn] of addOnByShipLine) {
    const poLineId = poLineByShipLine.get(shipLineId)!;
    addOnByPoLine.set(poLineId, addOn);
  }

  const receiptLots = await tx.lot.findMany({
    where: { goodsReceiptLine: { shipmentId } },
    include: { goodsReceiptLine: { select: { poLineId: true, shipmentId: true } } },
  });

  const activeCosts = selectActiveCosts(shipment.costs);
  const allCostsFinal =
    activeCosts.length > 0 &&
    activeCosts.every((c) => c.status === ShipmentCostStatus.FINAL);

  const plans: Array<{
    lot: Lot;
    poLineId: string;
    newAddOn: Prisma.Decimal;
    deltaPerUnit: Prisma.Decimal;
    unitsConsumed: number;
    varianceAmountUsd: Prisma.Decimal;
    newUnitCost: Prisma.Decimal;
  }> = [];

  for (const lot of receiptLots) {
    const poLineId = lot.goodsReceiptLine?.poLineId;
    if (!poLineId) continue;
    const newAddOn = addOnByPoLine.get(poLineId);
    if (newAddOn == null) {
      throw new AppError(409, "Lot's PO line is not on this shipment's lines", {
        lotId: lot.id,
        poLineId,
      });
    }

    const consumed = await unitsConsumedFromLot(tx, lot);
    if (consumed.fromState !== consumed.fromLedger) {
      throw new AppError(
        409,
        "Lot consumed-unit ledger drift — true-up aborted for the whole shipment",
        {
          lotId: lot.id,
          fromState: consumed.fromState,
          fromLedger: consumed.fromLedger,
          detail: consumed,
        },
      );
    }

    const deltaPerUnit = unitCostDec(newAddOn.sub(lot.landedAddOnApplied));
    const unitsConsumed = consumed.fromState;
    const varianceAmountUsd = money(deltaPerUnit.mul(unitsConsumed));
    const newUnitCost = unitCostDec(lot.unitCost.add(deltaPerUnit));

    plans.push({
      lot,
      poLineId,
      newAddOn,
      deltaPerUnit,
      unitsConsumed,
      varianceAmountUsd,
      newUnitCost,
    });
  }

  return {
    shipmentNumber: shipment.shipmentNumber,
    status: shipment.status,
    destinationStoreId: shipment.destinationStoreId,
    allCostsFinal,
    plans,
  };
}

function planToPreview(
  shipmentId: string,
  meta: Awaited<ReturnType<typeof buildTrueUpPlan>>,
): TrueUpPreview {
  const lots: TrueUpLotPreview[] = meta.plans.map((p) => ({
    lotId: p.lot.id,
    productId: p.lot.productId,
    poLineId: p.poLineId,
    quantityReceived: p.lot.quantityReceived,
    unitsConsumed: p.unitsConsumed,
    previousAddOn: unitCostDec(p.lot.landedAddOnApplied).toFixed(4),
    newAddOn: p.newAddOn.toFixed(4),
    deltaPerUnit: p.deltaPerUnit.toFixed(4),
    previousUnitCost: unitCostDec(p.lot.unitCost).toFixed(4),
    newUnitCost: p.newUnitCost.toFixed(4),
    varianceAmountUsd: p.varianceAmountUsd.toFixed(2),
  }));
  const hasChanges = meta.plans.some((p) => !p.deltaPerUnit.eq(0));
  const totalVarianceUsd = money(
    meta.plans.reduce((s, p) => s.add(p.varianceAmountUsd), new Prisma.Decimal(0)),
  );
  return {
    shipmentId,
    shipmentNumber: meta.shipmentNumber,
    status: meta.status,
    hasChanges,
    allCostsFinal: meta.allCostsFinal,
    totalVarianceUsd: totalVarianceUsd.toFixed(2),
    lots,
  };
}

/** Read-only preview of per-lot true-up deltas and variance amount. */
export async function previewTrueUp(
  actor: AuthUser,
  shipmentId: string,
): Promise<TrueUpPreview> {
  assertCoopAdmin(actor);
  return prisma.$transaction(async (tx) => {
    const locked = await lockImportShipment(tx, shipmentId);
    if (!locked) throw new AppError(404, "Shipment not found");
    const meta = await buildTrueUpPlan(tx, shipmentId);
    return planToPreview(shipmentId, meta);
  });
}

async function recomputeProductCostFromActiveLots(tx: Tx, productId: string): Promise<void> {
  const lots = await tx.lot.findMany({
    where: { productId, status: LotStatus.ACTIVE },
    select: { quantityRemaining: true, unitCost: true },
  });
  let value = new Prisma.Decimal(0);
  let qty = 0;
  for (const lot of lots) {
    if (lot.quantityRemaining > 0) {
      value = value.add(lot.unitCost.mul(lot.quantityRemaining));
      qty += lot.quantityRemaining;
    }
  }
  if (qty <= 0) return;
  await tx.product.update({
    where: { id: productId },
    data: { cost: unitCostDec(value.div(qty)) },
  });
}

/**
 * Recompute landed add-ons from current costs; update remaining lot costs; book
 * LandedCostVariance for units already consumed. Idempotent when add-ons unchanged.
 */
export async function trueUpShipment(
  actor: AuthUser,
  shipmentId: string,
  ipAddress?: string | null,
): Promise<TrueUpPreview & { wroteChanges: boolean; movedToCosted: boolean }> {
  assertCoopAdmin(actor);

  const result = await prisma.$transaction(async (tx) => {
    const lockedShipment = await lockImportShipment(tx, shipmentId);
    if (!lockedShipment) throw new AppError(404, "Shipment not found");

    const meta = await buildTrueUpPlan(tx, shipmentId);
    const preview = planToPreview(shipmentId, meta);
    const changing = meta.plans.filter((p) => !p.deltaPerUnit.eq(0));

    if (!changing.length) {
      let movedToCosted = false;
      if (
        meta.allCostsFinal &&
        meta.status === ImportShipmentStatus.RECEIVED
      ) {
        await tx.importShipment.update({
          where: { id: shipmentId },
          data: { status: ImportShipmentStatus.COSTED },
        });
        await tx.shipmentEvent.create({
          data: {
            shipmentId,
            eventType: "STATUS_CHANGE",
            message: "RECEIVED → COSTED (true-up, no cost changes)",
            payload: { from: meta.status, to: ImportShipmentStatus.COSTED },
            createdByUserId: actor.id,
          },
        });
        movedToCosted = true;
      }
      return { preview, wroteChanges: false, movedToCosted };
    }

    const productIds = [...new Set(changing.map((p) => p.lot.productId))];
    await lockProducts(tx, productIds);
    await lockLots(
      tx,
      changing.map((p) => p.lot.id),
    );

    const lotBeforeAfter: Array<{
      lotId: string;
      before: { unitCost: string; landedAddOnApplied: string };
      after: { unitCost: string; landedAddOnApplied: string };
      unitsConsumed: number;
      varianceAmountUsd: string;
    }> = [];

    for (const plan of changing) {
      // Re-check consumed under locks (sale cannot interleave mid-update).
      const fresh = await tx.lot.findUniqueOrThrow({ where: { id: plan.lot.id } });
      const consumed = await unitsConsumedFromLot(tx, fresh);
      if (consumed.fromState !== consumed.fromLedger) {
        throw new AppError(
          409,
          "Lot consumed-unit ledger drift — true-up aborted for the whole shipment",
          {
            lotId: fresh.id,
            fromState: consumed.fromState,
            fromLedger: consumed.fromLedger,
          },
        );
      }
      const unitsConsumed = consumed.fromState;
      const deltaPerUnit = unitCostDec(plan.newAddOn.sub(fresh.landedAddOnApplied));
      if (deltaPerUnit.eq(0)) continue;

      const newUnitCost = unitCostDec(fresh.unitCost.add(deltaPerUnit));
      const varianceAmountUsd = money(deltaPerUnit.mul(unitsConsumed));

      await tx.lot.update({
        where: { id: fresh.id },
        data: {
          unitCost: newUnitCost,
          landedAddOnApplied: plan.newAddOn,
        },
      });

      if (unitsConsumed !== 0) {
        await tx.landedCostVariance.create({
          data: {
            shipmentId,
            lotId: fresh.id,
            deltaPerUnit,
            units: unitsConsumed,
            amountUsd: varianceAmountUsd,
            createdByUserId: actor.id,
            reason: LandedCostVarianceReason.TRUE_UP,
          },
        });
      }

      await recomputeProductCostFromActiveLots(tx, fresh.productId);

      lotBeforeAfter.push({
        lotId: fresh.id,
        before: {
          unitCost: unitCostDec(fresh.unitCost).toFixed(4),
          landedAddOnApplied: unitCostDec(fresh.landedAddOnApplied).toFixed(4),
        },
        after: {
          unitCost: newUnitCost.toFixed(4),
          landedAddOnApplied: plan.newAddOn.toFixed(4),
        },
        unitsConsumed,
        varianceAmountUsd: varianceAmountUsd.toFixed(2),
      });
    }

    let movedToCosted = false;
    if (meta.allCostsFinal && meta.status === ImportShipmentStatus.RECEIVED) {
      await tx.importShipment.update({
        where: { id: shipmentId },
        data: { status: ImportShipmentStatus.COSTED },
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId,
          eventType: "STATUS_CHANGE",
          message: "RECEIVED → COSTED (true-up)",
          payload: { from: meta.status, to: ImportShipmentStatus.COSTED },
          createdByUserId: actor.id,
        },
      });
      movedToCosted = true;
    } else {
      await tx.shipmentEvent.create({
        data: {
          shipmentId,
          eventType: "TRUE_UP",
          message: `True-up applied to ${lotBeforeAfter.length} lot(s)`,
          payload: { lots: lotBeforeAfter },
          createdByUserId: actor.id,
        },
      });
    }

    await writeAuditLog(
      {
        userId: actor.id,
        storeId: meta.destinationStoreId,
        action: AuditAction.SHIPMENT_TRUE_UP,
        entityType: "ImportShipment",
        entityId: shipmentId,
        before: { status: meta.status },
        after: {
          status: movedToCosted ? ImportShipmentStatus.COSTED : meta.status,
          lots: lotBeforeAfter,
          totalVarianceUsd: preview.totalVarianceUsd,
        },
        ipAddress: ipAddress ?? null,
      },
      { tx },
    );

    const refreshed = await buildTrueUpPlan(tx, shipmentId);
    return {
      preview: planToPreview(shipmentId, refreshed),
      wroteChanges: lotBeforeAfter.length > 0,
      movedToCosted,
    };
  });

  return {
    ...result.preview,
    wroteChanges: result.wroteChanges,
    movedToCosted: result.movedToCosted,
  };
}

/**
 * When refund-restock returns units to a lot that was trued-up after the sale's paidAt,
 * reverse the true-up COGS for those units (RESTOCK_REVERSAL, negative units).
 * Call in the same transaction as RefundRestockLot create.
 */
export async function recordRestockReversalVariances(
  tx: Tx,
  input: {
    lotId: string;
    quantity: number;
    salePaidAt: Date | null;
    createdByUserId: string | null;
    ipAddress?: string | null;
  },
): Promise<number> {
  if (input.quantity <= 0 || !input.salePaidAt || !input.createdByUserId) return 0;

  const trueUps = await tx.landedCostVariance.findMany({
    where: {
      lotId: input.lotId,
      reason: LandedCostVarianceReason.TRUE_UP,
      recognisedAt: { gt: input.salePaidAt },
    },
    orderBy: { recognisedAt: "asc" },
  });
  if (!trueUps.length) return 0;

  const netDelta = trueUps.reduce(
    (s, v) => s.add(v.deltaPerUnit),
    new Prisma.Decimal(0),
  );
  const deltaPerUnit = unitCostDec(netDelta);
  if (deltaPerUnit.eq(0)) return 0;

  const units = -input.quantity;
  const amountUsd = money(deltaPerUnit.mul(units));
  const shipmentId = trueUps.find((v) => v.shipmentId)?.shipmentId ?? null;

  await tx.landedCostVariance.create({
    data: {
      shipmentId,
      lotId: input.lotId,
      deltaPerUnit,
      units,
      amountUsd,
      createdByUserId: input.createdByUserId,
      reason: LandedCostVarianceReason.RESTOCK_REVERSAL,
    },
  });

  await writeAuditLog(
    {
      userId: input.createdByUserId,
      action: AuditAction.LANDED_COST_RESTOCK_REVERSAL,
      entityType: "Lot",
      entityId: input.lotId,
      after: {
        quantity: input.quantity,
        deltaPerUnit: deltaPerUnit.toFixed(4),
        amountUsd: amountUsd.toFixed(2),
        shipmentId,
      },
      ipAddress: input.ipAddress ?? null,
    },
    { tx },
  );

  return 1;
}
