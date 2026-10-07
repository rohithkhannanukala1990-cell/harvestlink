/**
 * Barcodes: registering product and lot codes, and resolving a scan to a product / lot.
 *
 * One scanning layer serves counting, receiving and lot lookup, so lookupBarcode is generic and
 * returns no quantities: a counter using it mid-count learns nothing about expected stock.
 *
 * A scanned code resolves, in order, through:
 *   1. Lot.barcode                — a lot label goes straight to the lot.
 *   2. GS1 element string         — (01) GTIN → product, plus (10) lot number → lot when known.
 *   3. ProductBarcode.code        — manufacturer UPC/EAN or a store label.
 *   4. Product.sku                — our own code, printed on shelf tags.
 *   5. Lot.lotNumber              — a hand-written or printed lot number typed or scanned.
 *
 * Within a store a code must mean one thing, so registration refuses a code that is already a
 * product barcode, a lot barcode, or another product's SKU. These are separate tables, so the
 * check runs under a per-store advisory lock (the unique indexes alone cannot see across them).
 */
import { BarcodeKind, LotStatus, Prisma, Role } from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { isValidGtin, lookupCandidates, normalizeBarcode, parseGs1, type Gs1Data } from "../lib/barcode.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

const MAX_CODE_LENGTH = 80;

export type BarcodeMatchedBy = "LOT_BARCODE" | "GS1" | "PRODUCT_BARCODE" | "SKU" | "LOT_NUMBER";

export type BarcodeMatch = {
  matchedBy: BarcodeMatchedBy;
  product: { id: string; sku: string; name: string; category: string };
  lot: { id: string; lotNumber: string; expiryDate: Date | null; status: LotStatus } | null;
};

export type BarcodeLookupResult = {
  raw: string;
  code: string;
  gs1: Gs1Data | null;
  matches: BarcodeMatch[];
};

export type ProductBarcodeView = {
  id: string;
  productId: string;
  code: string;
  kind: BarcodeKind;
  label: string | null;
  createdAt: Date;
};

function assertAdmin(actor: AuthUser): void {
  if (actor.role !== Role.STORE_ADMIN && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only STORE_ADMIN or COOP_ADMIN can manage barcodes");
  }
}

function normalizeForStorage(raw: string): string {
  const { code } = normalizeBarcode(raw);
  if (!code) throw new AppError(400, "Barcode is empty");
  if (code.length > MAX_CODE_LENGTH) throw new AppError(400, `Barcode is longer than ${MAX_CODE_LENGTH} characters`);
  return code;
}

