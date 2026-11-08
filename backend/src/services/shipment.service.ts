/**
 * Import shipments — ocean/air containers, PO attachments, landed costs, status timeline.
 * COOP_ADMIN only. Estimates are superseded (never edited) after goods are received.
 */
import {
  CostAllocationBasis,
  ImportShipmentStatus,
  Incoterm,
  LocationType,
  Prisma,
  PurchaseOrderStatus,
  Role,
  ShipmentCostStatus,
  ShipmentCostType,
  ShipmentMode,
  type ImportShipment,
} from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { moneyDec, unitCostDec } from "../lib/money.js";
import { prisma } from "../lib/prisma.js";
import {
  previewTrueUp,
  trueUpShipment,
  type TrueUpPreview,
} from "./landedCost.service.js";
import type { AuthUser } from "../types/auth.js";

const money = moneyDec;

function assertCoopAdmin(actor: AuthUser): void {
  if (actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only COOP_ADMIN may manage import shipments");
  }
}

const ALLOWED_TRANSITIONS: Record<ImportShipmentStatus, ImportShipmentStatus[]> = {
  [ImportShipmentStatus.PLANNED]: [ImportShipmentStatus.BOOKED, ImportShipmentStatus.CANCELLED],
  [ImportShipmentStatus.BOOKED]: [ImportShipmentStatus.IN_TRANSIT, ImportShipmentStatus.CANCELLED],
  [ImportShipmentStatus.IN_TRANSIT]: [
    ImportShipmentStatus.AT_PORT,
    ImportShipmentStatus.CUSTOMS_HOLD,
    ImportShipmentStatus.CANCELLED,
  ],
  [ImportShipmentStatus.AT_PORT]: [
    ImportShipmentStatus.CUSTOMS_HOLD,
    ImportShipmentStatus.CLEARED,
  ],
  [ImportShipmentStatus.CUSTOMS_HOLD]: [
    ImportShipmentStatus.CLEARED,
    ImportShipmentStatus.AT_PORT,
  ],
  [ImportShipmentStatus.CLEARED]: [ImportShipmentStatus.DELIVERED],
  [ImportShipmentStatus.DELIVERED]: [ImportShipmentStatus.RECEIVED],
  [ImportShipmentStatus.RECEIVED]: [ImportShipmentStatus.COSTED],
  [ImportShipmentStatus.COSTED]: [ImportShipmentStatus.CLOSED],
  [ImportShipmentStatus.CLOSED]: [],
  [ImportShipmentStatus.CANCELLED]: [],
};

/** Statuses whose goods value counts as "value on the water". */
const ON_THE_WATER: ImportShipmentStatus[] = [
  ImportShipmentStatus.BOOKED,
  ImportShipmentStatus.IN_TRANSIT,
  ImportShipmentStatus.AT_PORT,
  ImportShipmentStatus.CUSTOMS_HOLD,
  ImportShipmentStatus.CLEARED,
  ImportShipmentStatus.DELIVERED,
];

