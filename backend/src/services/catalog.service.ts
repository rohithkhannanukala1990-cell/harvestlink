/**
 * Network CatalogItem master — SKU identity, pack sizes, and the co-op retail price ceiling.
 *
 * Location Products mirror sku/name/category/taxExempt from here. Editing those on a Product
 * is rejected; edit the CatalogItem (COOP_ADMIN) and changes propagate.
 *
 * /// The co-op owns the stock under the percentage-of-sales model, so a store pricing below the
 * /// ceiling lowers the co-op's revenue as well as its own. The audit trail shows who and when.
 */
import {
  CatalogDisagreementField,
  LocationType,
  Prisma,
  Role,
  type CatalogDisagreement as CatalogDisagreementRow,
  type CatalogItem,
} from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { moneyDec } from "../lib/money.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

export type CatalogDisagreementValue = {
  value: string | boolean;
  count: number;
  storeIds: string[];
};

/** API / UI shape for an unresolved (or recently resolved) catalog identity mismatch. */
export type CatalogDisagreementView = {
  id: string;
  sku: string;
  field: CatalogDisagreementField;
  values: CatalogDisagreementValue[];
  chosenValue: string;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  createdAt: Date;
};

export type UpsertCatalogDisagreementInput = {
  sku: string;
  field: CatalogDisagreementField;
  chosenValue: string;
  values: CatalogDisagreementValue[];
};

export type CreateCatalogItemInput = {
  sku: string;
  name: string;
  category: string;
  taxExempt?: boolean;
  isActive?: boolean;
  unitsPerCase: number;
  casesPerPallet?: number | null;
  caseWeightKg?: number | null;
  caseGtin?: string | null;
  maxShelfPrice: number;
};

export type UpdateCatalogItemInput = Partial<CreateCatalogItemInput>;

function assertCoopAdmin(actor: AuthUser): void {
  if (actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only COOP_ADMIN can manage the network catalog");
  }
}

function assertCatalogReader(actor: AuthUser): void {
  if (actor.role !== Role.COOP_ADMIN && actor.role !== Role.STORE_ADMIN) {
    throw new AppError(403, "Insufficient role to read the network catalog");
  }
}

function validatePack(unitsPerCase: number, casesPerPallet: number | null | undefined): void {
  if (!Number.isInteger(unitsPerCase) || unitsPerCase < 1) {
    throw new AppError(400, "unitsPerCase must be an integer ≥ 1");
  }
  if (
    casesPerPallet !== undefined &&
    casesPerPallet !== null &&
    (!Number.isInteger(casesPerPallet) || casesPerPallet < 1)
  ) {
    throw new AppError(400, "casesPerPallet must be null or an integer ≥ 1");
  }
}

export async function listCatalogItems(actor: AuthUser): Promise<CatalogItem[]> {
  assertCatalogReader(actor);
  return prisma.catalogItem.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
}

export async function getCatalogItem(actor: AuthUser, id: string): Promise<CatalogItem> {
  assertCatalogReader(actor);
  const item = await prisma.catalogItem.findUnique({ where: { id } });
  if (!item) throw new AppError(404, "Catalog item not found");
  return item;
}

function toDisagreementView(row: CatalogDisagreementRow): CatalogDisagreementView {
  return {
    id: row.id,
    sku: row.sku,
    field: row.field,
    values: row.values as CatalogDisagreementValue[],
    chosenValue: row.chosenValue,
    resolvedAt: row.resolvedAt,
    resolvedByUserId: row.resolvedByUserId,
    createdAt: row.createdAt,
  };
}

/**
 * Unresolved backfill disagreements from the database.
 * Errors propagate — never swallow a DB failure into an empty list.
 */
export async function getCatalogDisagreements(
  actor: AuthUser,
): Promise<CatalogDisagreementView[]> {
  assertCatalogReader(actor);
  const rows = await prisma.catalogDisagreement.findMany({
    where: { resolvedAt: null },
    orderBy: [{ sku: "asc" }, { field: "asc" }],
  });
  return rows.map(toDisagreementView);
}