/** Serializes barcode registration per store; released at the end of the transaction. */
async function lockStoreBarcodes(tx: Prisma.TransactionClient, storeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`barcodes:${storeId}`}))`;
}

/**
 * Throws 409 when `code` already identifies something else in the store. Call inside a
 * transaction after lockStoreBarcodes.
 */
export async function assertBarcodeFree(
  tx: Prisma.TransactionClient,
  storeId: string,
  code: string,
  except: { productId?: string; lotId?: string } = {},
): Promise<void> {
  const [productBarcode, lot, skuOwner] = await Promise.all([
    tx.productBarcode.findUnique({
      where: { storeId_code: { storeId, code } },
      select: { productId: true, product: { select: { sku: true, name: true } } },
    }),
    tx.lot.findFirst({
      where: { storeId, barcode: code, ...(except.lotId ? { id: { not: except.lotId } } : {}) },
      select: { id: true, lotNumber: true, product: { select: { sku: true } } },
    }),
    tx.product.findFirst({
      where: {
        storeId,
        sku: { equals: code, mode: "insensitive" },
        ...(except.productId ? { id: { not: except.productId } } : {}),
      },
      select: { id: true, sku: true, name: true },
    }),
  ]);
  if (productBarcode) {
    throw new AppError(409, "This barcode is already registered to a product", {
      code,
      productId: productBarcode.productId,
      sku: productBarcode.product.sku,
      productName: productBarcode.product.name,
    });
  }
  if (lot) {
    throw new AppError(409, "This barcode is already a lot label", {
      code,
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      sku: lot.product.sku,
    });
  }
  if (skuOwner) {
    throw new AppError(409, "This barcode is another product's SKU; a scan would be ambiguous", {
      code,
      productId: skuOwner.id,
      sku: skuOwner.sku,
      productName: skuOwner.name,
    });
  }
}

/**
 * Normalizes and claims a lot barcode inside the caller's transaction (receiving uses this).
 * Returns the normalized code to store on the lot.
 */
export async function claimLotBarcode(
  tx: Prisma.TransactionClient,
  storeId: string,
  raw: string,
  exceptLotId?: string,
): Promise<string> {
  const code = normalizeForStorage(raw);
  await lockStoreBarcodes(tx, storeId);
  await assertBarcodeFree(tx, storeId, code, { lotId: exceptLotId });
  return code;
}

const productSelect = { id: true, sku: true, name: true, category: true } as const;
const lotSelect = { id: true, lotNumber: true, expiryDate: true, status: true } as const;

export async function lookupBarcode(storeId: string, raw: string): Promise<BarcodeLookupResult> {
  const { code } = normalizeBarcode(raw);
  if (!code) throw new AppError(400, "Barcode is empty");
  const gs1 = parseGs1(raw);

  const matches: BarcodeMatch[] = [];
  const seen = new Set<string>();
  const push = (m: BarcodeMatch) => {
    const key = `${m.product.id}:${m.lot?.id ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push(m);
  };

  const lotByBarcode = await prisma.lot.findFirst({
    where: { storeId, barcode: code },
    select: { ...lotSelect, product: { select: productSelect } },
  });
  if (lotByBarcode) {
    const { product, ...lot } = lotByBarcode;
    push({ matchedBy: "LOT_BARCODE", product, lot });
  }

  if (gs1?.gtin) {
    const owner = await prisma.productBarcode.findFirst({
      where: { storeId, code: { in: lookupCandidates(normalizeBarcode(gs1.gtin).code) } },
      select: { product: { select: productSelect } },
    });
    if (owner) {
      const lot = gs1.lot
        ? await prisma.lot.findFirst({
            where: {
              storeId,
              productId: owner.product.id,
              lotNumber: { equals: gs1.lot, mode: "insensitive" },
            },
            select: lotSelect,
          })
        : null;
      push({ matchedBy: "GS1", product: owner.product, lot });
    }
  }

  const byBarcode = await prisma.productBarcode.findMany({
    where: { storeId, code: { in: lookupCandidates(code) } },
    select: { product: { select: productSelect } },
  });
  for (const row of byBarcode) push({ matchedBy: "PRODUCT_BARCODE", product: row.product, lot: null });

  const bySku = await prisma.product.findMany({
    where: { storeId, sku: { equals: code, mode: "insensitive" } },
    select: productSelect,
  });
  for (const product of bySku) push({ matchedBy: "SKU", product, lot: null });

  if (matches.length === 0) {
    const byLotNumber = await prisma.lot.findMany({
      where: { storeId, lotNumber: { equals: code, mode: "insensitive" } },
      select: { ...lotSelect, product: { select: productSelect } },
      take: 20,
    });
    for (const { product, ...lot } of byLotNumber) push({ matchedBy: "LOT_NUMBER", product, lot });
  }

  return { raw, code, gs1, matches };
}

async function loadProductInStore(db: DbClient, storeId: string, productId: string) {
  const product = await db.product.findUnique({ where: { id: productId }, select: { id: true, storeId: true } });
  if (!product || product.storeId !== storeId) throw new AppError(404, "Product not found");
  return product;
}

