/**
 * CatalogItem ceiling + identity ownership rules.
 */
import { LocationType, Role } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as catalogService from "../src/services/catalog.service.js";
import * as inventoryService from "../src/services/inventory.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createProduct,
  createStore,
  createUser,
  seedCashierStore,
} from "./helpers/factories.js";

describe("CatalogItem price ceiling", () => {
  it("rejects retail price above maxShelfPrice with 400 naming the ceiling", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const coop = await createUser({
      email: `coop-cat-${Date.now()}@test.local`,
      role: Role.COOP_ADMIN,
    });
    const item = await catalogService.createCatalogItem(asAuthUser(coop), {
      sku: `CEIL-${Date.now()}`,
      name: "Ceiling Tea",
      category: "Grocery",
      unitsPerCase: 12,
      maxShelfPrice: 5,
    });

    await expect(
      inventoryService.createProduct(
        store.id,
        {
          catalogItemId: item.id,
          price: 5.01,
          cost: 2,
          stock: 0,
          reorderAt: 2,
        },
        asAuthUser(storeAdmin),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: "Price exceeds the co-op shelf ceiling for this SKU",
      details: { maxShelfPrice: "5.00" },
    });
  });

  it("sets warehouse product price to the catalog ceiling on create", async () => {
    const coop = await createUser({
      email: `coop-wh-${Date.now()}@test.local`,
      role: Role.COOP_ADMIN,
    });
    const warehouse = await createStore({
      name: "WH Catalog",
      locationType: LocationType.WAREHOUSE,
    });
    const item = await catalogService.createCatalogItem(asAuthUser(coop), {
      sku: `WHP-${Date.now()}`,
      name: "Case Goods",
      category: "Grocery",
      unitsPerCase: 6,
      maxShelfPrice: 9.5,
    });

    const product = await inventoryService.createProduct(
      warehouse.id,
      {
        catalogItemId: item.id,
        price: 1, // ignored at warehouse
        cost: 3,
        stock: 0,
        reorderAt: 0,
      },
      asAuthUser(coop),
    );
    expect(product.price.toFixed(2)).toBe("9.50");
  });

  it("lowering a ceiling clamps retail prices above it and audits each product", async () => {
    const coop = await createUser({
      email: `coop-clamp-${Date.now()}@test.local`,
      role: Role.COOP_ADMIN,
    });
    const a = await createStore({ name: "Retail A" });
    const b = await createStore({ name: "Retail B" });
    const item = await catalogService.createCatalogItem(asAuthUser(coop), {
      sku: `CLAMP-${Date.now()}`,
      name: "Clamp Beans",
      category: "Grocery",
      unitsPerCase: 1,
      maxShelfPrice: 10,
    });
    const pA = await inventoryService.createProduct(
      a.id,
      { catalogItemId: item.id, price: 9, cost: 1, stock: 0, reorderAt: 0 },
      asAuthUser(coop),
    );
    const pB = await inventoryService.createProduct(
      b.id,
      { catalogItemId: item.id, price: 8, cost: 1, stock: 0, reorderAt: 0 },
      asAuthUser(coop),
    );

    await catalogService.updateCatalogItem(asAuthUser(coop), item.id, { maxShelfPrice: 8.5 });

    const afterA = await prisma.product.findUniqueOrThrow({ where: { id: pA.id } });
    const afterB = await prisma.product.findUniqueOrThrow({ where: { id: pB.id } });
    expect(afterA.price.toFixed(2)).toBe("8.50");
    expect(afterB.price.toFixed(2)).toBe("8.00");

    const clamps = await prisma.auditLog.findMany({
      where: {
        action: "PRODUCT_PRICE_CHANGE",
        entityId: pA.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(clamps.some((row) => JSON.stringify(row.after).includes("CEILING_CLAMP"))).toBe(true);
  });

  it("rejects editing sku/name/category/taxExempt on a location Product", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { sku: `ID-${Date.now()}`, price: 4 });

    await expect(
      inventoryService.updateProduct(
        product.id,
        store.id,
        { name: "Hacked" },
        asAuthUser(storeAdmin),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("owned by the CatalogItem"),
    });
  });
});