const shipmentInclude = {
  destinationStore: { select: { id: true, name: true, locationType: true } },
  purchaseOrders: {
    include: {
      po: {
        include: {
          supplier: { select: { id: true, name: true, supplierType: true, country: true } },
          lines: true,
        },
      },
    },
  },
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
  costs: { orderBy: { createdAt: "asc" as const } },
  events: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.ImportShipmentInclude;

async function nextShipmentNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getUTCFullYear();
  const rows = await tx.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT nextval('import_shipment_number_seq') AS n
  `;
  const n = Number(rows[0]?.n ?? 0);
  return `IMP-${year}-${String(n).padStart(4, "0")}`;
}

async function loadShipment(id: string) {
  const shipment = await prisma.importShipment.findUnique({
    where: { id },
    include: shipmentInclude,
  });
  if (!shipment) throw new AppError(404, "Shipment not found");
  return shipment;
}

function defaultAllocationBasis(
  costType: ShipmentCostType,
  mode: ShipmentMode,
  linesHaveDuty: boolean,
): CostAllocationBasis {
  if (costType === ShipmentCostType.CUSTOMS_DUTY) {
    return linesHaveDuty ? CostAllocationBasis.LINE_SPECIFIC : CostAllocationBasis.VALUE;
  }
  if (costType === ShipmentCostType.INSURANCE) return CostAllocationBasis.VALUE;
  if (
    costType === ShipmentCostType.OCEAN_FREIGHT ||
    costType === ShipmentCostType.AIR_FREIGHT
  ) {
    if (mode === ShipmentMode.SEA_LCL) return CostAllocationBasis.VOLUME;
    if (mode === ShipmentMode.AIR) return CostAllocationBasis.WEIGHT;
    return CostAllocationBasis.VALUE; // FCL
  }
  return CostAllocationBasis.VALUE;
}

function goodsValueFromShipment(shipment: {
  purchaseOrders: Array<{ po: { total: Prisma.Decimal } }>;
  lines: Array<{ customsValueUsd: Prisma.Decimal }>;
}): Prisma.Decimal {
  if (shipment.lines.length) {
    return money(
      shipment.lines.reduce(
        (sum, line) => sum.add(line.customsValueUsd),
        new Prisma.Decimal(0),
      ),
    );
  }
  return money(
    shipment.purchaseOrders.reduce(
      (sum, link) => sum.add(link.po.total),
      new Prisma.Decimal(0),
    ),
  );
}

function activeCosts(costs: Array<{
  id: string;
  status: ShipmentCostStatus;
  amountUsd: Prisma.Decimal;
  supersedesCostId: string | null;
}>) {
  const supersededIds = new Set(
    costs.filter((c) => c.supersedesCostId).map((c) => c.supersedesCostId!),
  );
  return costs.filter((c) => !supersededIds.has(c.id));
}

function sumCostsByStatus(
  costs: Array<{
    id: string;
    status: ShipmentCostStatus;
    amountUsd: Prisma.Decimal;
    supersedesCostId: string | null;
  }>,
  status: ShipmentCostStatus,
): Prisma.Decimal {
  // Estimated total includes rows that were later superseded so getShipment can
  // still show estimate vs final. Final total is all FINAL rows. Effective
  // landed cost (activeCosts) prefers FINAL over superseded estimates.
  return money(
    costs
      .filter((c) => c.status === status)
      .reduce((sum, c) => sum.add(c.amountUsd), new Prisma.Decimal(0)),
  );
}

/** Effective landed cost: FINAL where present, else ESTIMATED (active rows only). */
function effectiveLandedCosts(costs: Array<{
  id: string;
  status: ShipmentCostStatus;
  amountUsd: Prisma.Decimal;
  supersedesCostId: string | null;
}>): Prisma.Decimal {
  const active = activeCosts(costs);
  const finals = active.filter((c) => c.status === ShipmentCostStatus.FINAL);
  const estimates = active.filter((c) => c.status === ShipmentCostStatus.ESTIMATED);
  const pool = finals.length ? finals : estimates;
  return money(pool.reduce((sum, c) => sum.add(c.amountUsd), new Prisma.Decimal(0)));
}

function summarizeShipment<T extends Awaited<ReturnType<typeof loadShipment>>>(shipment: T) {
  const goodsValueUsd = goodsValueFromShipment(shipment);
  const estimatedCostsUsd = sumCostsByStatus(shipment.costs, ShipmentCostStatus.ESTIMATED);
  const finalCostsUsd = sumCostsByStatus(shipment.costs, ShipmentCostStatus.FINAL);
  const landedCostsUsd = effectiveLandedCosts(shipment.costs);
  const landedTotalUsd = money(goodsValueUsd.add(landedCostsUsd));
  const upliftPercent = goodsValueUsd.gt(0)
    ? money(landedCostsUsd.div(goodsValueUsd).mul(100))
    : money(0);

  return {
    ...shipment,
    goodsValueUsd,
    estimatedCostsUsd,
    finalCostsUsd,
    landedCostsUsd,
    landedTotalUsd,
    upliftPercent,
  };
}

async function appendEvent(
  tx: Prisma.TransactionClient,
  input: {
    shipmentId: string;
    eventType: string;
    message?: string;
    payload?: Prisma.InputJsonValue;
    createdByUserId?: string | null;
  },
) {
  return tx.shipmentEvent.create({
    data: {
      shipmentId: input.shipmentId,
      eventType: input.eventType,
      message: input.message ?? "",
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      createdByUserId: input.createdByUserId ?? null,
    },
  });
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

export type CreateShipmentInput = {
  mode: ShipmentMode;
  incoterm: Incoterm;
  originPort?: string;
  destinationPort?: string;
  carrier?: string;
  vesselVoyage?: string;
  containerNumber?: string | null;
  billOfLadingNumber?: string | null;
  customsEntryNumber?: string | null;
  etd?: string | Date | null;
  eta?: string | Date | null;
  /** Defaults to CooperativeSettings.mainWarehouseId. Non-WAREHOUSE requires audited override. */
  destinationStoreId?: string;
  /** When true, COOP_ADMIN may set a non-WAREHOUSE destination (audited). */
  allowNonWarehouseDestination?: boolean;
  ipAddress?: string | null;
};

export type ShipmentLineInput = {
  poLineId: string;
  quantity: number;
  grossWeightKg?: number | null;
  volumeCbm?: number | null;
  htsCode?: string | null;
  dutyRatePercent?: number | null;
  customsValueUsd?: number | null;
  dutyAmountUsd?: number | null;
};

export type AddCostInput = {
  costType: ShipmentCostType;
  vendorName?: string;
  invoiceNumber?: string | null;
  currency?: string;
  amountForeign: number;
  fxRateToUsd?: number;
  allocationBasis?: CostAllocationBasis;
  status?: ShipmentCostStatus;
  paidAt?: string | Date | null;
  paidAmountUsd?: number | null;
  paymentReference?: string | null;
  ipAddress?: string | null;
};

export type SupersedeCostInput = {
  amountForeign: number;
  fxRateToUsd?: number;
  currency?: string;
  vendorName?: string;
  invoiceNumber?: string | null;
  allocationBasis?: CostAllocationBasis;
  paidAt?: string | Date | null;
  paidAmountUsd?: number | null;
  paymentReference?: string | null;
  ipAddress?: string | null;
  /** After superseding, run true-up (admin already confirmed the preview). */
  confirmTrueUp?: boolean;
};

export type TransitionStatusInput = {
  status: ImportShipmentStatus;
  holdReason?: string | null;
  actualDeparture?: string | Date | null;
  actualArrival?: string | Date | null;
  clearedAt?: string | Date | null;
  deliveredAt?: string | Date | null;
  eta?: string | Date | null;
  message?: string;
  ipAddress?: string | null;
};

export type SupplierPaymentInput = {
  poId: string;
  paidAmountUsd: number;
  paidAt?: string | Date;
  paymentReference?: string | null;
  ipAddress?: string | null;
  /** After booking FX_DIFFERENCE (if any), run true-up when admin confirmed preview. */
  confirmTrueUp?: boolean;
};

async function maybeTrueUpOffer(
  actor: AuthUser,
  shipmentId: string,
  confirmTrueUp: boolean | undefined,
  ipAddress?: string | null,
): Promise<{ trueUpPreview: TrueUpPreview | null; trueUpResult: Awaited<ReturnType<typeof trueUpShipment>> | null }> {
  const shipment = await prisma.importShipment.findUnique({
    where: { id: shipmentId },
    select: { status: true },
  });
  if (
    !shipment ||
    (shipment.status !== ImportShipmentStatus.RECEIVED &&
      shipment.status !== ImportShipmentStatus.COSTED)
  ) {
    return { trueUpPreview: null, trueUpResult: null };
  }
  const trueUpPreview = await previewTrueUp(actor, shipmentId);
  if (confirmTrueUp && trueUpPreview.hasChanges) {
    const trueUpResult = await trueUpShipment(actor, shipmentId, ipAddress);
    return { trueUpPreview, trueUpResult };
  }
  return { trueUpPreview, trueUpResult: null };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function createShipment(actor: AuthUser, input: CreateShipmentInput) {
  assertCoopAdmin(actor);

  const settings = await prisma.cooperativeSettings.findFirst({ orderBy: { createdAt: "asc" } });
  const destinationStoreId = input.destinationStoreId ?? settings?.mainWarehouseId ?? null;
  if (!destinationStoreId) {
    throw new AppError(400, "destinationStoreId required (or set CooperativeSettings.mainWarehouseId)");
  }

  const store = await prisma.store.findUnique({ where: { id: destinationStoreId } });
  if (!store || !store.isActive) throw new AppError(400, "Destination store not found or inactive");

  const isWarehouse = store.locationType === LocationType.WAREHOUSE;
  const override = Boolean(input.allowNonWarehouseDestination);
  if (!isWarehouse && !override) {
    throw new AppError(400, "destinationStoreId must be a WAREHOUSE unless COOP_ADMIN overrides");
  }

  const shipment = await prisma.$transaction(async (tx) => {
    const shipmentNumber = await nextShipmentNumber(tx);
    const created = await tx.importShipment.create({
      data: {
        shipmentNumber,
        mode: input.mode,
        incoterm: input.incoterm,
        originPort: input.originPort ?? "",
        destinationPort: input.destinationPort ?? "USHOU",
        carrier: input.carrier ?? "",
        vesselVoyage: input.vesselVoyage ?? "",
        containerNumber: input.containerNumber ?? null,
        billOfLadingNumber: input.billOfLadingNumber ?? null,
        customsEntryNumber: input.customsEntryNumber ?? null,
        etd: input.etd ? new Date(input.etd) : null,
        eta: input.eta ? new Date(input.eta) : null,
        destinationStoreId,
        createdByUserId: actor.id,
        status: ImportShipmentStatus.PLANNED,
      },
      include: shipmentInclude,
    });

    await appendEvent(tx, {
      shipmentId: created.id,
      eventType: "CREATED",
      message: `Shipment ${shipmentNumber} created`,
      payload: { status: created.status, mode: created.mode, destinationStoreId },
      createdByUserId: actor.id,
    });

    return created;
  });

  if (!isWarehouse && override) {
    await writeAuditLog({
      userId: actor.id,
      storeId: destinationStoreId,
      action: AuditAction.SHIPMENT_DESTINATION_OVERRIDE,
      entityType: "ImportShipment",
      entityId: shipment.id,
      after: {
        destinationStoreId,
        locationType: store.locationType,
        reason: "Non-WAREHOUSE destination approved by COOP_ADMIN",
      },
      ipAddress: input.ipAddress ?? null,
    });
  }

  await writeAuditLog({
    userId: actor.id,
    storeId: destinationStoreId,
    action: AuditAction.SHIPMENT_CREATE,
    entityType: "ImportShipment",
    entityId: shipment.id,
    after: {
      shipmentNumber: shipment.shipmentNumber,
      mode: shipment.mode,
      incoterm: shipment.incoterm,
      destinationStoreId,
    },
    ipAddress: input.ipAddress ?? null,
  });

  return summarizeShipment(await loadShipment(shipment.id));
}

export async function attachPurchaseOrder(
  actor: AuthUser,
  shipmentId: string,
  poId: string,
  ipAddress?: string | null,
) {
  assertCoopAdmin(actor);
  const shipment = await loadShipment(shipmentId);
  if (shipment.status === ImportShipmentStatus.CANCELLED) {
    throw new AppError(409, "Cannot attach a PO to a cancelled shipment");
  }
  if (shipment.status === ImportShipmentStatus.CLOSED) {
    throw new AppError(409, "Cannot attach a PO to a closed shipment");
  }

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { lines: true },
  });
  if (!po) throw new AppError(404, "Purchase order not found");
  if (
    po.status === PurchaseOrderStatus.DRAFT ||
    po.status === PurchaseOrderStatus.CANCELLED
  ) {
    throw new AppError(409, "Only submitted (or receiving) purchase orders can be shipped");
  }

  const existing = await prisma.importShipmentPurchaseOrder.findFirst({
    where: {
      poId,
      shipment: { status: { not: ImportShipmentStatus.CANCELLED } },
    },
    include: { shipment: { select: { id: true, shipmentNumber: true, status: true } } },
  });
  if (existing && existing.shipmentId !== shipmentId) {
    throw new AppError(409, "Purchase order is already on another active shipment", {
      shipmentId: existing.shipment.id,
      shipmentNumber: existing.shipment.shipmentNumber,
    });
  }
  if (existing?.shipmentId === shipmentId) {
    return summarizeShipment(shipment);
  }

  await prisma.$transaction(async (tx) => {
    await tx.importShipmentPurchaseOrder.create({
      data: { shipmentId, poId },
    });
    await appendEvent(tx, {
      shipmentId,
      eventType: "ATTACH_PO",
      message: `Attached ${po.poNumber}`,
      payload: { poId, poNumber: po.poNumber },
      createdByUserId: actor.id,
    });
  });

  await writeAuditLog({
    userId: actor.id,
    storeId: shipment.destinationStoreId,
    action: AuditAction.SHIPMENT_ATTACH_PO,
    entityType: "ImportShipment",
    entityId: shipmentId,
    after: { poId, poNumber: po.poNumber },
    ipAddress: ipAddress ?? null,
  });

  return summarizeShipment(await loadShipment(shipmentId));
}

export async function upsertShipmentLines(
  actor: AuthUser,
  shipmentId: string,
  lines: ShipmentLineInput[],
  ipAddress?: string | null,
) {
  assertCoopAdmin(actor);
  const shipment = await loadShipment(shipmentId);
  if (
    shipment.status === ImportShipmentStatus.CANCELLED ||
    shipment.status === ImportShipmentStatus.CLOSED
  ) {
    throw new AppError(409, "Cannot edit lines on a cancelled or closed shipment");
  }
  if (!lines.length) throw new AppError(400, "At least one shipment line is required");

  const attachedPoIds = new Set(shipment.purchaseOrders.map((l) => l.poId));
  if (!attachedPoIds.size) {
    throw new AppError(400, "Attach purchase orders before adding shipment lines");
  }

  const poLineIds = lines.map((l) => l.poLineId);
  const poLines = await prisma.purchaseOrderLine.findMany({
    where: { id: { in: poLineIds } },
  });
  if (poLines.length !== poLineIds.length) {
    throw new AppError(404, "One or more PO lines were not found");
  }
  for (const pl of poLines) {
    if (!attachedPoIds.has(pl.poId)) {
      throw new AppError(400, "Shipment line PO must be attached to this shipment", {
        poLineId: pl.id,
        poId: pl.poId,
      });
    }
  }
  const byId = new Map(poLines.map((p) => [p.id, p]));

  await prisma.$transaction(async (tx) => {
    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new AppError(400, "quantity must be a positive integer");
      }
      const poLine = byId.get(line.poLineId)!;
      const customsValueUsd =
        line.customsValueUsd !== undefined && line.customsValueUsd !== null
          ? money(line.customsValueUsd)
          : money(poLine.unitCost.mul(line.quantity));

      await tx.importShipmentLine.upsert({
        where: {
          shipmentId_poLineId: { shipmentId, poLineId: line.poLineId },
        },
        create: {
          shipmentId,
          poLineId: line.poLineId,
          quantity: line.quantity,
          grossWeightKg:
            line.grossWeightKg != null ? new Prisma.Decimal(line.grossWeightKg) : null,
          volumeCbm: line.volumeCbm != null ? new Prisma.Decimal(line.volumeCbm) : null,
          htsCode: line.htsCode ?? null,
          dutyRatePercent:
            line.dutyRatePercent != null ? new Prisma.Decimal(line.dutyRatePercent) : null,
          customsValueUsd,
          dutyAmountUsd:
            line.dutyAmountUsd != null ? money(line.dutyAmountUsd) : null,
        },
        update: {
          quantity: line.quantity,
          grossWeightKg:
            line.grossWeightKg !== undefined
              ? line.grossWeightKg != null
                ? new Prisma.Decimal(line.grossWeightKg)
                : null
              : undefined,
          volumeCbm:
            line.volumeCbm !== undefined
              ? line.volumeCbm != null
                ? new Prisma.Decimal(line.volumeCbm)
                : null
              : undefined,
          htsCode: line.htsCode !== undefined ? line.htsCode : undefined,
          dutyRatePercent:
            line.dutyRatePercent !== undefined
              ? line.dutyRatePercent != null
                ? new Prisma.Decimal(line.dutyRatePercent)
                : null
              : undefined,
          customsValueUsd,
          dutyAmountUsd:
            line.dutyAmountUsd !== undefined
              ? line.dutyAmountUsd != null
                ? money(line.dutyAmountUsd)
                : null
              : undefined,
        },
      });
    }

    await appendEvent(tx, {
      shipmentId,
      eventType: "UPSERT_LINES",
      message: `Upserted ${lines.length} shipment line(s)`,
      payload: { poLineIds },
      createdByUserId: actor.id,
    });
  });

  await writeAuditLog({
    userId: actor.id,
    storeId: shipment.destinationStoreId,
    action: AuditAction.SHIPMENT_UPSERT_LINES,
    entityType: "ImportShipment",
    entityId: shipmentId,
    after: { lineCount: lines.length, poLineIds },
    ipAddress: ipAddress ?? null,
  });

  return summarizeShipment(await loadShipment(shipmentId));
}

function resolveCostAmounts(input: {
  currency?: string;
  amountForeign: number;
  fxRateToUsd?: number;
  allowNegative?: boolean;
}): { currency: string; amountForeign: Prisma.Decimal; fxRateToUsd: Prisma.Decimal; amountUsd: Prisma.Decimal } {
  const currency = (input.currency ?? "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AppError(400, "currency must be a 3-letter ISO 4217 code");
  }
  const fxRateToUsd =
    currency === "USD" ? new Prisma.Decimal(1) : new Prisma.Decimal(input.fxRateToUsd ?? NaN);
  if (currency === "USD" && input.fxRateToUsd !== undefined && Number(input.fxRateToUsd) !== 1) {
    throw new AppError(400, "USD costs must use fxRateToUsd = 1");
  }
  if (!fxRateToUsd.isFinite() || fxRateToUsd.lte(0)) {
    throw new AppError(400, "fxRateToUsd must be a positive number");
  }
  const amountForeign = unitCostDec(input.amountForeign);
  // FX_DIFFERENCE may be signed (bank paid ≠ invoice × booked rate). Other costs stay ≥ 0.
  if (amountForeign.lt(0) && !input.allowNegative) {
    throw new AppError(400, "amountForeign must be non-negative");
  }
  return {
    currency,
    amountForeign,
    fxRateToUsd,
    amountUsd: money(amountForeign.mul(fxRateToUsd)),
  };
}

export async function addCost(
  actor: AuthUser,
  shipmentId: string,
  input: AddCostInput,
) {
  assertCoopAdmin(actor);
  const shipment = await loadShipment(shipmentId);
  if (shipment.status === ImportShipmentStatus.CANCELLED) {
    throw new AppError(409, "Cannot add costs to a cancelled shipment");
  }

  const linesHaveDuty = shipment.lines.some((l) => l.dutyAmountUsd != null);
  const defaultBasis = defaultAllocationBasis(input.costType, shipment.mode, linesHaveDuty);
  const allocationBasis = input.allocationBasis ?? defaultBasis;
  const amounts = resolveCostAmounts(input);
  const status = input.status ?? ShipmentCostStatus.ESTIMATED;

  const cost = await prisma.$transaction(async (tx) => {
    const created = await tx.shipmentCost.create({
      data: {
        shipmentId,
        costType: input.costType,
        vendorName: input.vendorName ?? "",
        invoiceNumber: input.invoiceNumber ?? null,
        currency: amounts.currency,
        amountForeign: amounts.amountForeign,
        fxRateToUsd: amounts.fxRateToUsd,
        amountUsd: amounts.amountUsd,
        allocationBasis,
        status,
        paidAt: input.paidAt ? new Date(input.paidAt) : null,
        paidAmountUsd:
          input.paidAmountUsd != null ? money(input.paidAmountUsd) : null,
        paymentReference: input.paymentReference ?? null,
      },
    });

    await appendEvent(tx, {
      shipmentId,
      eventType: "ADD_COST",
      message: `Added ${input.costType} ${status} ${amounts.amountUsd}`,
      payload: {
        costId: created.id,
        costType: input.costType,
        status,
        amountUsd: amounts.amountUsd.toString(),
        allocationBasis,
      },
      createdByUserId: actor.id,
    });

    return created;
  });

  if (input.allocationBasis && input.allocationBasis !== defaultBasis) {
    await writeAuditLog({
      userId: actor.id,
      storeId: shipment.destinationStoreId,
      action: AuditAction.SHIPMENT_ALLOCATION_OVERRIDE,
      entityType: "ShipmentCost",
      entityId: cost.id,
      after: {
        shipmentId,
        costType: input.costType,
        defaultBasis,
        allocationBasis,
      },
      ipAddress: input.ipAddress ?? null,
    });
  }

  await writeAuditLog({
    userId: actor.id,
    storeId: shipment.destinationStoreId,
    action: AuditAction.SHIPMENT_ADD_COST,
    entityType: "ShipmentCost",
    entityId: cost.id,
    after: {
      shipmentId,
      costType: input.costType,
      status,
      amountUsd: amounts.amountUsd.toString(),
      allocationBasis,
    },
    ipAddress: input.ipAddress ?? null,
  });

  return summarizeShipment(await loadShipment(shipmentId));
}

/**
 * Create a FINAL cost that replaces an ESTIMATED one. Never edit the estimate after
 * goods have been received against it — supersede instead.
 */
export async function supersedeCost(
  actor: AuthUser,
  shipmentId: string,
  estimatedCostId: string,
  input: SupersedeCostInput,
) {
  assertCoopAdmin(actor);
  const shipment = await loadShipment(shipmentId);
  const estimated = shipment.costs.find((c) => c.id === estimatedCostId);
  if (!estimated) throw new AppError(404, "Estimated cost not found on this shipment");
  if (estimated.status !== ShipmentCostStatus.ESTIMATED) {
    throw new AppError(409, "Only ESTIMATED costs can be superseded");
  }
  const already = shipment.costs.find((c) => c.supersedesCostId === estimatedCostId);
  if (already) {
    throw new AppError(409, "This estimate has already been superseded", {
      finalCostId: already.id,
    });
  }

  // Once goods are received against an estimate, never edit it — only supersede (this path).
  if (
    shipment.status === ImportShipmentStatus.RECEIVED ||
    shipment.status === ImportShipmentStatus.COSTED ||
    shipment.status === ImportShipmentStatus.CLOSED
  ) {
    // Allowed — supersede is the correct path post-receive.
  }

  const linesHaveDuty = shipment.lines.some((l) => l.dutyAmountUsd != null);
  const defaultBasis = defaultAllocationBasis(estimated.costType, shipment.mode, linesHaveDuty);
  const allocationBasis = input.allocationBasis ?? estimated.allocationBasis;
  const amounts = resolveCostAmounts({
    currency: input.currency ?? estimated.currency,
    amountForeign: input.amountForeign,
    fxRateToUsd: input.fxRateToUsd ?? Number(estimated.fxRateToUsd),
  });

  const finalCost = await prisma.$transaction(async (tx) => {
    const created = await tx.shipmentCost.create({
      data: {
        shipmentId,
        costType: estimated.costType,
        vendorName: input.vendorName ?? estimated.vendorName,
        invoiceNumber: input.invoiceNumber !== undefined ? input.invoiceNumber : estimated.invoiceNumber,
        currency: amounts.currency,
        amountForeign: amounts.amountForeign,
        fxRateToUsd: amounts.fxRateToUsd,
        amountUsd: amounts.amountUsd,
        allocationBasis,
        status: ShipmentCostStatus.FINAL,
        supersedesCostId: estimatedCostId,
        paidAt: input.paidAt ? new Date(input.paidAt) : null,
        paidAmountUsd:
          input.paidAmountUsd != null ? money(input.paidAmountUsd) : null,
        paymentReference: input.paymentReference ?? null,
      },
    });

    await appendEvent(tx, {
      shipmentId,
      eventType: "SUPERSEDE_COST",
      message: `Superseded ${estimated.costType} estimate with final ${amounts.amountUsd}`,
      payload: {
        estimatedCostId,
        finalCostId: created.id,
        amountUsd: amounts.amountUsd.toString(),
      },
      createdByUserId: actor.id,
    });

    return created;
  });

  if (allocationBasis !== defaultBasis && allocationBasis !== estimated.allocationBasis) {
    await writeAuditLog({
      userId: actor.id,
      storeId: shipment.destinationStoreId,
      action: AuditAction.SHIPMENT_ALLOCATION_OVERRIDE,
      entityType: "ShipmentCost",
      entityId: finalCost.id,
      after: {
        shipmentId,
        costType: estimated.costType,
        defaultBasis,
        allocationBasis,
      },
      ipAddress: input.ipAddress ?? null,
    });
  }

  await writeAuditLog({
    userId: actor.id,
    storeId: shipment.destinationStoreId,
    action: AuditAction.SHIPMENT_SUPERSEDE_COST,
    entityType: "ShipmentCost",
    entityId: finalCost.id,
    before: {
      estimatedCostId,
      amountUsd: estimated.amountUsd.toString(),
    },
    after: {
      finalCostId: finalCost.id,
      amountUsd: amounts.amountUsd.toString(),
      allocationBasis,
    },
    ipAddress: input.ipAddress ?? null,
  });

  const summarized = summarizeShipment(await loadShipment(shipmentId));
  const offer = await maybeTrueUpOffer(
    actor,
    shipmentId,
    input.confirmTrueUp,
    input.ipAddress,
  );
  return {
    ...summarized,
    trueUpPreview: offer.trueUpPreview,
    trueUpResult: offer.trueUpResult,
  };
}

export async function transitionStatus(
  actor: AuthUser,
  shipmentId: string,
  input: TransitionStatusInput,
) {
  assertCoopAdmin(actor);
  const shipment = await loadShipment(shipmentId);
  const next = input.status;
  const allowed = ALLOWED_TRANSITIONS[shipment.status] ?? [];
  if (!allowed.includes(next)) {
    throw new AppError(409, `Illegal status transition ${shipment.status} → ${next}`, {
      from: shipment.status,
      to: next,
      allowed,
    });
  }

  if (next === ImportShipmentStatus.CUSTOMS_HOLD) {
    const reason = (input.holdReason ?? "").trim();
    if (!reason) {
      throw new AppError(400, "holdReason is required when entering CUSTOMS_HOLD");
    }
  }

  const data: Prisma.ImportShipmentUpdateInput = {
    status: next,
    holdReason:
      next === ImportShipmentStatus.CUSTOMS_HOLD
        ? (input.holdReason ?? "").trim()
        : next === ImportShipmentStatus.CLEARED || next === ImportShipmentStatus.AT_PORT
          ? null
          : undefined,
  };

  if (input.actualDeparture !== undefined) {
    data.actualDeparture = input.actualDeparture ? new Date(input.actualDeparture) : null;
  } else if (next === ImportShipmentStatus.IN_TRANSIT && !shipment.actualDeparture) {
    data.actualDeparture = new Date();
  }
  if (input.actualArrival !== undefined) {
    data.actualArrival = input.actualArrival ? new Date(input.actualArrival) : null;
  } else if (
    (next === ImportShipmentStatus.AT_PORT || next === ImportShipmentStatus.CUSTOMS_HOLD) &&
    !shipment.actualArrival
  ) {
    data.actualArrival = new Date();
  }
  if (input.clearedAt !== undefined) {
    data.clearedAt = input.clearedAt ? new Date(input.clearedAt) : null;
  } else if (next === ImportShipmentStatus.CLEARED && !shipment.clearedAt) {
    data.clearedAt = new Date();
  }
  if (input.deliveredAt !== undefined) {
    data.deliveredAt = input.deliveredAt ? new Date(input.deliveredAt) : null;
  } else if (next === ImportShipmentStatus.DELIVERED && !shipment.deliveredAt) {
    data.deliveredAt = new Date();
  }
  if (input.eta !== undefined) {
    data.eta = input.eta ? new Date(input.eta) : null;
  }

  await prisma.$transaction(async (tx) => {
    await tx.importShipment.update({ where: { id: shipmentId }, data });
    await appendEvent(tx, {
      shipmentId,
      eventType: "STATUS_CHANGE",
      message: input.message ?? `${shipment.status} → ${next}`,
      payload: {
        from: shipment.status,
        to: next,
        holdReason: next === ImportShipmentStatus.CUSTOMS_HOLD ? input.holdReason : null,
      },
      createdByUserId: actor.id,
    });
    if (input.eta !== undefined && String(input.eta) !== String(shipment.eta)) {
      await appendEvent(tx, {
        shipmentId,
        eventType: "ETA_CHANGE",
        message: `ETA updated`,
        payload: {
          before: shipment.eta?.toISOString() ?? null,
          after: input.eta ? new Date(input.eta).toISOString() : null,
        },
        createdByUserId: actor.id,
      });
    }
  });

  await writeAuditLog({
    userId: actor.id,
    storeId: shipment.destinationStoreId,
    action: AuditAction.SHIPMENT_STATUS,
    entityType: "ImportShipment",
    entityId: shipmentId,
    before: { status: shipment.status },
    after: { status: next, holdReason: input.holdReason ?? null },
    ipAddress: input.ipAddress ?? null,
  });

  return summarizeShipment(await loadShipment(shipmentId));
}

export async function recordSupplierPayment(
  actor: AuthUser,
  input: SupplierPaymentInput,
) {
  assertCoopAdmin(actor);
  const po = await prisma.purchaseOrder.findUnique({ where: { id: input.poId } });
  if (!po) throw new AppError(404, "Purchase order not found");
  if (po.status === PurchaseOrderStatus.DRAFT || po.status === PurchaseOrderStatus.CANCELLED) {
    throw new AppError(409, "Cannot record payment on a draft or cancelled PO");
  }

  const paidAmountUsd = money(input.paidAmountUsd);
  if (paidAmountUsd.lte(0)) throw new AppError(400, "paidAmountUsd must be positive");
  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();

  // Invoice USD at the booked rate is already on PO.total (unitCost stays USD).
  const expectedUsd = money(po.total);
  const fxDiff = money(paidAmountUsd.sub(expectedUsd));

  const shipmentLink = await prisma.importShipmentPurchaseOrder.findFirst({
    where: {
      poId: input.poId,
      shipment: { status: { not: ImportShipmentStatus.CANCELLED } },
    },
    select: { shipmentId: true },
  });

  let fxCostId: string | null = null;
  const updated = await prisma.$transaction(async (tx) => {
    const poUpdated = await tx.purchaseOrder.update({
      where: { id: input.poId },
      data: {
        paidAmountUsd,
        paidAt,
        paymentReference: input.paymentReference ?? null,
      },
      include: { supplier: true, lines: true },
    });

    if (shipmentLink && !fxDiff.eq(0)) {
      const created = await tx.shipmentCost.create({
        data: {
          shipmentId: shipmentLink.shipmentId,
          costType: ShipmentCostType.FX_DIFFERENCE,
          vendorName: "FX settlement",
          invoiceNumber: input.paymentReference ?? null,
          currency: "USD",
          amountForeign: unitCostDec(fxDiff),
          fxRateToUsd: new Prisma.Decimal(1),
          amountUsd: fxDiff,
          allocationBasis: CostAllocationBasis.VALUE,
          status: ShipmentCostStatus.FINAL,
          paidAt,
          paidAmountUsd: fxDiff.gt(0) ? fxDiff : null,
          paymentReference: input.paymentReference ?? null,
        },
      });
      fxCostId = created.id;
      await appendEvent(tx, {
        shipmentId: shipmentLink.shipmentId,
        eventType: "FX_DIFFERENCE",
        message: `FX difference ${fxDiff} (paid ${paidAmountUsd} vs invoice ${expectedUsd})`,
        payload: {
          poId: input.poId,
          paidAmountUsd: paidAmountUsd.toString(),
          expectedUsd: expectedUsd.toString(),
          fxDifferenceUsd: fxDiff.toString(),
          costId: created.id,
        },
        createdByUserId: actor.id,
      });
    }

    return poUpdated;
  });

  await writeAuditLog({
    userId: actor.id,
    storeId: po.storeId,
    action: AuditAction.PO_SUPPLIER_PAYMENT,
    entityType: "PurchaseOrder",
    entityId: po.id,
    before: {
      paidAmountUsd: po.paidAmountUsd?.toString() ?? null,
      paidAt: po.paidAt?.toISOString() ?? null,
    },
    after: {
      paidAmountUsd: paidAmountUsd.toString(),
      paidAt: paidAt.toISOString(),
      paymentReference: input.paymentReference ?? null,
      fxDifferenceUsd: fxDiff.toString(),
      fxCostId,
      shipmentId: shipmentLink?.shipmentId ?? null,
    },
    ipAddress: input.ipAddress ?? null,
  });

  let trueUpPreview: TrueUpPreview | null = null;
  let trueUpResult: Awaited<ReturnType<typeof trueUpShipment>> | null = null;
  if (shipmentLink && fxCostId) {
    const offer = await maybeTrueUpOffer(
      actor,
      shipmentLink.shipmentId,
      input.confirmTrueUp,
      input.ipAddress,
    );
    trueUpPreview = offer.trueUpPreview;
    trueUpResult = offer.trueUpResult;
  }

  return {
    purchaseOrder: updated,
    fxDifferenceUsd: fxDiff.toFixed(2),
    fxCostId,
    shipmentId: shipmentLink?.shipmentId ?? null,
    trueUpPreview,
    trueUpResult,
  };
}

export async function getShipment(actor: AuthUser, id: string) {
  assertCoopAdmin(actor);
  return summarizeShipment(await loadShipment(id));
}

export async function listShipments(
  actor: AuthUser,
  filters?: { status?: ImportShipmentStatus; onTheWater?: boolean },
) {
  assertCoopAdmin(actor);

  const where: Prisma.ImportShipmentWhereInput = {};
  if (filters?.status) where.status = filters.status;
  if (filters?.onTheWater) where.status = { in: ON_THE_WATER };

  const rows = await prisma.importShipment.findMany({
    where,
    include: shipmentInclude,
    orderBy: { createdAt: "desc" },
  });

  const shipments = rows.map(summarizeShipment);
  const valueOnTheWater = money(
    shipments
      .filter((s) => ON_THE_WATER.includes(s.status))
      .reduce((sum, s) => sum.add(s.goodsValueUsd), new Prisma.Decimal(0)),
  );

  return { shipments, valueOnTheWater };
}

/** Exported for tests — status machine. */
export function assertTransitionAllowed(
  from: ImportShipmentStatus,
  to: ImportShipmentStatus,
): void {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new AppError(409, `Illegal status transition ${from} → ${to}`);
  }
}

export type { ImportShipment };
