/**
 * Lot / sale traceability — regulatory one-step-back / one-step-forward.
 *
 * Forward (recall): Lot → SaleItemLot → Sale → Member (+ contact details).
 *   The affected-customer list must be COMPLETE — a partial list is the failure mode that matters.
 *
 * Backward / genealogy: Lot → receipt (invoice + landed cost) → SourcingOrigin → FPO →
 *   ImportShipment (+ doc types/refs only) → PO → invoicing supplier.
 *   Only facts recorded on real lots — no defaults, no marketing copy.
 *
 * getProductProvenance: per ACTIVE lot across locations, shelf-label / website facts only.
 */
import {
  LotStatus,
  PaymentStatus,
  Prisma,
  Role,
  type FpoLegalForm,
  type FpoProfile,
  type OrganicStatus,
  type ShipmentDocType,
} from "@prisma/client";
import { AppError } from "../lib/errors.js";
import { unitCostDec } from "../lib/money.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

/** Sales that moved units off the shelf (customers who may hold product). */
const SOLD_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.REFUNDING,
  PaymentStatus.REFUNDED,
];

export type TraceMemberContact = {
  memberId: string;
  memberNumber: string;
  name: string;
  email: string;
  phone: string;
  mailingAddress: string;
  /** Total units of this lot (batch) purchased across included sales. */
  quantityPurchased: number;
  saleIds: string[];
};

export type TraceSaleSummary = {
  saleId: string;
  storeId: string;
  storeName: string;
  paymentStatus: PaymentStatus;
  paidAt: Date | null;
  memberId: string | null;
  quantityFromLot: number;
  saleItemIds: string[];
};

export type TraceLotLocation = {
  lotId: string;
  lotNumber: string;
  storeId: string;
  storeName: string;
  status: LotStatus;
  quantityRemaining: number;
  quantityReserved: number;
  quantityReceived: number;
};

export type TraceForwardResult = {
  lotId: string;
  lotNumber: string;
  productId: string;
  productSku: string;
  productName: string;
  /** Stores that hold (or held) this batch code — primary lot + same productId/lotNumber siblings. */
  locations: TraceLotLocation[];
  quantitySold: number;
  quantityRemaining: number;
  sales: TraceSaleSummary[];
  /** Deduplicated affected members with contact details — the recall outreach list. */
  members: TraceMemberContact[];
};

export type TraceSupplierNode = {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
};

export type TraceSourcingOriginNode = {
  state: string;
  district: string;
  village: string | null;
  crop: string;
  variety: string | null;
  harvestSeason: string | null;
  harvestDate: Date | null;
  contributingFarmerCount: number | null;
  organicStatus: OrganicStatus;
};

export type TraceFpoNode = {
  supplierId: string;
  name: string;
  legalForm: FpoLegalForm;
  /** Self-reported. Never shown without memberFarmerCountAsOf. */
  memberFarmerCount: number;
  memberFarmerCountAsOf: Date;
};

/** Cluster-level farm facts (SourcingOrigin + FPO). Null when no origin was recorded. */
export type TraceFarmNode = {
  sourcingOrigin: TraceSourcingOriginNode;
  fpo: TraceFpoNode;
};

export type TraceShipmentDocumentRef = {
  docType: string;
  referenceNumber: string | null;
};

export type TraceImportShipmentNode = {
  id: string;
  shipmentNumber: string;
  containerNumber: string | null;
  billOfLadingNumber: string | null;
  actualDeparture: Date | null;
  actualArrival: Date | null;
  customsEntryNumber: string | null;
  /** Type + reference only — never file bytes / storage keys. */
  documents: TraceShipmentDocumentRef[];
};

export type TraceGoodsReceiptNode = {
  receiptId: string;
  receivedAt: Date;
  invoiceNumber: string | null;
  lineId: string;
  quantityReceived: number;
  /** Invoice unit cost on the receipt line (USD, 4 dp). */
  unitCostActual: string;
  /** Landed-cost add-on per unit applied at receive (0 for domestic). */
  landedAddOnPerUnit: string;
  /** unitCostActual + landedAddOnPerUnit (4 dp). */
  landedUnitCost: string;
};

export type TracePurchaseOrderNode = {
  poId: string;
  poNumber: string;
  status: string;
  storeId: string | null;
};