/**
 * Idempotent open-row write used by db:backfill-catalog — one unresolved row per sku+field.
 * Re-running updates values / chosenValue on the existing open row.
 */
export async function upsertOpenCatalogDisagreement(
  input: UpsertCatalogDisagreementInput,
): Promise<CatalogDisagreementRow> {
  // Find-then-update/create in one transaction — does not rely on the partial unique index
  // CatalogDisagreement_sku_field_open_key (raw SQL; Prisma cannot express it).
  return prisma.$transaction(async (tx) => {
    const existing = await tx.catalogDisagreement.findFirst({
      where: { sku: input.sku, field: input.field, resolvedAt: null },
    });
    if (existing) {
      return tx.catalogDisagreement.update({
        where: { id: existing.id },
        data: {
          values: input.values as Prisma.InputJsonValue,
          chosenValue: input.chosenValue,
        },
      });
    }
    return tx.catalogDisagreement.create({
      data: {
        sku: input.sku,
        field: input.field,
        values: input.values as Prisma.InputJsonValue,
        chosenValue: input.chosenValue,
      },
    });
  });
}

/** COOP_ADMIN accepts the backfill's chosenValue for this disagreement. */
export async function resolveCatalogDisagreement(
  actor: AuthUser,
  id: string,
): Promise<CatalogDisagreementView> {
  assertCoopAdmin(actor);
  const existing = await prisma.catalogDisagreement.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Catalog disagreement not found");
  if (existing.resolvedAt) {
    throw new AppError(409, "Catalog disagreement is already resolved", {
      resolvedAt: existing.resolvedAt.toISOString(),
      resolvedByUserId: existing.resolvedByUserId,
    });
  }
  const updated = await prisma.catalogDisagreement.update({
    where: { id },
    data: {
      resolvedAt: new Date(),
      resolvedByUserId: actor.id,
    },
  });
  return toDisagreementView(updated);
}

export async function createCatalogItem(
  actor: AuthUser,
  input: CreateCatalogItemInput,
): Promise<CatalogItem> {
  assertCoopAdmin(actor);
  validatePack(input.unitsPerCase, input.casesPerPallet);
  if (!(input.maxShelfPrice >= 0)) {
    throw new AppError(400, "maxShelfPrice must be zero or more");
  }

  try {
    const item = await prisma.catalogItem.create({
      data: {
        sku: input.sku.trim(),
        name: input.name.trim(),
        category: input.category.trim(),
        taxExempt: input.taxExempt ?? false,
        isActive: input.isActive ?? true,
        unitsPerCase: input.unitsPerCase,
        casesPerPallet: input.casesPerPallet ?? null,
        caseWeightKg:
          input.caseWeightKg === undefined || input.caseWeightKg === null
            ? null
            : new Prisma.Decimal(input.caseWeightKg),
        caseGtin: input.caseGtin?.trim() || null,
        maxShelfPrice: moneyDec(input.maxShelfPrice),
      },
    });
    await writeAuditLog({
      userId: actor.id,
      action: AuditAction.CATALOG_ITEM_UPDATE,
      entityType: "CatalogItem",
      entityId: item.id,
      after: {
        sku: item.sku,
        name: item.name,
        maxShelfPrice: item.maxShelfPrice.toFixed(2),
        unitsPerCase: item.unitsPerCase,
      },
    });
    return item;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "SKU already exists in the network catalog");
    }
    throw error;
  }
}

