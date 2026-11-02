/**
 * The only code that changes lot quantities and the Product.stock / Product.reserved rollup.
 *
 * Callers must already hold locks in LOCK ORDER (see lib/locks.ts): Product rows, then Lot rows.
 * Mutation helpers take those locked rows (not bare ids) so missing locks fail in dev/test.
 *
 * Product.stock  = Σ ACTIVE lot.quantityRemaining
 * Product.reserved = Σ ACTIVE lot.quantityReserved
 */
import { LotStatus, Prisma, type Lot, type Product } from "@prisma/client";
import { AppError } from "../lib/errors.js";
import type { LockedLotRow, LockedProductRow } from "../lib/locks.js";
import { prisma } from "../lib/prisma.js";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export type LotAllocation = {
  lotId: string;
  quantity: number;
  unitCost: Prisma.Decimal;
};

/** Locked FEFO lot plus planning field used only inside allocateFefo. */
export type WorkingLot = LockedLotRow & {
  /** Units already allocated to earlier lines in this transaction (planning only). */
  taken: number;
};

function assertDevTest(): boolean {
  return process.env.NODE_ENV !== "production";
}

function assertLockedProduct(product: LockedProductRow, productId: string): void {
  if (!assertDevTest()) return;
  if (product.id !== productId) {
    throw new Error(
      `stockEngine: locked product ${product.id} does not match productId ${productId} — lock Product first`,
    );
  }
}

function assertLockedLots(lots: LockedLotRow[], lotIds: string[]): void {
  if (!assertDevTest()) return;
  const have = new Set(lots.map((l) => l.id));
  for (const id of lotIds) {
    if (!have.has(id)) {
      throw new Error(`stockEngine: lot ${id} was not in the locked set — lock Lot rows first`);
    }
  }
}

function lotMap(lots: LockedLotRow[]): Map<string, LockedLotRow> {
  return new Map(lots.map((l) => [l.id, l]));
}

function workingLotAvailable(lot: WorkingLot): number {
  return lot.quantityRemaining - lot.quantityReserved - lot.taken;
}

/**
 * FEFO allocate `quantity` across mutable lot rows (already locked + FEFO-ordered).
 * Offline cash may drive the final lot's remaining negative when available is short.
 * Pure — does not write the database; mutates `taken` on the working lots.
 */
export function allocateFefo(
  lots: WorkingLot[],
  quantity: number,
  opts: { offlineSync: boolean; sku: string; productId: string },
): LotAllocation[] {
  const totalAvail = lots.reduce((s, l) => s + Math.max(0, workingLotAvailable(l)), 0);
  if (totalAvail < quantity && !opts.offlineSync) {
    throw new AppError(409, "Insufficient stock for product", {
      productId: opts.productId,
      sku: opts.sku,
      requested: quantity,
      available: totalAvail,
      stock: lots.reduce((s, l) => s + l.quantityRemaining, 0),
      reserved: lots.reduce((s, l) => s + l.quantityReserved, 0),
    });
  }
  if (lots.length === 0) {
    throw new AppError(409, "Insufficient stock for product", {
      productId: opts.productId,
      sku: opts.sku,
      requested: quantity,
      available: 0,
    });
  }

  const allocations: LotAllocation[] = [];
  let remaining = quantity;

  for (const lot of lots) {
    if (remaining <= 0) break;
    const avail = Math.max(0, workingLotAvailable(lot));
    if (avail <= 0) continue;
    const take = Math.min(remaining, avail);
    allocations.push({ lotId: lot.id, quantity: take, unitCost: lot.unitCost });
    lot.taken += take;
    remaining -= take;
  }

  if (remaining > 0 && opts.offlineSync) {
    const target = lots[lots.length - 1]!;
    const existing = allocations.find((a) => a.lotId === target.id);
    if (existing) existing.quantity += remaining;
    else {
      allocations.push({
        lotId: target.id,
        quantity: remaining,
        unitCost: target.unitCost,
      });
    }
    target.taken += remaining;
    remaining = 0;
  }

  if (remaining > 0) {
    throw new AppError(409, "Insufficient stock for product", {
      productId: opts.productId,
      sku: opts.sku,
      requested: quantity,
      available: totalAvail,
    });
  }

  return allocations;
}