export type TraceBackwardLot = {
  lotId: string;
  lotNumber: string;
  storeId: string;
  storeName: string;
  status: LotStatus;
  quantityFromSale: number;
  quantityRemaining: number;
  unitCostSnapshot: string;
  harvestDate: Date | null;
  packDate: Date | null;
  expiryDate: Date | null;
  countryOfOrigin: string | null;
  goodsReceipt: TraceGoodsReceiptNode | null;
  purchaseOrder: TracePurchaseOrderNode | null;
  /** Invoicing supplier (who was paid) — Lot.supplierId / PO.supplier. */
  supplier: TraceSupplierNode | null;
  sourcingOrigin: TraceSourcingOriginNode | null;
  fpo: TraceFpoNode | null;
  /** Convenience: sourcingOrigin + fpo when both recorded; else null. */
  farm: TraceFarmNode | null;
  importShipment: TraceImportShipmentNode | null;
};

export type TraceBackwardResult = {
  saleId: string;
  saleItemId: string | null;
  storeId: string;
  paymentStatus: PaymentStatus;
  lots: TraceBackwardLot[];
};

export type LotGenealogyResult = {
  lot: {
    id: string;
    lotNumber: string;
    status: LotStatus;
    quantityReceived: number;
    quantityRemaining: number;
    quantityReserved: number;
    unitCost: string;
    landedAddOnApplied: string;
    harvestDate: Date | null;
    packDate: Date | null;
    expiryDate: Date | null;
    countryOfOrigin: string | null;
    receivedAt: Date;
  };
  product: { id: string; sku: string; name: string; category: string };
  store: { id: string; name: string };
  upstream: {
    farm: TraceFarmNode | null;
    sourcingOrigin: TraceSourcingOriginNode | null;
    fpo: TraceFpoNode | null;
    importShipment: TraceImportShipmentNode | null;
    supplier: TraceSupplierNode | null;
    purchaseOrder: TracePurchaseOrderNode | null;
    goodsReceipt: TraceGoodsReceiptNode | null;
  };
  /** Downstream: sales + members who bought from this lot (same completeness rule as forward). */
  downstream: {
    quantitySold: number;
    sales: TraceSaleSummary[];
    members: TraceMemberContact[];
  };
};

export type ProductProvenanceLot = {
  lotId: string;
  lotNumber: string;
  storeId: string;
  storeName: string;
  /** Shelf-label / website line built only from recorded facts (no filler). */
  label: string;
  district: string | null;
  harvestSeason: string | null;
  contributingFarmerCount: number | null;
  fpoName: string | null;
  organicStatus: OrganicStatus | null;
};

export type ProductProvenanceResult = {
  catalogItemId: string;
  sku: string;
  name: string;
  lots: ProductProvenanceLot[];
};

function assertStoreResourceAccess(actor: AuthUser, resourceStoreId: string): void {
  if (actor.role === Role.COOP_ADMIN) {
    return;
  }
  if (actor.role !== Role.STORE_ADMIN) {
    throw new AppError(403, "Insufficient role for traceability");
  }
  if (!actor.storeId || actor.storeId !== resourceStoreId) {
    throw new AppError(403, "Cannot access another store's data");
  }
}

type SupplierRow = {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
};

type SourcingOriginRow = {
  state: string;
  district: string;
  village: string | null;
  crop: string;
  variety: string | null;
  harvestSeason: string | null;
  harvestDate: Date | null;
  contributingFarmerCount: number | null;
  organicStatus: OrganicStatus;
  fpoSupplier: SupplierRow & {
    fpoProfile: Pick<
      FpoProfile,
      "legalForm" | "memberFarmerCount" | "memberFarmerCountAsOf"
    > | null;
  };
};

type ShipmentDocRow = {
  docType: ShipmentDocType;
  referenceNumber: string | null;
};

type ImportShipmentRow = {
  id: string;
  shipmentNumber: string;
  containerNumber: string | null;
  billOfLadingNumber: string | null;
  actualDeparture: Date | null;
  actualArrival: Date | null;
  customsEntryNumber: string | null;
  documents: ShipmentDocRow[];
};

type GoodsReceiptLineRow = {
  id: string;
  quantityReceived: number;
  unitCostActual: Prisma.Decimal;
  landedAddOnPerUnit: Prisma.Decimal;
  receipt: {
    id: string;
    receivedAt: Date;
    invoiceNumber: string | null;
    po: {
      id: string;
      poNumber: string;
      status: string;
      storeId: string | null;
      supplier: SupplierRow;
    };
  };
  sourcingOrigin: SourcingOriginRow | null;
  shipment: ImportShipmentRow | null;
};

