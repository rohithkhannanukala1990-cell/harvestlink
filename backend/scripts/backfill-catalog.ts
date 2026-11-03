/**
 * Idempotent backfill: one CatalogItem per distinct Product.sku across all locations.
 *
 * Where locations disagree on name / category / taxExempt, takes the most common value,
 * PRINTS every disagreement, and upserts an open CatalogDisagreement row (shared DB — not a
 * local JSON file). maxShelfPrice = the highest current retail price for that SKU so no
 * existing price is over ceiling. Links every Product.catalogItemId.
 *
 * Usage: npm run db:backfill-catalog
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogDisagreementField, Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { upsertOpenCatalogDisagreement } from "../src/services/catalog.service.js";

type FieldKey = "name" | "category" | "taxExempt";

function mode<T extends string | boolean>(
  entries: Array<{ value: T; storeId: string }>,
): { chosen: T; buckets: Array<{ value: T; count: number; storeIds: string[] }> } {
  const map = new Map<string, { value: T; count: number; storeIds: string[] }>();
  for (const e of entries) {
    const key = String(e.value);
    const bucket = map.get(key) ?? { value: e.value, count: 0, storeIds: [] };
    bucket.count += 1;
    bucket.storeIds.push(e.storeId);
    map.set(key, bucket);
  }
  const buckets = [...map.values()].sort(
    (a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)),
  );
  return { chosen: buckets[0]!.value, buckets };
}

function fieldEnum(field: FieldKey): CatalogDisagreementField {
  switch (field) {
    case "name":
      return CatalogDisagreementField.name;
    case "category":
      return CatalogDisagreementField.category;
    case "taxExempt":
      return CatalogDisagreementField.taxExempt;
  }
}

export async function backfillCatalog(): Promise<{
  distinctSkus: number;
  catalogItemsCreated: number;
  productsLinked: number;
  productsAlreadyLinked: number;
  disagreements: number;
}> {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      storeId: true,
      sku: true,
      name: true,
      category: true,
      taxExempt: true,
      price: true,
      catalogItemId: true,
    },
    orderBy: [{ sku: "asc" }, { storeId: "asc" }],
  });

  const bySku = new Map<string, typeof products>();
  for (const p of products) {
    const list = bySku.get(p.sku) ?? [];
    list.push(p);
    bySku.set(p.sku, list);
  }

  let created = 0;
  let linked = 0;
  let alreadyLinked = 0;
  let disagreementCount = 0;

  for (const [sku, rows] of bySku) {
    const nameMode = mode(rows.map((r) => ({ value: r.name, storeId: r.storeId })));
    const categoryMode = mode(rows.map((r) => ({ value: r.category, storeId: r.storeId })));
    const taxMode = mode(rows.map((r) => ({ value: r.taxExempt, storeId: r.storeId })));

    for (const [field, result] of [
      ["name", nameMode],
      ["category", categoryMode],
      ["taxExempt", taxMode],
    ] as Array<[FieldKey, ReturnType<typeof mode>]>) {
      if (result.buckets.length > 1) {
        const chosenValue = String(result.chosen);
        const values = result.buckets.map((b) => ({
          value: b.value,
          count: b.count,
          storeIds: b.storeIds,
        }));
        const row = await upsertOpenCatalogDisagreement({
          sku,
          field: fieldEnum(field),
          chosenValue,
          values,
        });
        disagreementCount += 1;
        console.log(
          JSON.stringify({
            type: "CATALOG_BACKFILL_DISAGREEMENT",
            id: row.id,
            sku,
            field,
            chosenValue,
            values,
          }),
        );
      }
    }

    const maxPrice = rows.reduce(
      (max, r) => (r.price.gt(max) ? r.price : max),
      new Prisma.Decimal(0),
    );

    let catalog = await prisma.catalogItem.findUnique({ where: { sku } });
    if (!catalog) {
      catalog = await prisma.catalogItem.create({
        data: {
          sku,
          name: String(nameMode.chosen),
          category: String(categoryMode.chosen),
          taxExempt: Boolean(taxMode.chosen),
          unitsPerCase: 1,
          maxShelfPrice: maxPrice,
        },
      });
      created += 1;
      console.log(
        JSON.stringify({
          type: "CATALOG_ITEM_CREATED",
          sku,
          maxShelfPrice: maxPrice.toFixed(2),
          productCount: rows.length,
        }),
      );
    } else {
      // Keep ceiling at least as high as any current price (idempotent widen only).
      if (maxPrice.gt(catalog.maxShelfPrice)) {
        catalog = await prisma.catalogItem.update({
          where: { id: catalog.id },
          data: { maxShelfPrice: maxPrice },
        });
      }
    }

    for (const row of rows) {
      if (row.catalogItemId === catalog.id) {
        alreadyLinked += 1;
        continue;
      }
      await prisma.product.update({
        where: { id: row.id },
        data: {
          catalogItemId: catalog.id,
          // Align identity fields to the chosen master values.
          name: catalog.name,
          category: catalog.category,
          taxExempt: catalog.taxExempt,
        },
      });
      linked += 1;
    }
  }

  const summary = {
    distinctSkus: bySku.size,
    catalogItemsCreated: created,
    productsLinked: linked,
    productsAlreadyLinked: alreadyLinked,
    disagreements: disagreementCount,
  };
  console.log(JSON.stringify({ type: "CATALOG_BACKFILL_SUMMARY", ...summary }));
  return summary;
}

async function main(): Promise<void> {
  await backfillCatalog();
}

const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .catch((error) => {
      console.error("backfill-catalog failed", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