export async function updateCatalogItem(
  actor: AuthUser,
  id: string,
  input: UpdateCatalogItemInput,
  ipAddress?: string | null,
): Promise<CatalogItem> {
  assertCoopAdmin(actor);
  const existing = await prisma.catalogItem.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Catalog item not found");

  if (input.unitsPerCase !== undefined || input.casesPerPallet !== undefined) {
    validatePack(
      input.unitsPerCase ?? existing.unitsPerCase,
      input.casesPerPallet !== undefined ? input.casesPerPallet : existing.casesPerPallet,
    );
  }
  if (input.maxShelfPrice !== undefined && !(input.maxShelfPrice >= 0)) {
    throw new AppError(400, "maxShelfPrice must be zero or more");
  }

  const nextCeiling =
    input.maxShelfPrice !== undefined ? moneyDec(input.maxShelfPrice) : existing.maxShelfPrice;
  const loweringCeiling = nextCeiling.lt(existing.maxShelfPrice);

  const nextSku = input.sku !== undefined ? input.sku.trim() : existing.sku;
  const nextName = input.name !== undefined ? input.name.trim() : existing.name;
  const nextCategory = input.category !== undefined ? input.category.trim() : existing.category;
  const nextTaxExempt = input.taxExempt !== undefined ? input.taxExempt : existing.taxExempt;

  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.catalogItem.update({
        where: { id },
        data: {
          ...(input.sku !== undefined ? { sku: nextSku } : {}),
          ...(input.name !== undefined ? { name: nextName } : {}),
          ...(input.category !== undefined ? { category: nextCategory } : {}),
          ...(input.taxExempt !== undefined ? { taxExempt: nextTaxExempt } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.unitsPerCase !== undefined ? { unitsPerCase: input.unitsPerCase } : {}),
          ...(input.casesPerPallet !== undefined ? { casesPerPallet: input.casesPerPallet } : {}),
          ...(input.caseWeightKg !== undefined
            ? {
                caseWeightKg:
                  input.caseWeightKg === null ? null : new Prisma.Decimal(input.caseWeightKg),
              }
            : {}),
          ...(input.caseGtin !== undefined ? { caseGtin: input.caseGtin?.trim() || null } : {}),
          ...(input.maxShelfPrice !== undefined ? { maxShelfPrice: nextCeiling } : {}),
        },
      });

      // Propagate master identity fields to every linked location product.
      await tx.product.updateMany({
        where: { catalogItemId: id },
        data: {
          sku: nextSku,
          name: nextName,
          category: nextCategory,
          taxExempt: nextTaxExempt,
        },
      });

      // Lowering a ceiling clamps every retail price above it; raising changes no price.
      if (loweringCeiling) {
        const over = await tx.product.findMany({
          where: {
            catalogItemId: id,
            price: { gt: nextCeiling },
            store: { locationType: LocationType.RETAIL_STORE },
          },
        });
        for (const product of over) {
          const previous = product.price;
          await tx.product.update({
            where: { id: product.id },
            data: { price: nextCeiling },
          });
          await writeAuditLog(
            {
              userId: actor.id,
              storeId: product.storeId,
              action: AuditAction.PRODUCT_PRICE_CHANGE,
              entityType: "Product",
              entityId: product.id,
              before: { price: previous.toFixed(2) },
              after: {
                price: nextCeiling.toFixed(2),
                reason: "CEILING_CLAMP",
                catalogItemId: id,
                maxShelfPrice: nextCeiling.toFixed(2),
              },
              ipAddress: ipAddress ?? null,
            },
            { tx },
          );
        }
      }

      await writeAuditLog(
        {
          userId: actor.id,
          action: AuditAction.CATALOG_ITEM_UPDATE,
          entityType: "CatalogItem",
          entityId: id,
          before: {
            sku: existing.sku,
            name: existing.name,
            category: existing.category,
            taxExempt: existing.taxExempt,
            maxShelfPrice: existing.maxShelfPrice.toFixed(2),
            unitsPerCase: existing.unitsPerCase,
          },
          after: {
            sku: updated.sku,
            name: updated.name,
            category: updated.category,
            taxExempt: updated.taxExempt,
            maxShelfPrice: updated.maxShelfPrice.toFixed(2),
            unitsPerCase: updated.unitsPerCase,
          },
          ipAddress: ipAddress ?? null,
        },
        { tx },
      );

      return updated;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "SKU already exists in the network catalog");
    }
    throw error;
  }
}

export async function deactivateCatalogItem(actor: AuthUser, id: string): Promise<CatalogItem> {
  return updateCatalogItem(actor, id, { isActive: false });
}