/** Hold units across a card-payment gap: lot.quantityReserved += ; Product.reserved +=. */
export async function reserve(
  tx: Tx,
  product: LockedProductRow,
  lots: LockedLotRow[],
  allocations: LotAllocation[],
): Promise<void> {
  assertLockedProduct(product, product.id);
  assertLockedLots(
    lots,
    allocations.map((a) => a.lotId),
  );
  const lineQty = allocations.reduce((s, a) => s + a.quantity, 0);
  for (const alloc of allocations) {
    await tx.lot.update({
      where: { id: alloc.lotId },
      data: { quantityReserved: { increment: alloc.quantity } },
    });
  }
  await tx.product.update({
    where: { id: product.id },
    data: { reserved: { increment: lineQty } },
  });
}

/** Reverse of reserve — does not change physical stock / quantityRemaining. */
export async function release(
  tx: Tx,
  product: LockedProductRow,
  lots: LockedLotRow[],
  allocations: LotAllocation[],
): Promise<void> {
  assertLockedProduct(product, product.id);
  assertLockedLots(
    lots,
    allocations.map((a) => a.lotId),
  );
  const lineQty = allocations.reduce((s, a) => s + a.quantity, 0);
  for (const alloc of allocations) {
    const lotUpdated = await tx.lot.updateMany({
      where: {
        id: alloc.lotId,
        quantityReserved: { gte: alloc.quantity },
      },
      data: { quantityReserved: { decrement: alloc.quantity } },
    });
    if (lotUpdated.count !== 1) {
      throw new AppError(500, "Failed to release lot reservation", {
        lotId: alloc.lotId,
        quantity: alloc.quantity,
      });
    }
  }
  const updated = await tx.product.updateMany({
    where: {
      id: product.id,
      storeId: product.storeId,
      reserved: { gte: lineQty },
    },
    data: { reserved: { decrement: lineQty } },
  });
  if (updated.count !== 1) {
    throw new AppError(500, "Failed to release stock reservation", {
      productId: product.id,
      quantity: lineQty,
    });
  }
}

/**
 * Convert a held reservation into a physical decrement (card finalize, reservation intact).
 * quantityReserved −=, quantityRemaining −=, Product.reserved −=, Product.stock −=; DEPLETED at 0.
 */
export async function consumeReserved(
  tx: Tx,
  product: LockedProductRow,
  lots: LockedLotRow[],
  allocations: LotAllocation[],
): Promise<void> {
  assertLockedProduct(product, product.id);
  assertLockedLots(
    lots,
    allocations.map((a) => a.lotId),
  );
  const lineQty = allocations.reduce((s, a) => s + a.quantity, 0);
  for (const alloc of allocations) {
    await tx.lot.update({
      where: { id: alloc.lotId },
      data: {
        quantityRemaining: { decrement: alloc.quantity },
        quantityReserved: { decrement: alloc.quantity },
      },
    });
    const lotAfter = await tx.lot.findUniqueOrThrow({ where: { id: alloc.lotId } });
    if (lotAfter.quantityRemaining === 0) {
      await tx.lot.update({
        where: { id: alloc.lotId },
        data: { status: LotStatus.DEPLETED },
      });
    }
  }
  const productUpd = await tx.product.updateMany({
    where: {
      id: product.id,
      storeId: product.storeId,
      reserved: { gte: lineQty },
      stock: { gte: lineQty },
    },
    data: {
      stock: { decrement: lineQty },
      reserved: { decrement: lineQty },
    },
  });
  if (productUpd.count !== 1) {
    throw new AppError(500, "Failed to finalize product reservation rollup", {
      productId: product.id,
      quantity: lineQty,
    });
  }
}

/**
 * Decrement remaining without a prior reservation (cash sales, offline sync, last-chance finalize).
 * Offline sync may leave quantityRemaining / Product.stock negative when opts.offlineSync is true.
 */
