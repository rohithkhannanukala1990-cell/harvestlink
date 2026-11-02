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

const RAW_SQL_WRITE =
  /SET\s+(?:"quantityRemaining"|"quantityReserved"|stock|reserved)\s*=/;

const PRISMA_MUTATION =
  /\.(?:lot|product)\.(?:create|update|updateMany)\s*\(/;

/** Field assignments that mutate qty / rollup columns inside a Prisma `data` object. */
const DATA_FIELD_WRITE = [
  /quantityRemaining\s*:/,
  /quantityReserved\s*:/,
  /\bstock\s*:/,
  /\breserved\s*:/,
] as const;

/** Increment/decrement shorthand anywhere (almost always a write). */
const INC_DEC_WRITE =
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
 * Given a match on `.lot/.product.(create|update|updateMany)(`, return the `data: { ... }`
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
  // updateMany: `data` and `where` are siblings — extractDataObject only takes `data`.
  for (const re of DATA_FIELD_WRITE) {
    if (!re.test(withoutWhere)) continue;
    // Filter noise: `stock: { gte: ... }` in a where wrongly nested — treat gte/gt as non-write
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

describe("stockEngine write guard", () => {
  it("only stockEngine.ts writes lot qty or Product.stock/reserved", () => {
    const violations: string[] = [];

    for (const file of collectTsFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (rel === ENGINE_REL) continue;

      const source = stripComments(fs.readFileSync(file, "utf8"));

      if (RAW_SQL_WRITE.test(source)) {
        violations.push(`${rel}: raw SQL mutates lot/product qty columns`);
      }

      if (INC_DEC_WRITE.test(source)) {
        violations.push(`${rel}: increment/decrement on lot qty or Product.stock/reserved`);
      }

      let searchFrom = 0;
      while (searchFrom < source.length) {
        const m = PRISMA_MUTATION.exec(source.slice(searchFrom));
        if (!m || m.index === undefined) break;
        const abs = searchFrom + m.index;
        const dataObj = extractDataObject(source, abs);
        if (dataObj && dataObjectHasQtyWrite(dataObj)) {
          const line = source.slice(0, abs).split(/\r?\n/).length;
          violations.push(
            `${rel}:${line}: ${m[0].trim()} writes quantityRemaining/quantityReserved/stock/reserved`,
          );
        }
        searchFrom = abs + m[0].length;
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