function mapSupplier(s: SupplierRow | null | undefined): TraceSupplierNode | null {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    contactName: s.contactName,
    email: s.email,
    phone: s.phone,
    address: s.address,
  };
}

function mapSourcingOrigin(
  origin: SourcingOriginRow | null | undefined,
): TraceSourcingOriginNode | null {
  if (!origin) return null;
  return {
    state: origin.state,
    district: origin.district,
    village: origin.village,
    crop: origin.crop,
    variety: origin.variety,
    harvestSeason: origin.harvestSeason,
    harvestDate: origin.harvestDate,
    contributingFarmerCount: origin.contributingFarmerCount,
    organicStatus: origin.organicStatus,
  };
}

function mapFpo(origin: SourcingOriginRow | null | undefined): TraceFpoNode | null {
  if (!origin) return null;
  const profile = origin.fpoSupplier.fpoProfile;
  if (!profile) return null;
  return {
    supplierId: origin.fpoSupplier.id,
    name: origin.fpoSupplier.name,
    legalForm: profile.legalForm as FpoLegalForm,
    memberFarmerCount: profile.memberFarmerCount,
    memberFarmerCountAsOf: profile.memberFarmerCountAsOf,
  };
}

function mapFarm(
  sourcingOrigin: TraceSourcingOriginNode | null,
  fpo: TraceFpoNode | null,
): TraceFarmNode | null {
  if (!sourcingOrigin || !fpo) return null;
  return { sourcingOrigin, fpo };
}

function mapImportShipment(
  shipment: ImportShipmentRow | null | undefined,
): TraceImportShipmentNode | null {
  if (!shipment) return null;
  return {
    id: shipment.id,
    shipmentNumber: shipment.shipmentNumber,
    containerNumber: shipment.containerNumber,
    billOfLadingNumber: shipment.billOfLadingNumber,
    actualDeparture: shipment.actualDeparture,
    actualArrival: shipment.actualArrival,
    customsEntryNumber: shipment.customsEntryNumber,
    documents: shipment.documents.map((d) => ({
      docType: d.docType,
      referenceNumber: d.referenceNumber,
    })),
  };
}

function mapGoodsReceipt(
  grl: GoodsReceiptLineRow | null | undefined,
): TraceGoodsReceiptNode | null {
  if (!grl) return null;
  const invoice = unitCostDec(grl.unitCostActual);
  const addOn = unitCostDec(grl.landedAddOnPerUnit);
  const landed = unitCostDec(invoice.add(addOn));
  return {
    receiptId: grl.receipt.id,
    receivedAt: grl.receipt.receivedAt,
    invoiceNumber: grl.receipt.invoiceNumber,
    lineId: grl.id,
    quantityReceived: grl.quantityReceived,
    unitCostActual: invoice.toFixed(4),
    landedAddOnPerUnit: addOn.toFixed(4),
    landedUnitCost: landed.toFixed(4),
  };
}

function mapPurchaseOrder(
  grl: GoodsReceiptLineRow | null | undefined,
): TracePurchaseOrderNode | null {
  const po = grl?.receipt.po;
  if (!po) return null;
  return {
    poId: po.id,
    poNumber: po.poNumber,
    status: po.status,
    storeId: po.storeId,
  };
}

/** Shelf-label line from recorded facts only — no filler words when a fact is missing. */
export function buildProvenanceLabel(parts: {
  district: string | null;
  harvestSeason: string | null;
  contributingFarmerCount: number | null;
  fpoName: string | null;
}): string {
  const bits: string[] = [];
  if (parts.district) bits.push(`${parts.district} district`);
  if (parts.harvestSeason) bits.push(parts.harvestSeason);
  if (parts.contributingFarmerCount != null) {
    bits.push(`${parts.contributingFarmerCount} farmers`);
  }
  if (parts.fpoName) bits.push(`via ${parts.fpoName}`);
  return bits.join(", ");
}