export async function consumeDirect(
  tx: Tx,
  product: LockedProductRow,
  lots: LockedLotRow[],
  allocations: LotAllocation[],
  opts: { offlineSync?: boolean; requireAvailable?: boolean } = {},
): Promise<void> {
  assertLockedProduct(product, product.id);
  assertLockedLots(
    lots,
    allocations.map((a) => a.lotId),
  );
  const byId = lotMap(lots);
  const lineQty = allocations.reduce((s, a) => s + a.quantity, 0);

  if (opts.requireAvailable) {
    // Last-chance claim after a reservation was released: only take free units.
    for (const alloc of allocations) {
      const claim = await tx.$executeRaw`
        UPDATE "Lot"
        SET "quantityRemaining" = "quantityRemaining" - ${alloc.quantity},
            status = CASE
              WHEN ("quantityRemaining" - ${alloc.quantity}) = 0 THEN 'DEPLETED'::"LotStatus"
              ELSE status
            END
        WHERE id = ${alloc.lotId}
          AND "storeId" = ${product.storeId}
          AND status = 'ACTIVE'
          AND ("quantityRemaining" - "quantityReserved") >= ${alloc.quantity}
      `;
      if (claim !== 1) {
        throw new AppError(409, "Insufficient stock at payment finalization", {
          productId: product.id,
          lotId: alloc.lotId,
          quantity: alloc.quantity,
        });
      }
    }
    const productClaim = await tx.$executeRaw`
      UPDATE "Product"
      SET stock = stock - ${lineQty}
      WHERE id = ${product.id}
        AND "storeId" = ${product.storeId}
        AND (stock - reserved) >= ${lineQty}
    `;
    if (productClaim !== 1) {
      throw new AppError(409, "Insufficient stock at payment finalization", {
        productId: product.id,
        quantity: lineQty,
      });
    }
    return;
  }

  for (const alloc of allocations) {
    if (!byId.has(alloc.lotId)) {
      throw new AppError(500, "Allocation references unlocked lot", { lotId: alloc.lotId });
    }
    await tx.lot.update({
      where: { id: alloc.lotId },
      data: { quantityRemaining: { decrement: alloc.quantity } },
    });
    const lotAfter = await tx.lot.findUniqueOrThrow({ where: { id: alloc.lotId } });
    if (lotAfter.quantityRemaining === 0) {
      await tx.lot.update({
        where: { id: alloc.lotId },
        data: { status: LotStatus.DEPLETED },
      });
    }
  }
  // Cash / offline: Product.stock follows the line total (may go negative when offlineSync).
  await tx.product.update({
    where: { id: product.id },
    data: { stock: { decrement: lineQty } },
  });
  void opts.offlineSync;
}

/** Refund restock — return units to the ORIGINAL lots (may revive DEPLETED → ACTIVE). */
export async function restockToLots(
  tx: Tx,
  product: LockedProductRow,
  lots: LockedLotRow[],
  restorations: Array<{ lotId: string; quantity: number }>,
): Promise<void> {
  assertLockedProduct(product, product.id);
  assertLockedLots(
    lots,
    restorations.map((r) => r.lotId),
  );
  let restored = 0;
  for (const row of restorations) {
    if (row.quantity <= 0) continue;
    const lot = await tx.lot.update({
      where: { id: row.lotId },
      data: { quantityRemaining: { increment: row.quantity } },
    });
    if (lot.status === LotStatus.DEPLETED && lot.quantityRemaining > 0) {
      await tx.lot.update({
        where: { id: row.lotId },
        data: { status: LotStatus.ACTIVE },
      });
    }
    restored += row.quantity;
  }
  if (restored > 0) {
    await tx.product.update({
      where: { id: product.id },
      data: { stock: { increment: restored } },
    });
  }
}

export type AddLotInput = {
  lotNumber: string;
  barcode?: string | null;
  storeId: string;
  supplierId?: string | null;
  goodsReceiptLineId?: string | null;
  harvestDate?: Date | null;
  packDate?: Date | null;
  expiryDate?: Date | null;
  quantity: number;
  countryOfOrigin?: string | null;
  receivedAt?: Date;
  unitCost: Prisma.Decimal;
  status?: LotStatus;
};

/**
 * Create an ACTIVE lot and bump Product.stock by the same quantity in one place.
 * Lot.create with quantityRemaining lives here so the guard test can allow it.
 */
