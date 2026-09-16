/**
 * Lot / sale traceability — regulatory one-step-back / one-step-forward.
 *
 * Forward (recall): Lot → SaleItemLot → Sale → Member (+ contact details).
 *   The affected-customer list must be COMPLETE — a partial list is the failure mode that matters.
 *
 * Backward: Sale/SaleItem → SaleItemLot → Lot → GoodsReceipt → PurchaseOrder → Supplier/FPO.
 *   Farm + import shipment nodes are placeholders until P1 provenance models land.
 *
 * Genealogy: farm→shelf chain in one response for regulators and the future member provenance page.
 */
import { PaymentStatus, Prisma, Role, type LotStatus } from "@prisma/client";
import { AppError } from "../lib/errors.js";
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
  goodsReceipt: {
    receiptId: string;
    receivedAt: Date;
    invoiceNumber: string | null;
    lineId: string;
    quantityReceived: number;
  } | null;
  purchaseOrder: {
    poId: string;
    poNumber: string;
    status: string;
    storeId: string | null;
  } | null;
  supplier: TraceSupplierNode | null;
  /** P1 placeholders — null until farm / import shipment models exist. */
  importShipment: null;
  farm: null;
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
    harvestDate: Date | null;
    packDate: Date | null;
    expiryDate: Date | null;
    countryOfOrigin: string | null;
    receivedAt: Date;
  };
  product: { id: string; sku: string; name: string; category: string };
  store: { id: string; name: string };
  /** Upstream chain (supplier → PO → receipt → lot). Farm/import null until P1. */
  upstream: {
    farm: null;
    importShipment: null;
    supplier: TraceSupplierNode | null;
    purchaseOrder: {
      poId: string;
      poNumber: string;
      status: string;
      storeId: string | null;
    } | null;
    goodsReceipt: {
      receiptId: string;
      receivedAt: Date;
      invoiceNumber: string | null;
      lineId: string;
      quantityReceived: number;
      unitCostActual: string;
    } | null;
  };
  /** Downstream: sales + members who bought from this lot (same completeness rule as forward). */
  downstream: {
    quantitySold: number;
    sales: TraceSaleSummary[];
    members: TraceMemberContact[];
  };
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

function mapSupplier(
  s: {
    id: string;
    name: string;
    contactName: string;
    email: string;
    phone: string;
    address: string;
  } | null,
): TraceSupplierNode | null {
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

async function buildBackwardLots(
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
      supplier: {
        id: string;
        name: string;
        contactName: string;
        email: string;
        phone: string;
        address: string;
      } | null;
      store: { id: string; name: string };
      goodsReceiptLine: {
        id: string;
        quantityReceived: number;
        unitCostActual: Prisma.Decimal;
        receipt: {
          id: string;
          receivedAt: Date;
          invoiceNumber: string | null;
          po: {
            id: string;
            poNumber: string;
            status: string;
            storeId: string | null;
            supplier: {
              id: string;
              name: string;
              contactName: string;
              email: string;
              phone: string;
              address: string;
            };
          };
        };
      } | null;
    };
  }>,
): Promise<TraceBackwardLot[]> {
  return saleItemLots.map((alloc) => {
    const lot = alloc.lot;
    const grl = lot.goodsReceiptLine;
    const po = grl?.receipt.po ?? null;
    const supplier = mapSupplier(po?.supplier ?? lot.supplier);

    return {
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      storeId: lot.storeId,
      storeName: lot.store.name,
      status: lot.status,
      quantityFromSale: alloc.quantity,
      quantityRemaining: lot.quantityRemaining,
      unitCostSnapshot: alloc.unitCostSnapshot.toFixed(2),
      harvestDate: lot.harvestDate,
      packDate: lot.packDate,
      expiryDate: lot.expiryDate,
      countryOfOrigin: lot.countryOfOrigin,
      goodsReceipt: grl
        ? {
            receiptId: grl.receipt.id,
            receivedAt: grl.receipt.receivedAt,
            invoiceNumber: grl.receipt.invoiceNumber,
            lineId: grl.id,
            quantityReceived: grl.quantityReceived,
          }
        : null,
      purchaseOrder: po
        ? {
            poId: po.id,
            poNumber: po.poNumber,
            status: po.status,
            storeId: po.storeId,
          }
        : null,
      supplier,
      importShipment: null,
      farm: null,
    };
  });
}

const lotBackwardInclude = {
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
    },
  },
} as const;

/**
 * One step back from a sale (or a single sale line): lots, receipt, PO, supplier/FPO.
 * Farm and import shipment are null until P1 provenance models land.
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
          include: { lot: { include: lotBackwardInclude } },
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
      lots: await buildBackwardLots(saleItem.lotAllocations),
    };
  }

  const sale = await prisma.sale.findUnique({
    where: { id: input.saleId! },
    include: {
      items: {
        include: {
          lotAllocations: {
            include: { lot: { include: lotBackwardInclude } },
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
    lots: await buildBackwardLots(allocs),
  };
}

/**
 * Full farm→shelf chain for one lot: upstream provenance + downstream sales/members.
 */
export async function getLotGenealogy(
  actor: AuthUser,
  lotId: string,
): Promise<LotGenealogyResult> {
  const lot = await prisma.lot.findUnique({
    where: { id: lotId },
    include: {
      product: { select: { id: true, sku: true, name: true, category: true } },
      store: { select: { id: true, name: true } },
      supplier: true,
      goodsReceiptLine: {
        include: {
          receipt: {
            include: {
              po: { include: { supplier: true } },
            },
          },
        },
      },
    },
  });
  if (!lot) {
    throw new AppError(404, "Lot not found");
  }
  assertStoreResourceAccess(actor, lot.storeId);

  // Genealogy downstream is THIS lot only (not batch siblings) — the shelf node under inspection.
  const downstream = await collectDownstream([lot.id]);
  const grl = lot.goodsReceiptLine;
  const po = grl?.receipt.po ?? null;

  return {
    lot: {
      id: lot.id,
      lotNumber: lot.lotNumber,
      status: lot.status,
      quantityReceived: lot.quantityReceived,
      quantityRemaining: lot.quantityRemaining,
      quantityReserved: lot.quantityReserved,
      unitCost: lot.unitCost.toFixed(2),
      harvestDate: lot.harvestDate,
      packDate: lot.packDate,
      expiryDate: lot.expiryDate,
      countryOfOrigin: lot.countryOfOrigin,
      receivedAt: lot.receivedAt,
    },
    product: lot.product,
    store: lot.store,
    upstream: {
      farm: null,
      importShipment: null,
      supplier: mapSupplier(po?.supplier ?? lot.supplier),
      purchaseOrder: po
        ? {
            poId: po.id,
            poNumber: po.poNumber,
            status: po.status,
            storeId: po.storeId,
          }
        : null,
      goodsReceipt: grl
        ? {
            receiptId: grl.receipt.id,
            receivedAt: grl.receipt.receivedAt,
            invoiceNumber: grl.receipt.invoiceNumber,
            lineId: grl.id,
            quantityReceived: grl.quantityReceived,
            unitCostActual: grl.unitCostActual.toFixed(2),
          }
        : null,
    },
    downstream,
  };
}
