/**
 * CatalogDisagreement rows from backfill — DB-backed, resolvable, no silent empty on DB errors.
 */
import { CatalogDisagreementField, Prisma, Role } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backfillCatalog } from "../scripts/backfill-catalog.js";
import * as catalogService from "../src/services/catalog.service.js";
import { prisma } from "./helpers/db.js";
import { asAuthUser, createStore, createUser } from "./helpers/factories.js";

async function seedMismatchedSku(sku: string) {
  const storeA = await createStore({ name: `Store A ${sku}` });
  const storeB = await createStore({ name: `Store B ${sku}` });
  await prisma.product.create({
    data: {
      storeId: storeA.id,
      sku,
      name: "Alpha Widget",
      category: "Grocery",
      price: new Prisma.Decimal(3),
      cost: new Prisma.Decimal(1),
      stock: 0,
      reserved: 0,
      reorderAt: 0,
    },
  });
  await prisma.product.create({
    data: {
      storeId: storeB.id,
      sku,
      name: "Beta Widget",
      category: "Grocery",
      price: new Prisma.Decimal(4),
      cost: new Prisma.Decimal(1),
      stock: 0,
      reserved: 0,
      reorderAt: 0,
    },
  });
  return { storeA, storeB };
}

describe("CatalogDisagreement backfill + resolve", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("backfill creates an open row for a seeded name mismatch; re-run does not duplicate", async () => {
    const sku = `MM-${Date.now()}`;
    await seedMismatchedSku(sku);

    const first = await backfillCatalog();
    expect(first.disagreements).toBeGreaterThanOrEqual(1);

    const open = await prisma.catalogDisagreement.findMany({
      where: { sku, field: CatalogDisagreementField.name, resolvedAt: null },
    });
    expect(open).toHaveLength(1);
    expect(open[0]!.chosenValue).toBe("Alpha Widget"); // mode: Alpha first alphabetically only if ties — Alpha and Beta each count 1; sort by count then value → Alpha
    const openId = open[0]!.id;

    // Re-run after products were aligned to the catalog: no new mismatch printed, but the
    // existing open row must remain (admin still resolves it) — never a second open row.
    await backfillCatalog();

    const stillOpen = await prisma.catalogDisagreement.findMany({
      where: { sku, field: CatalogDisagreementField.name, resolvedAt: null },
    });
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]!.id).toBe(openId);
  });

  it("resolve marks the disagreement; list only returns unresolved rows", async () => {
    const sku = `RES-${Date.now()}`;
    await seedMismatchedSku(sku);
    await backfillCatalog();

    const coop = await createUser({
      email: `coop-dis-${Date.now()}@test.local`,
      role: Role.COOP_ADMIN,
    });
    const actor = asAuthUser(coop);

    const before = await catalogService.getCatalogDisagreements(actor);
    const row = before.find((d) => d.sku === sku && d.field === CatalogDisagreementField.name);
    expect(row).toBeTruthy();

    const resolved = await catalogService.resolveCatalogDisagreement(actor, row!.id);
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.resolvedByUserId).toBe(coop.id);

    const after = await catalogService.getCatalogDisagreements(actor);
    expect(after.find((d) => d.id === row!.id)).toBeUndefined();
  });

  it("getCatalogDisagreements propagates database errors instead of returning []", async () => {
    const coop = await createUser({
      email: `coop-err-${Date.now()}@test.local`,
      role: Role.COOP_ADMIN,
    });
    vi.spyOn(prisma.catalogDisagreement, "findMany").mockRejectedValueOnce(
      new Error("simulated catalog disagreement db failure"),
    );

    await expect(catalogService.getCatalogDisagreements(asAuthUser(coop))).rejects.toThrow(
      /simulated catalog disagreement db failure/,
    );
  });
});