export async function addLot(tx: Tx, product: LockedProductRow, data: AddLotInput): Promise<Lot> {
  assertLockedProduct(product, product.id);
  if (data.quantity < 0) {
    throw new AppError(400, "addLot quantity must be non-negative");
  }
  const qty = data.quantity;
  const lot = await tx.lot.create({
    data: {
      lotNumber: data.lotNumber,
      barcode: data.barcode ?? null,
      productId: product.id,
      storeId: data.storeId,
      supplierId: data.supplierId ?? null,
      goodsReceiptLineId: data.goodsReceiptLineId ?? null,
      harvestDate: data.harvestDate ?? null,
      packDate: data.packDate ?? null,
      expiryDate: data.expiryDate ?? null,
      quantityReceived: qty,
      quantityRemaining: qty,
      quantityReserved: 0,
      status: data.status ?? LotStatus.ACTIVE,
      countryOfOrigin: data.countryOfOrigin ?? null,
      receivedAt: data.receivedAt ?? new Date(),
      unitCost: data.unitCost,
    },
  });
  if (qty > 0 && (data.status ?? LotStatus.ACTIVE) === LotStatus.ACTIVE) {
    await tx.product.update({
      where: { id: product.id },
      data: { stock: { increment: qty } },
    });
  }
  return lot;
}

/**
 * Remove `qty` from a lot's quantityRemaining and, when the lot is ACTIVE, from Product.stock.
 * Marks DEPLETED at 0. Used for write-offs / count shortfalls that stay on an ACTIVE (or become
 * depleted) lot.
 */
export async function removeFromLot(
  tx: Tx,
  product: LockedProductRow,
  lot: LockedLotRow,
  qty: number,
  _reason: string,
): Promise<void> {
  assertLockedProduct(product, product.id);
  assertLockedLots([lot], [lot.id]);
  if (qty < 0) throw new AppError(400, "removeFromLot qty must be non-negative");
  if (qty === 0) return;

  const nextRemaining = lot.quantityRemaining - qty;
  const nextStatus =
    lot.status === LotStatus.ACTIVE && nextRemaining === 0
      ? LotStatus.DEPLETED
      : (lot.status as LotStatus);

  await tx.lot.update({
    where: { id: lot.id },
    data: {
      quantityRemaining: nextRemaining,
      ...(nextStatus !== lot.status ? { status: nextStatus } : {}),
    },
  });

  if (lot.status === LotStatus.ACTIVE) {
    // Leaving ACTIVE for DEPLETED removes the previous remaining from the rollup.
    const rollupDelta =
      (nextStatus === LotStatus.ACTIVE ? nextRemaining : 0) - lot.quantityRemaining;
    if (rollupDelta !== 0) {
      await tx.product.update({
        where: { id: product.id },
        data: { stock: { increment: rollupDelta } },
      });
    }
  }
}

/**
 * Set a lot's quantityRemaining to an absolute target (stock-count approval).
 * Updates Product.stock by the ACTIVE-rollup delta only.
 */
export async function setLotRemaining(
  tx: Tx,
  product: LockedProductRow,
  lot: LockedLotRow,
  targetQty: number,
): Promise<{ previousQty: number; delta: number; rollupDelta: number; nextStatus: LotStatus }> {
  assertLockedProduct(product, product.id);
  assertLockedLots([lot], [lot.id]);
  if (targetQty < 0) throw new AppError(400, "targetQty must be non-negative");

  const previousQty = lot.quantityRemaining;
  const delta = targetQty - previousQty;
  if (lot.status === LotStatus.ACTIVE && targetQty < lot.quantityReserved) {
    throw new AppError(
      409,
      "Adjustment would drop a lot below units held by pending sales; settle them before approving",
      { lotId: lot.id, quantityReserved: lot.quantityReserved, targetQty },
    );
  }

  const nextStatus =
    lot.status === LotStatus.ACTIVE && targetQty === 0
      ? LotStatus.DEPLETED
      : lot.status === LotStatus.DEPLETED && targetQty > 0
        ? LotStatus.ACTIVE
        : (lot.status as LotStatus);

  if (delta !== 0 || nextStatus !== lot.status) {
    await tx.lot.update({
      where: { id: lot.id },
      data: { quantityRemaining: targetQty, status: nextStatus },
    });
  }

  const rollupDelta =
    (nextStatus === LotStatus.ACTIVE ? targetQty : 0) -
    (lot.status === LotStatus.ACTIVE ? previousQty : 0);

  if (rollupDelta !== 0) {
    await tx.product.update({
      where: { id: product.id },
      data: { stock: { increment: rollupDelta } },
    });
  }

  return { previousQty, delta, rollupDelta, nextStatus };
}

