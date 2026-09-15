/**
 * Procurement / purchasing for Harvestlink — suppliers, POs, goods receiving.
 *
 * Receiving increments Product.stock in the same transaction as StockAdjustment
 * (reason RECEIPT) and GoodsReceipt rows. Over/short receipts require explicit
 * acknowledgement — never silently accept a qty mismatch vs the PO.
 *
 * When unitCostActual differs from Product.cost, cost is updated with a weighted
 * average so margin reporting (Phase 21) reflects true landed cost.
 */
import {
  Prisma,
  PurchaseOrderStatus,
  Role,
  type GoodsReceipt,
  type PurchaseOrder,
  type Supplier,
  type SupplierProduct,
} from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

function money(value: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function assertAdmin(actor: AuthUser): void {
  if (actor.role !== Role.STORE_ADMIN && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Cashiers cannot access purchasing");
  }
}

/** STORE_ADMIN is locked to their store; COOP_ADMIN may target any store or co-op-level (null). */
function assertPoStoreAccess(actor: AuthUser, storeId: string | null): void {
  assertAdmin(actor);
  if (actor.role === Role.COOP_ADMIN) return;
  if (storeId === null) {
    throw new AppError(403, "Only COOP_ADMIN can create co-op-level purchase orders");
  }
  if (actor.storeId !== storeId) {
    throw new AppError(403, "Cannot manage purchase orders for another store");
  }
}

async function nextPoNumber(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT nextval('purchase_order_number_seq') AS n
  `;
  const n = Number(rows[0]?.n ?? 0);
  return `PO-${String(n).padStart(6, "0")}`;
}

function recomputePoTotals(
  lines: Array<{ orderedQty: number; unitCost: Prisma.Decimal }>,
  tax: Prisma.Decimal,
  shipping: Prisma.Decimal,
): { subtotal: Prisma.Decimal; total: Prisma.Decimal } {
  const subtotal = money(
    lines.reduce(
      (sum, line) => sum.add(money(line.unitCost).mul(line.orderedQty)),
      new Prisma.Decimal(0),
    ),
  );
  return { subtotal, total: money(subtotal.add(tax).add(shipping)) };
}

function lineIsComplete(line: {
  orderedQty: number;
  receivedQty: number;
  shortClosed: boolean;
}): boolean {
  return line.shortClosed || line.receivedQty >= line.orderedQty;
}

function derivePoStatus(
  lines: Array<{ orderedQty: number; receivedQty: number; shortClosed: boolean }>,
  current: PurchaseOrderStatus,
): PurchaseOrderStatus {
  if (
    current === PurchaseOrderStatus.CANCELLED ||
    current === PurchaseOrderStatus.DRAFT
  ) {
    return current;
  }
  if (!lines.length) return PurchaseOrderStatus.SUBMITTED;
  const anyReceived = lines.some((l) => l.receivedQty > 0 || l.shortClosed);
  const allComplete = lines.every(lineIsComplete);
  if (allComplete) return PurchaseOrderStatus.RECEIVED;
  if (anyReceived) return PurchaseOrderStatus.PARTIALLY_RECEIVED;
  return PurchaseOrderStatus.SUBMITTED;
}

// ─── Suppliers ───────────────────────────────────────────────────────────────

export type SupplierInput = {
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  paymentTerms?: string;
  leadTimeDays?: number;
  isActive?: boolean;
  notes?: string;
};

export async function listSuppliers(activeOnly = false): Promise<Supplier[]> {
  return prisma.supplier.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    orderBy: { name: "asc" },
  });
}

export async function getSupplier(id: string): Promise<
  Supplier & { products: Array<SupplierProduct & { product: { id: string; sku: string; name: string; storeId: string } }> }
> {
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    include: {
      products: {
        include: {
          product: { select: { id: true, sku: true, name: true, storeId: true } },
        },
        orderBy: { updatedAt: "desc" },
      },
    },
  });
  if (!supplier) throw new AppError(404, "Supplier not found");
  return supplier;
}

export async function createSupplier(actor: AuthUser, input: SupplierInput): Promise<Supplier> {
  assertAdmin(actor);
  if (actor.role === Role.STORE_ADMIN) {
    // Store admins may create vendors they buy from; co-op still owns the network catalog.
  }
  const name = input.name.trim();
  if (!name) throw new AppError(400, "Supplier name is required");

  return prisma.supplier.create({
    data: {
      name,
      contactName: input.contactName?.trim() ?? "",
      email: input.email?.trim() ?? "",
      phone: input.phone?.trim() ?? "",
      address: input.address?.trim() ?? "",
      paymentTerms: input.paymentTerms?.trim() || "NET30",
      leadTimeDays: input.leadTimeDays ?? 7,
      isActive: input.isActive ?? true,
      notes: input.notes?.trim() ?? "",
    },
  });
}

export async function updateSupplier(
  actor: AuthUser,
  id: string,
  input: Partial<SupplierInput>,
): Promise<Supplier> {
  assertAdmin(actor);
  await getSupplier(id);
  return prisma.supplier.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.contactName !== undefined ? { contactName: input.contactName.trim() } : {}),
      ...(input.email !== undefined ? { email: input.email.trim() } : {}),
      ...(input.phone !== undefined ? { phone: input.phone.trim() } : {}),
      ...(input.address !== undefined ? { address: input.address.trim() } : {}),
      ...(input.paymentTerms !== undefined ? { paymentTerms: input.paymentTerms.trim() } : {}),
      ...(input.leadTimeDays !== undefined ? { leadTimeDays: input.leadTimeDays } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
    },
  });
}

export type SupplierProductInput = {
  supplierId: string;
  productId: string;
  supplierSku?: string;
  caseSize?: number;
  caseCost: number;
  unitCost: number;
  minOrderQty?: number;
  isPreferred?: boolean;
};

export async function upsertSupplierProduct(
  actor: AuthUser,
  input: SupplierProductInput,
): Promise<SupplierProduct> {
  assertAdmin(actor);
  const product = await prisma.product.findUnique({ where: { id: input.productId } });
  if (!product) throw new AppError(404, "Product not found");
  if (actor.role === Role.STORE_ADMIN && actor.storeId !== product.storeId) {
    throw new AppError(403, "Cannot link suppliers to another store's products");
  }
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw new AppError(404, "Supplier not found");

  const caseSize = input.caseSize ?? 1;
  const minOrderQty = input.minOrderQty ?? 1;
  if (!Number.isInteger(caseSize) || caseSize < 1) {
    throw new AppError(400, "caseSize must be a positive integer");
  }
  if (!Number.isInteger(minOrderQty) || minOrderQty < 1) {
    throw new AppError(400, "minOrderQty must be a positive integer");
  }

  return prisma.$transaction(async (tx) => {
    if (input.isPreferred) {
      await tx.supplierProduct.updateMany({
        where: { productId: input.productId, isPreferred: true },
        data: { isPreferred: false },
      });
    }
    return tx.supplierProduct.upsert({
      where: {
        supplierId_productId: {
          supplierId: input.supplierId,
          productId: input.productId,
        },
      },
      create: {
        supplierId: input.supplierId,
        productId: input.productId,
        supplierSku: input.supplierSku?.trim() ?? "",
        caseSize,
        caseCost: money(input.caseCost),
        unitCost: money(input.unitCost),
        minOrderQty,
        isPreferred: input.isPreferred ?? false,
      },
      update: {
        supplierSku: input.supplierSku?.trim() ?? "",
        caseSize,
        caseCost: money(input.caseCost),
        unitCost: money(input.unitCost),
        minOrderQty,
        ...(input.isPreferred !== undefined ? { isPreferred: input.isPreferred } : {}),
      },
    });
  });
}

// ─── Purchase orders ─────────────────────────────────────────────────────────

export type PoLineInput = {
  productId: string;
  orderedQty: number;
  unitCost: number;
};

export type CreatePoInput = {
  supplierId: string;
  /** null = co-op-level PO (COOP_ADMIN only). */
  storeId?: string | null;
  expectedDate?: string | null;
  tax?: number;
  shipping?: number;
  lines: PoLineInput[];
  ipAddress?: string | null;
};

export type UpdatePoInput = {
  expectedDate?: string | null;
  tax?: number;
  shipping?: number;
  lines?: PoLineInput[];
  ipAddress?: string | null;
};

const poInclude = {
  supplier: true,
  store: true,
  lines: {
    include: {
      product: { select: { id: true, sku: true, name: true, storeId: true, stock: true } },
    },
  },
  receipts: {
    include: { lines: true },
    orderBy: { receivedAt: "desc" as const },
  },
};

async function loadPo(id: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: poInclude,
  });
  if (!po) throw new AppError(404, "Purchase order not found");
  return po;
}

function assertCanAccessPo(actor: AuthUser, po: { storeId: string | null }): void {
  assertPoStoreAccess(actor, po.storeId);
}

export async function listPurchaseOrders(
  actor: AuthUser,
  filter: { storeId?: string | null; status?: PurchaseOrderStatus; includeCoop?: boolean },
): Promise<PurchaseOrder[]> {
  assertAdmin(actor);
  const where: Prisma.PurchaseOrderWhereInput = {};

  if (actor.role === Role.STORE_ADMIN) {
    where.storeId = actor.storeId!;
  } else if (filter.storeId !== undefined) {
    where.storeId = filter.storeId;
  } else if (!filter.includeCoop) {
    // default: all POs for coop admin
  }

  if (filter.status) where.status = filter.status;

  return prisma.purchaseOrder.findMany({
    where,
    include: {
      supplier: { select: { id: true, name: true } },
      store: { select: { id: true, name: true } },
      lines: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getPurchaseOrder(actor: AuthUser, id: string) {
  const po = await loadPo(id);
  assertCanAccessPo(actor, po);
  return po;
}

export async function createPurchaseOrder(actor: AuthUser, input: CreatePoInput) {
  const storeId = input.storeId === undefined ? actor.storeId : input.storeId;
  assertPoStoreAccess(actor, storeId ?? null);

  if (!input.lines?.length) throw new AppError(400, "PO must include at least one line");
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier || !supplier.isActive) {
    throw new AppError(400, "Supplier not found or inactive");
  }

  const tax = money(input.tax ?? 0);
  const shipping = money(input.shipping ?? 0);
  const lineDrafts = input.lines.map((line) => {
    if (!Number.isInteger(line.orderedQty) || line.orderedQty <= 0) {
      throw new AppError(400, "orderedQty must be a positive integer");
    }
    const unitCost = money(line.unitCost);
    return {
      productId: line.productId,
      orderedQty: line.orderedQty,
      unitCost,
      lineTotal: money(unitCost.mul(line.orderedQty)),
    };
  });

  // Validate products belong to the PO store (when store-scoped).
  const products = await prisma.product.findMany({
    where: { id: { in: lineDrafts.map((l) => l.productId) } },
  });
  if (products.length !== lineDrafts.length) {
    throw new AppError(404, "One or more products were not found");
  }
  if (storeId) {
    for (const p of products) {
      if (p.storeId !== storeId) {
        throw new AppError(400, "All PO lines must be products of the destination store", {
          productId: p.id,
        });
      }
    }
  }

  const { subtotal, total } = recomputePoTotals(lineDrafts, tax, shipping);
  const expectedDate = input.expectedDate
    ? new Date(input.expectedDate)
    : new Date(Date.now() + supplier.leadTimeDays * 24 * 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    const poNumber = await nextPoNumber(tx);
    return tx.purchaseOrder.create({
      data: {
        poNumber,
        supplierId: input.supplierId,
        storeId,
        status: PurchaseOrderStatus.DRAFT,
        expectedDate,
        createdByUserId: actor.id,
        subtotal,
        tax,
        shipping,
        total,
        lines: { create: lineDrafts },
      },
      include: poInclude,
    });
  });
}

export async function updatePurchaseOrder(
  actor: AuthUser,
  id: string,
  input: UpdatePoInput,
) {
  const po = await loadPo(id);
  assertCanAccessPo(actor, po);
  if (po.status !== PurchaseOrderStatus.DRAFT) {
    throw new AppError(409, "Only DRAFT purchase orders can be edited");
  }

  const tax = input.tax !== undefined ? money(input.tax) : po.tax;
  const shipping = input.shipping !== undefined ? money(input.shipping) : po.shipping;

  let lineDrafts = po.lines.map((l) => ({
    productId: l.productId,
    orderedQty: l.orderedQty,
    unitCost: l.unitCost,
    lineTotal: l.lineTotal,
  }));

  if (input.lines) {
    if (!input.lines.length) throw new AppError(400, "PO must include at least one line");
    lineDrafts = input.lines.map((line) => {
      if (!Number.isInteger(line.orderedQty) || line.orderedQty <= 0) {
        throw new AppError(400, "orderedQty must be a positive integer");
      }
      const unitCost = money(line.unitCost);
      return {
        productId: line.productId,
        orderedQty: line.orderedQty,
        unitCost,
        lineTotal: money(unitCost.mul(line.orderedQty)),
      };
    });
  }

  const { subtotal, total } = recomputePoTotals(lineDrafts, tax, shipping);

  return prisma.$transaction(async (tx) => {
    if (input.lines) {
      await tx.purchaseOrderLine.deleteMany({ where: { poId: id } });
      await tx.purchaseOrderLine.createMany({
        data: lineDrafts.map((l) => ({
          poId: id,
          productId: l.productId,
          orderedQty: l.orderedQty,
          unitCost: l.unitCost,
          lineTotal: l.lineTotal,
        })),
      });
    }
    return tx.purchaseOrder.update({
      where: { id },
      data: {
        tax,
        shipping,
        subtotal,
        total,
        ...(input.expectedDate !== undefined
          ? { expectedDate: input.expectedDate ? new Date(input.expectedDate) : null }
          : {}),
      },
      include: poInclude,
    });
  });
}

export async function submitPurchaseOrder(
  actor: AuthUser,
  id: string,
  ipAddress?: string | null,
) {
  const po = await loadPo(id);
  assertCanAccessPo(actor, po);
  if (po.status !== PurchaseOrderStatus.DRAFT) {
    throw new AppError(409, "Only DRAFT purchase orders can be submitted");
  }
  if (!po.lines.length) throw new AppError(400, "Cannot submit an empty PO");

  const updated = await prisma.purchaseOrder.update({
    where: { id },
    data: {
      status: PurchaseOrderStatus.SUBMITTED,
      submittedAt: new Date(),
    },
    include: poInclude,
  });

  await writeAuditLog({
    userId: actor.id,
    storeId: po.storeId,
    action: AuditAction.PO_SUBMIT,
    entityType: "PurchaseOrder",
    entityId: po.id,
    before: { status: po.status },
    after: { status: updated.status, poNumber: po.poNumber },
    ipAddress: ipAddress ?? null,
  });

  return updated;
}

export async function cancelPurchaseOrder(
  actor: AuthUser,
  id: string,
  ipAddress?: string | null,
) {
  const po = await loadPo(id);
  assertCanAccessPo(actor, po);
  if (
    po.status !== PurchaseOrderStatus.DRAFT &&
    po.status !== PurchaseOrderStatus.SUBMITTED
  ) {
    throw new AppError(409, "Only DRAFT or SUBMITTED POs can be cancelled");
  }
  if (po.lines.some((l) => l.receivedQty > 0)) {
    throw new AppError(409, "Cannot cancel a PO that already has receipts");
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id },
    data: { status: PurchaseOrderStatus.CANCELLED },
    include: poInclude,
  });

  await writeAuditLog({
    userId: actor.id,
    storeId: po.storeId,
    action: AuditAction.PO_CANCEL,
    entityType: "PurchaseOrder",
    entityId: po.id,
    before: { status: po.status },
    after: { status: updated.status },
    ipAddress: ipAddress ?? null,
  });

  return updated;
}

// ─── Receiving ───────────────────────────────────────────────────────────────

export type ReceiveLineInput = {
  poLineId: string;
  quantityReceived: number;
  quantityRejected?: number;
  rejectionReason?: string;
  unitCostActual: number;
  /**
   * Required when quantityReceived exceeds remaining ordered qty on the line.
   * Over-receipt is allowed only with this explicit flag — never silently.
   */
  acknowledgeOverReceipt?: boolean;
  /**
   * When true, closes the line even if receivedQty < orderedQty after this receipt.
   * Requires acknowledgeShortReceipt — short-receipt is never silent.
   */
  closeShort?: boolean;
  acknowledgeShortReceipt?: boolean;
};

export type ReceiveGoodsInput = {
  invoiceNumber?: string | null;
  notes?: string | null;
  lines: ReceiveLineInput[];
  ipAddress?: string | null;
};

/**
 * Records a goods receipt against a PO.
 *
 * Stock math (per accepted unit):
 *   previousStock → previousStock + quantityReceived
 *   StockAdjustment.reason = "RECEIPT"
 *
 * Weighted-average cost when unitCostActual ≠ Product.cost:
 *   newCost = (previousStock × oldCost + quantityReceived × unitCostActual)
 *             / (previousStock + quantityReceived)
 *   If previousStock ≤ 0, newCost = unitCostActual (no reliable weight).
 *   This cost feeds margin reporting in Phase 21 — do not skip the update.
 */
export async function receiveGoods(
  actor: AuthUser,
  poId: string,
  input: ReceiveGoodsInput,
) {
  assertAdmin(actor);
  if (!input.lines?.length) throw new AppError(400, "Receipt must include at least one line");

  const result = await prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: poId },
      include: { lines: true },
    });
    if (!po) throw new AppError(404, "Purchase order not found");
    assertCanAccessPo(actor, po);

    if (
      po.status !== PurchaseOrderStatus.SUBMITTED &&
      po.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw new AppError(409, "PO is not open for receiving", { status: po.status });
    }

    const lineById = new Map(po.lines.map((l) => [l.id, l]));
    const costChanges: Array<{
      productId: string;
      before: string;
      after: string;
      quantityReceived: number;
      unitCostActual: string;
    }> = [];

    const receipt = await tx.goodsReceipt.create({
      data: {
        poId,
        receivedByUserId: actor.id,
        invoiceNumber: input.invoiceNumber?.trim() || null,
        notes: input.notes?.trim() || null,
      },
    });

    for (const raw of input.lines) {
      const poLine = lineById.get(raw.poLineId);
      if (!poLine) {
        throw new AppError(400, "poLineId is not on this purchase order", {
          poLineId: raw.poLineId,
        });
      }
      if (poLine.shortClosed) {
        throw new AppError(409, "PO line was already closed short", { poLineId: poLine.id });
      }

      const qtyIn = raw.quantityReceived;
      const qtyReject = raw.quantityRejected ?? 0;
      if (!Number.isInteger(qtyIn) || qtyIn < 0) {
        throw new AppError(400, "quantityReceived must be a non-negative integer");
      }
      if (!Number.isInteger(qtyReject) || qtyReject < 0) {
        throw new AppError(400, "quantityRejected must be a non-negative integer");
      }
      if (qtyIn === 0 && qtyReject === 0 && !raw.closeShort) {
        throw new AppError(400, "Receipt line must receive, reject, or close short");
      }
      if (qtyReject > 0 && !raw.rejectionReason?.trim()) {
        throw new AppError(400, "rejectionReason is required when rejecting units");
      }

      const remaining = Math.max(0, poLine.orderedQty - poLine.receivedQty);
      if (qtyIn > remaining) {
        // Over-receipt: never accept silently.
        if (!raw.acknowledgeOverReceipt) {
          throw new AppError(
            409,
            "Over-receipt: quantityReceived exceeds outstanding ordered qty — set acknowledgeOverReceipt to proceed",
            {
              poLineId: poLine.id,
              orderedQty: poLine.orderedQty,
              alreadyReceived: poLine.receivedQty,
              remaining,
              quantityReceived: qtyIn,
            },
          );
        }
      }

      const nextReceived = poLine.receivedQty + qtyIn;
      let shortClosed: boolean = poLine.shortClosed;
      if (raw.closeShort) {
        if (nextReceived >= poLine.orderedQty) {
          throw new AppError(400, "closeShort is only valid when the line remains short");
        }
        if (!raw.acknowledgeShortReceipt) {
          throw new AppError(
            409,
            "Short-receipt: closing a line below orderedQty requires acknowledgeShortReceipt",
            {
              poLineId: poLine.id,
              orderedQty: poLine.orderedQty,
              willHaveReceived: nextReceived,
            },
          );
        }
        shortClosed = true;
      }

      const unitCostActual = money(raw.unitCostActual);

      await tx.goodsReceiptLine.create({
        data: {
          receiptId: receipt.id,
          poLineId: poLine.id,
          productId: poLine.productId,
          quantityReceived: qtyIn,
          quantityRejected: qtyReject,
          rejectionReason: qtyReject > 0 ? raw.rejectionReason!.trim() : null,
          unitCostActual,
        },
      });

      await tx.purchaseOrderLine.update({
        where: { id: poLine.id },
        data: { receivedQty: nextReceived, shortClosed },
      });

      // Accepted units only — rejected stay out of sellable stock.
      if (qtyIn > 0) {
        const product = await tx.product.findUnique({ where: { id: poLine.productId } });
        if (!product) throw new AppError(404, "Product not found", { productId: poLine.productId });

        const previousStock = product.stock;
        const newStock = previousStock + qtyIn;

        await tx.product.update({
          where: { id: product.id },
          data: { stock: newStock },
        });

        await tx.stockAdjustment.create({
          data: {
            productId: product.id,
            storeId: product.storeId,
            adjustedById: actor.id,
            previousStock,
            newStock,
            delta: qtyIn,
            reason: "RECEIPT",
          },
        });

        // Weighted-average cost — drives margin reporting (Phase 21).
        // Formula: newCost = (oldStock × oldCost + qty × actual) / (oldStock + qty)
        // When oldStock ≤ 0 (empty/negative), there is no meaningful weight → use actual.
        if (!unitCostActual.eq(product.cost)) {
          let newCost: Prisma.Decimal;
          if (previousStock <= 0) {
            newCost = unitCostActual;
          } else {
            const numerator = money(product.cost).mul(previousStock).add(unitCostActual.mul(qtyIn));
            const denominator = previousStock + qtyIn;
            newCost = money(numerator.div(denominator));
          }
          await tx.product.update({
            where: { id: product.id },
            data: { cost: newCost },
          });
          costChanges.push({
            productId: product.id,
            before: money(product.cost).toFixed(2),
            after: newCost.toFixed(2),
            quantityReceived: qtyIn,
            unitCostActual: unitCostActual.toFixed(2),
          });
        }
      }

      // Refresh local copy for status derivation.
      poLine.receivedQty = nextReceived;
      poLine.shortClosed = shortClosed;
    }

    const refreshed = await tx.purchaseOrderLine.findMany({ where: { poId } });
    const nextStatus = derivePoStatus(refreshed, po.status);
    const updatedPo = await tx.purchaseOrder.update({
      where: { id: poId },
      data: { status: nextStatus },
      include: poInclude,
    });

    const fullReceipt = await tx.goodsReceipt.findUniqueOrThrow({
      where: { id: receipt.id },
      include: { lines: true },
    });

    return { receipt: fullReceipt, purchaseOrder: updatedPo, costChanges };
  });

  await writeAuditLog({
    userId: actor.id,
    storeId: result.purchaseOrder.storeId,
    action: AuditAction.PO_RECEIVE,
    entityType: "GoodsReceipt",
    entityId: result.receipt.id,
    after: {
      poId,
      poNumber: result.purchaseOrder.poNumber,
      status: result.purchaseOrder.status,
      invoiceNumber: result.receipt.invoiceNumber,
      lineCount: result.receipt.lines.length,
    },
    ipAddress: input.ipAddress ?? null,
  });

  for (const change of result.costChanges) {
    await writeAuditLog({
      userId: actor.id,
      storeId: result.purchaseOrder.storeId,
      action: AuditAction.PRODUCT_COST_CHANGE,
      entityType: "Product",
      entityId: change.productId,
      before: { cost: change.before },
      after: {
        cost: change.after,
        reason: "WEIGHTED_AVG_ON_RECEIPT",
        quantityReceived: change.quantityReceived,
        unitCostActual: change.unitCostActual,
        // newCost = (oldStock × oldCost + qty × actual) / (oldStock + qty)
        formula: "(oldStock*oldCost + qty*unitCostActual)/(oldStock+qty)",
      },
      ipAddress: input.ipAddress ?? null,
    });
  }

  return result;
}

// ─── Reorder suggestions ─────────────────────────────────────────────────────

export type ReorderSuggestion = {
  supplierId: string;
  supplierName: string;
  lines: Array<{
    productId: string;
    sku: string;
    name: string;
    storeId: string;
    available: number;
    reorderAt: number;
    caseSize: number;
    minOrderQty: number;
    unitCost: string;
    suggestedQty: number;
    lineTotal: string;
  }>;
  suggestedSubtotal: string;
};

/**
 * For products at/below reorderAt (using available = stock − reserved), propose draft
 * PO lines grouped by preferred supplier, rounded up to caseSize and minOrderQty.
 */
export async function suggestReorderDrafts(
  actor: AuthUser,
  storeId: string,
): Promise<ReorderSuggestion[]> {
  assertPoStoreAccess(actor, storeId);

  const products = await prisma.product.findMany({
    where: { storeId },
    include: {
      supplierProducts: {
        where: { isPreferred: true },
        include: { supplier: true },
      },
    },
  });

  const bySupplier = new Map<string, ReorderSuggestion>();

  for (const product of products) {
    const available = product.stock - product.reserved;
    if (available > product.reorderAt) continue;

    const link = product.supplierProducts[0];
    if (!link || !link.supplier.isActive) continue;

    // Bring available back above reorderAt, then honor minOrderQty + case packs.
    const deficit = product.reorderAt - available + 1;
    let suggestedQty = Math.max(deficit, link.minOrderQty);
    if (link.caseSize > 1) {
      suggestedQty = Math.ceil(suggestedQty / link.caseSize) * link.caseSize;
    }

    const unitCost = money(link.unitCost);
    const lineTotal = money(unitCost.mul(suggestedQty));

    let group = bySupplier.get(link.supplierId);
    if (!group) {
      group = {
        supplierId: link.supplierId,
        supplierName: link.supplier.name,
        lines: [],
        suggestedSubtotal: "0.00",
      };
      bySupplier.set(link.supplierId, group);
    }
    group.lines.push({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      storeId: product.storeId,
      available,
      reorderAt: product.reorderAt,
      caseSize: link.caseSize,
      minOrderQty: link.minOrderQty,
      unitCost: unitCost.toFixed(2),
      suggestedQty,
      lineTotal: lineTotal.toFixed(2),
    });
  }

  for (const group of bySupplier.values()) {
    const sub = group.lines.reduce(
      (sum, l) => sum.add(money(l.lineTotal)),
      new Prisma.Decimal(0),
    );
    group.suggestedSubtotal = money(sub).toFixed(2);
  }

  return [...bySupplier.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName));
}

export type { GoodsReceipt, PurchaseOrder, Supplier };
