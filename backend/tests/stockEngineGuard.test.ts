/**
 * Guard: lot quantity and Product.stock / Product.reserved must only be written in stockEngine.ts
 * (including lot.create inside addLot / product.create inside createProductRow).
 * Fails naming the offending file so later phases cannot quietly add a second path.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const ENGINE_REL = "services/stockEngine.ts";

/**
 * Raw SQL SET of qty columns — matches first or later columns in a SET list
 * (e.g. `SET "lotNumber" = $1, "quantityRemaining" = $2`).
 */
export const RAW_SQL_WRITE =
  /SET\s+(?:[^;]*?,\s*)*(?:"quantityRemaining"|"quantityReserved"|stock|reserved)\s*=/;

/** Prisma mutations that may write qty columns (incl. upsert / createMany). */
export const PRISMA_MUTATION =
  /\.(?:lot|product)\.(?:create|createMany|update|updateMany|upsert)\s*\(/;

/** Qty field names appearing in a Prisma call argument window. */
const QTY_FIELD_ANYWHERE =
  /(?:quantityRemaining|quantityReserved|\bstock\b|\breserved\b)\s*:/;

/** Field assignments that mutate qty / rollup columns inside a Prisma `data` object. */
const DATA_FIELD_WRITE = [
  /quantityRemaining\s*:/,
  /quantityReserved\s*:/,
  /\bstock\s*:/,
  /\breserved\s*:/,
] as const;

/** Increment/decrement shorthand anywhere (almost always a write). */
export const INC_DEC_WRITE =
  /(?:quantityRemaining|quantityReserved|stock|reserved)\s*:\s*\{\s*(?:increment|decrement)\b/;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Given a match on `.lot/.product.(create|… )(`, return the `data: { ... }`
 * object text when present (best-effort brace match).
 */
function extractDataObject(source: string, callIndex: number): string | null {
  const window = source.slice(callIndex, callIndex + 1200);
  const dataIdx = window.search(/\bdata\s*:\s*\{/);
  if (dataIdx < 0) return null;
  const start = window.indexOf("{", dataIdx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < window.length; i++) {
    const ch = window[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return window.slice(start, i + 1);
    }
  }
  return window.slice(start);
}

function dataObjectHasQtyWrite(dataObj: string): boolean {
  // Ignore select-style / filter-only appearances inside nested where clauses of updateMany.
  const withoutWhere = dataObj.replace(/\bwhere\s*:\s*\{[\s\S]*?\n\s*\}/g, "");
  for (const re of DATA_FIELD_WRITE) {
    if (!re.test(withoutWhere)) continue;
    const lines = withoutWhere.split(/\r?\n/);
    for (const line of lines) {
      if (!re.test(line)) continue;
      if (/\{\s*(?:gt|gte|lt|lte|in|equals|not)\b/.test(line)) continue;
      if (/:\s*true\b/.test(line)) continue;
      return true;
    }
  }
  return false;
}

/** Shared detector used by the repo scan and the fixture unit tests. */
export function findStockWriteViolations(source: string, rel = "fixture.ts"): string[] {
  const violations: string[] = [];
  const cleaned = stripComments(source);

  if (RAW_SQL_WRITE.test(cleaned)) {
    violations.push(`${rel}: raw SQL mutates lot/product qty columns`);
  }

  if (INC_DEC_WRITE.test(cleaned)) {
    violations.push(`${rel}: increment/decrement on lot qty or Product.stock/reserved`);
  }

  let searchFrom = 0;
  while (searchFrom < cleaned.length) {
    const m = PRISMA_MUTATION.exec(cleaned.slice(searchFrom));
    if (!m || m.index === undefined) break;
    const abs = searchFrom + m.index;
    const line = cleaned.slice(0, abs).split(/\r?\n/).length;
    const callWindow = cleaned.slice(abs, abs + 1200);
    const dataObj = extractDataObject(cleaned, abs);
    const isBulkOrUpsert = /createMany|upsert/.test(m[0]);
    const flagged =
      (dataObj && dataObjectHasQtyWrite(dataObj)) ||
      // createMany / upsert often put qty fields on create/update without a nested `data: {`
      // wrapper that extractDataObject understands — scan the call window instead.
      (isBulkOrUpsert && QTY_FIELD_ANYWHERE.test(callWindow));
    if (flagged) {
      violations.push(
        `${rel}:${line}: ${m[0].trim()} writes quantityRemaining/quantityReserved/stock/reserved`,
      );
    }
    searchFrom = abs + m[0].length;
  }

  return violations;
}

describe("stockEngine write guard", () => {
  it("only stockEngine.ts writes lot qty or Product.stock/reserved", () => {
    const violations: string[] = [];

    for (const file of collectTsFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (rel === ENGINE_REL) continue;
      violations.push(...findStockWriteViolations(fs.readFileSync(file, "utf8"), rel));
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("detects fixture patterns for upsert, createMany, and mid-SET raw SQL", () => {
    const fixtures: Array<{ name: string; source: string }> = [
      {
        name: "lot.upsert",
        source: `await tx.lot.upsert({
  where: { id: "x" },
  create: { quantityRemaining: 1, productId: "p" },
  update: { quantityRemaining: 2 },
});`,
      },
      {
        name: "product.createMany",
        source: `await tx.product.createMany({
  data: [{ stock: 5, reserved: 0, sku: "S" }],
});`,
      },
      {
        name: "raw SQL mid-SET list",
        source: `await tx.$executeRawUnsafe(
  'UPDATE "Lot" SET "lotNumber" = $1, "quantityRemaining" = $2 WHERE id = $3'
);`,
      },
      {
        name: "product.upsert stock",
        source: `await prisma.product.upsert({
  where: { id: "p" },
  create: { stock: 1, sku: "S", storeId: "st" },
  update: { reserved: 2 },
});`,
      },
      {
        name: "lot.createMany quantityReserved",
        source: `await tx.lot.createMany({ data: [{ quantityReserved: 3 }] });`,
      },
    ];

    for (const fixture of fixtures) {
      const hits = findStockWriteViolations(fixture.source, fixture.name);
      expect(hits.length, `${fixture.name} should be detected\n${hits.join("\n")}`).toBeGreaterThan(
        0,
      );
    }
  });
});