export async function listProductBarcodes(storeId: string, productId: string): Promise<ProductBarcodeView[]> {
  await loadProductInStore(prisma, storeId, productId);
  return prisma.productBarcode.findMany({
    where: { productId },
    select: { id: true, productId: true, code: true, kind: true, label: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function addProductBarcode(
  actor: AuthUser,
  storeId: string,
  productId: string,
  input: { code: string; kind?: BarcodeKind; label?: string | null; ipAddress?: string | null },
): Promise<ProductBarcodeView> {
  assertAdmin(actor);
  const code = normalizeForStorage(input.code);
  const looksGtin = isValidGtin(code);
  const kind = input.kind ?? (looksGtin ? BarcodeKind.GTIN : BarcodeKind.INTERNAL);
  if (kind === BarcodeKind.GTIN && !looksGtin) {
    throw new AppError(400, "Not a valid UPC/EAN: wrong length or check digit. Register it as INTERNAL if it is a store code.", {
      code,
    });
  }
  // A UPC-E is stored as its UPC-A expansion so either form scans to the product.
  const stored = kind === BarcodeKind.GTIN && code.length === 8 ? lookupCandidates(code).at(-1)! : code;

  return prisma.$transaction(async (tx) => {
    await loadProductInStore(tx, storeId, productId);
    await lockStoreBarcodes(tx, storeId);
    await assertBarcodeFree(tx, storeId, stored, { productId });
    const created = await tx.productBarcode.create({
      data: {
        storeId,
        productId,
        code: stored,
        kind,
        label: input.label?.trim() || null,
        createdByUserId: actor.id,
      },
      select: { id: true, productId: true, code: true, kind: true, label: true, createdAt: true },
    });
    await writeAuditLog(
      {
        userId: actor.id,
        storeId,
        action: AuditAction.PRODUCT_BARCODE_ADD,
        entityType: "ProductBarcode",
        entityId: created.id,
        after: { productId, code: stored, kind, label: created.label },
        ipAddress: input.ipAddress ?? null,
      },
      { tx },
    );
    return created;
  });
}

export async function removeProductBarcode(
  actor: AuthUser,
  storeId: string,
  barcodeId: string,
  ipAddress?: string | null,
): Promise<void> {
  assertAdmin(actor);
  await prisma.$transaction(async (tx) => {
    const row = await tx.productBarcode.findUnique({ where: { id: barcodeId } });
    if (!row || row.storeId !== storeId) throw new AppError(404, "Barcode not found");
    await tx.productBarcode.delete({ where: { id: barcodeId } });
    await writeAuditLog(
      {
        userId: actor.id,
        storeId,
        action: AuditAction.PRODUCT_BARCODE_REMOVE,
        entityType: "ProductBarcode",
        entityId: barcodeId,
        before: { productId: row.productId, code: row.code, kind: row.kind, label: row.label },
        ipAddress: ipAddress ?? null,
      },
      { tx },
    );
  });
}

/** Sets or clears a lot's barcode label. */
export async function setLotBarcode(
  actor: AuthUser,
  storeId: string,
  lotId: string,
  raw: string | null,
  ipAddress?: string | null,
): Promise<{ id: string; barcode: string | null }> {
  assertAdmin(actor);
  return prisma.$transaction(async (tx) => {
    const lot = await tx.lot.findUnique({ where: { id: lotId }, select: { id: true, storeId: true, barcode: true } });
    if (!lot || lot.storeId !== storeId) throw new AppError(404, "Lot not found");
    const barcode = raw === null || raw.trim() === "" ? null : await claimLotBarcode(tx, storeId, raw, lotId);
    const updated = await tx.lot.update({ where: { id: lotId }, data: { barcode }, select: { id: true, barcode: true } });
    await writeAuditLog(
      {
        userId: actor.id,
        storeId,
        action: AuditAction.LOT_BARCODE_SET,
        entityType: "Lot",
        entityId: lotId,
        before: { barcode: lot.barcode },
        after: { barcode },
        ipAddress: ipAddress ?? null,
      },
      { tx },
    );
    return updated;
  });
}