async function collectDownstream(lotIds: string[]): Promise<{
  quantitySold: number;
  sales: TraceSaleSummary[];
  members: TraceMemberContact[];
}> {
  const allocations = await prisma.saleItemLot.findMany({
    where: { lotId: { in: lotIds } },
    include: {
      saleItem: {
        include: {
          sale: {
            include: {
              member: true,
              store: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });

  const salesById = new Map<string, TraceSaleSummary>();
  const memberAgg = new Map<
    string,
    TraceMemberContact & { _saleIds: Set<string> }
  >();
  let quantitySold = 0;

  for (const alloc of allocations) {
    const sale = alloc.saleItem.sale;
    if (!SOLD_STATUSES.includes(sale.paymentStatus)) {
      continue;
    }
    quantitySold += alloc.quantity;

    const existingSale = salesById.get(sale.id);
    if (existingSale) {
      existingSale.quantityFromLot += alloc.quantity;
      if (!existingSale.saleItemIds.includes(alloc.saleItemId)) {
        existingSale.saleItemIds.push(alloc.saleItemId);
      }
    } else {
      salesById.set(sale.id, {
        saleId: sale.id,
        storeId: sale.storeId,
        storeName: sale.store.name,
        paymentStatus: sale.paymentStatus,
        paidAt: sale.paidAt,
        memberId: sale.memberId,
        quantityFromLot: alloc.quantity,
        saleItemIds: [alloc.saleItemId],
      });
    }

    if (sale.member) {
      const m = sale.member;
      let row = memberAgg.get(m.id);
      if (!row) {
        row = {
          memberId: m.id,
          memberNumber: m.memberNumber,
          name: m.name,
          email: m.email,
          phone: m.phone,
          mailingAddress: m.mailingAddress,
          quantityPurchased: 0,
          saleIds: [],
          _saleIds: new Set(),
        };
        memberAgg.set(m.id, row);
      }
      row.quantityPurchased += alloc.quantity;
      row._saleIds.add(sale.id);
    }
  }

  const members: TraceMemberContact[] = [...memberAgg.values()]
    .map(({ _saleIds, ...rest }) => ({
      ...rest,
      saleIds: [..._saleIds].sort(),
    }))
    .sort((a, b) => a.memberNumber.localeCompare(b.memberNumber));

  return {
    quantitySold,
    sales: [...salesById.values()].sort(
      (a, b) => (a.paidAt?.getTime() ?? 0) - (b.paidAt?.getTime() ?? 0),
    ),
    members,
  };
}

/**
 * Forward recall from a lot: every location for the batch, every sold sale, every member contact.
 * Sibling lots sharing productId + lotNumber (other stores) are included so multi-store receives
 * of the same batch code do not leave customers off the list.
 */
export async function traceForward(
  actor: AuthUser,
  lotId: string,
): Promise<TraceForwardResult> {
  const seed = await prisma.lot.findUnique({
    where: { id: lotId },
    include: {
      product: { select: { id: true, sku: true, name: true } },
      store: { select: { id: true, name: true } },
    },
  });
  if (!seed) {
    throw new AppError(404, "Lot not found");
  }
  assertStoreResourceAccess(actor, seed.storeId);

  // Same batch code at every store that received it (unique is per product+lotNumber+store).
  const batchLots = await prisma.lot.findMany({
    where: {
      productId: seed.productId,
      lotNumber: seed.lotNumber,
    },
    include: {
      store: { select: { id: true, name: true } },
    },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
  });

  const lotIds = batchLots.map((l) => l.id);
  const downstream = await collectDownstream(lotIds);
  const quantityRemaining = batchLots.reduce((s, l) => s + l.quantityRemaining, 0);

  return {
    lotId: seed.id,
    lotNumber: seed.lotNumber,
    productId: seed.productId,
    productSku: seed.product.sku,
    productName: seed.product.name,
    locations: batchLots.map((l) => ({
      lotId: l.id,
      lotNumber: l.lotNumber,
      storeId: l.storeId,
      storeName: l.store.name,
      status: l.status,
      quantityRemaining: l.quantityRemaining,
      quantityReserved: l.quantityReserved,
      quantityReceived: l.quantityReceived,
    })),
    quantitySold: downstream.quantitySold,
    quantityRemaining,
    sales: downstream.sales,
    members: downstream.members,
  };
}

const lotProvenanceInclude = {
  store: { select: { id: true, name: true } },
  supplier: true,
  goodsReceiptLine: {
    include: {
      receipt: {
        include: {
          po: {
            include: { supplier: true },
          },
        },
      },
      sourcingOrigin: {
        include: {
          fpoSupplier: {
            include: { fpoProfile: true },
          },
        },
      },
      shipment: {
        include: {
          documents: {
            select: { docType: true, referenceNumber: true },
            orderBy: { uploadedAt: "asc" as const },
          },
        },
      },
    },
  },
} as const;

function provenanceFromLot(lot: {
  supplier: SupplierRow | null;
  goodsReceiptLine: GoodsReceiptLineRow | null;
}): {
  goodsReceipt: TraceGoodsReceiptNode | null;
  purchaseOrder: TracePurchaseOrderNode | null;
  supplier: TraceSupplierNode | null;
  sourcingOrigin: TraceSourcingOriginNode | null;
  fpo: TraceFpoNode | null;
  farm: TraceFarmNode | null;
  importShipment: TraceImportShipmentNode | null;
} {
  const grl = lot.goodsReceiptLine;
  const sourcingOrigin = mapSourcingOrigin(grl?.sourcingOrigin);
  const fpo = mapFpo(grl?.sourcingOrigin);
  return {
    goodsReceipt: mapGoodsReceipt(grl),
    purchaseOrder: mapPurchaseOrder(grl),
    supplier: mapSupplier(grl?.receipt.po.supplier ?? lot.supplier),
    sourcingOrigin,
    fpo,
    farm: mapFarm(sourcingOrigin, fpo),
    importShipment: mapImportShipment(grl?.shipment),
  };
}

function buildBackwardLots(
  saleItemLots: Array<{
    quantity: number;
    unitCostSnapshot: Prisma.Decimal;
    lot: {
      id: string;
      lotNumber: string;
      storeId: string;
      status: LotStatus;
      quantityRemaining: number;
      harvestDate: Date | null;
      packDate: Date | null;
      expiryDate: Date | null;
      countryOfOrigin: string | null;
      supplier: SupplierRow | null;
      store: { id: string; name: string };
      goodsReceiptLine: GoodsReceiptLineRow | null;
    };
  }>,
): TraceBackwardLot[] {
  return saleItemLots.map((alloc) => {
    const lot = alloc.lot;
    return {
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      storeId: lot.storeId,
      storeName: lot.store.name,
      status: lot.status,
      quantityFromSale: alloc.quantity,
      quantityRemaining: lot.quantityRemaining,
      unitCostSnapshot: alloc.unitCostSnapshot.toFixed(4),
      harvestDate: lot.harvestDate,
      packDate: lot.packDate,
      expiryDate: lot.expiryDate,
      countryOfOrigin: lot.countryOfOrigin,
      ...provenanceFromLot(lot),
    };
  });
}

/**
 * One step back from a sale (or a single sale line): receipt costs, origin, FPO,
 * import shipment (doc types/refs), PO, invoicing supplier. Nulls when not recorded.
 */
export async function traceBackward(
  actor: AuthUser,
  input: { saleId?: string; saleItemId?: string },
): Promise<TraceBackwardResult> {
  if (!input.saleId && !input.saleItemId) {
    throw new AppError(400, "saleId or saleItemId is required");
  }
  if (input.saleId && input.saleItemId) {
    throw new AppError(400, "Pass saleId or saleItemId, not both");
  }

  if (input.saleItemId) {
    const saleItem = await prisma.saleItem.findUnique({
      where: { id: input.saleItemId },
      include: {
        sale: true,
        lotAllocations: {
          include: { lot: { include: lotProvenanceInclude } },
        },
      },
    });
    if (!saleItem) {
      throw new AppError(404, "Sale item not found");
    }
    assertStoreResourceAccess(actor, saleItem.sale.storeId);

    return {
      saleId: saleItem.saleId,
      saleItemId: saleItem.id,
      storeId: saleItem.sale.storeId,
      paymentStatus: saleItem.sale.paymentStatus,
      lots: buildBackwardLots(saleItem.lotAllocations),
    };
  }

  const sale = await prisma.sale.findUnique({
    where: { id: input.saleId! },
    include: {
      items: {
        include: {
          lotAllocations: {
            include: { lot: { include: lotProvenanceInclude } },
          },
        },
      },
    },
  });
  if (!sale) {
    throw new AppError(404, "Sale not found");
  }
  assertStoreResourceAccess(actor, sale.storeId);

  const allocs = sale.items.flatMap((item) => item.lotAllocations);
  return {
    saleId: sale.id,
    saleItemId: null,
    storeId: sale.storeId,
    paymentStatus: sale.paymentStatus,
    lots: buildBackwardLots(allocs),
  };
}

/**
 * Full provenance chain for one lot: upstream (receipt → origin → FPO → shipment → PO → supplier)
 * + downstream sales/members. Only recorded facts; nulls when absent.
 */
export async function getLotGenealogy(
  actor: AuthUser,
  lotId: string,
): Promise<LotGenealogyResult> {
  const lot = await prisma.lot.findUnique({
    where: { id: lotId },
    include: {
      product: { select: { id: true, sku: true, name: true, category: true } },
      ...lotProvenanceInclude,
    },
  });
  if (!lot) {
    throw new AppError(404, "Lot not found");
  }
  assertStoreResourceAccess(actor, lot.storeId);

  // Genealogy downstream is THIS lot only (not batch siblings) — the shelf node under inspection.
  const downstream = await collectDownstream([lot.id]);
  const upstream = provenanceFromLot(lot);

  return {
    lot: {
      id: lot.id,
      lotNumber: lot.lotNumber,
      status: lot.status,
      quantityReceived: lot.quantityReceived,
      quantityRemaining: lot.quantityRemaining,
      quantityReserved: lot.quantityReserved,
      unitCost: lot.unitCost.toFixed(4),
      landedAddOnApplied: unitCostDec(lot.landedAddOnApplied).toFixed(4),
      harvestDate: lot.harvestDate,
      packDate: lot.packDate,
      expiryDate: lot.expiryDate,
      countryOfOrigin: lot.countryOfOrigin,
      receivedAt: lot.receivedAt,
    },
    product: lot.product,
    store: lot.store,
    upstream: {
      farm: upstream.farm,
      sourcingOrigin: upstream.sourcingOrigin,
      fpo: upstream.fpo,
      importShipment: upstream.importShipment,
      supplier: upstream.supplier,
      purchaseOrder: upstream.purchaseOrder,
      goodsReceipt: upstream.goodsReceipt,
    },
    downstream,
  };
}

/**
 * Active-lot provenance for a network SKU — shelf labels / website / member pages.
 * Only facts recorded on real ACTIVE lots; empty label when nothing was recorded.
 */
export async function getProductProvenance(
  actor: AuthUser,
  catalogItemId: string,
): Promise<ProductProvenanceResult> {
  const catalog = await prisma.catalogItem.findUnique({
    where: { id: catalogItemId },
    select: { id: true, sku: true, name: true },
  });
  if (!catalog) {
    throw new AppError(404, "Catalog item not found");
  }

  const storeFilter =
    actor.role === Role.COOP_ADMIN
      ? {}
      : actor.role === Role.STORE_ADMIN && actor.storeId
        ? { storeId: actor.storeId }
        : null;
  if (storeFilter === null) {
    throw new AppError(403, "Insufficient role for product provenance");
  }

  const lots = await prisma.lot.findMany({
    where: {
      status: LotStatus.ACTIVE,
      product: { catalogItemId },
      ...storeFilter,
    },
    include: {
      store: { select: { id: true, name: true } },
      goodsReceiptLine: {
        include: {
          sourcingOrigin: {
            include: {
              fpoSupplier: {
                include: { fpoProfile: true },
              },
            },
          },
        },
      },
    },
    orderBy: [{ storeId: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
  });

  return {
    catalogItemId: catalog.id,
    sku: catalog.sku,
    name: catalog.name,
    lots: lots.map((lot) => {
      const origin = lot.goodsReceiptLine?.sourcingOrigin ?? null;
      const district = origin?.district ?? null;
      const harvestSeason = origin?.harvestSeason ?? null;
      const contributingFarmerCount = origin?.contributingFarmerCount ?? null;
      const fpoName = origin?.fpoSupplier.name ?? null;
      const organicStatus = origin?.organicStatus ?? null;
      return {
        lotId: lot.id,
        lotNumber: lot.lotNumber,
        storeId: lot.storeId,
        storeName: lot.store.name,
        label: buildProvenanceLabel({
          district,
          harvestSeason,
          contributingFarmerCount,
          fpoName,
        }),
        district,
        harvestSeason,
        contributingFarmerCount,
        fpoName,
        organicStatus,
      };
    }),
  };
}
