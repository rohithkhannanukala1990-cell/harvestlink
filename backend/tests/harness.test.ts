/**
 * Guards the Vitest truncate list against schema drift.
 * Every `model X` in prisma/schema.prisma must appear in TRUNCATE_TABLES.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TRUNCATE_TABLES } from "./helpers/db.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");

describe("test harness", () => {
  it("truncates every Prisma model table", () => {
    const schema = fs.readFileSync(SCHEMA, "utf8");
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!);
    expect(models.length).toBeGreaterThan(0);

    const truncated = new Set<string>(TRUNCATE_TABLES);
    const missing = models.filter((name) => !truncated.has(name));
    expect(missing, `TRUNCATE_TABLES is missing: ${missing.join(", ")}`).toEqual([]);
  });
});