/**
 * Leave the sellable rollup without changing quantityRemaining (quarantine / expiry / recall
 * initiate). Product.stock decreases by the ACTIVE remaining.
 */
export async function leaveSellableRollup(
  tx: Tx,
  product: LockedProductRow,
  lot: LockedLotRow,
  nextStatus: LotStatus,
): Promise<number> {
  assertLockedProduct(product, product.id);
  assertLockedLots([lot], [lot.id]);
  if (lot.status !== LotStatus.ACTIVE) {
    await tx.lot.update({ where: { id: lot.id }, data: { status: nextStatus } });
    return 0;
  }
  const writeOffQty = Math.max(0, lot.quantityRemaining);
  await tx.lot.update({
    where: { id: lot.id },
    data: { status: nextStatus },
  });
  if (writeOffQty > 0) {
    await tx.product.update({
      where: { id: product.id },
      data: { stock: { decrement: writeOffQty } },
    });
  }
  return writeOffQty;
}

/**
 * Recall activation: mark RECALLED and zero remaining. Product.stock was already reduced at
 * quarantine when leaving ACTIVE.
 */
export async function recallDepleteLot(
  tx: Tx,
  product: LockedProductRow,
  lot: LockedLotRow,
): Promise<number> {
  assertLockedProduct(product, product.id);
  assertLockedLots([lot], [lot.id]);
  const remaining = Math.max(0, lot.quantityRemaining);
  await tx.lot.update({
    where: { id: lot.id },
    data: {
      status: LotStatus.RECALLED,
      quantityRemaining: 0,
    },
  });
  return remaining;
}

/** Cancel a DRAFT recall: QUARANTINED → ACTIVE and restore Product.stock. */
export async function returnToSellableRollup(
  tx: Tx,
  product: LockedProductRow,
  lot: LockedLotRow,
): Promise<void> {
  assertLockedProduct(product, product.id);
  assertLockedLots([lot], [lot.id]);
  if (lot.status !== LotStatus.QUARANTINED) return;
  await tx.lot.update({
    where: { id: lot.id },
    data: { status: LotStatus.ACTIVE },
  });
  if (lot.quantityRemaining > 0) {
    await tx.product.update({
      where: { id: product.id },
      data: { stock: { increment: lot.quantityRemaining } },
    });
  }
}

/**
 * Manual absolute Product.stock set (adjustStock). Does not touch lots — caller must keep the
 * rollup honest. Kept here so no service writes Product.stock outside this module.
 */
export async function setProductStock(
  tx: Tx,
  product: LockedProductRow,
  newStock: number,
): Promise<void> {
  assertLockedProduct(product, product.id);
  await tx.product.update({
    where: { id: product.id },
    data: { stock: newStock },
  });
}

export type CreateProductRowInput = {
  storeId: string;
  sku: string;
  name: string;
  category: string;
  price: Prisma.Decimal;
  cost: Prisma.Decimal;
  /** Opening Product.stock (legacy / catalog create). Prefer 0 + addLot for new inventory. */
  stock: number;
  reorderAt: number;
  taxExempt?: boolean;
  catalogItemId?: string | null;
};

/**
 * Product.create with stock/reserved — the only create path allowed to set those columns
 * outside addLot's lot.create. Callers that also seed lots must keep the rollup honest.
 */
export async function createProductRow(db: Db, data: CreateProductRowInput): Promise<Product> {
  if (data.stock < 0) {
    throw new AppError(400, "createProductRow stock must be non-negative");
  }
  return db.product.create({
    data: {
      storeId: data.storeId,
      catalogItemId: data.catalogItemId ?? null,
      sku: data.sku,
      name: data.name,
      category: data.category,
      price: data.price,
      cost: data.cost,
      stock: data.stock,
      reserved: 0,
      reorderAt: data.reorderAt,
      taxExempt: data.taxExempt ?? false,
    },
  });
}
