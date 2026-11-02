/**
 * LocationType rules: warehouse operatorPercent, no POS/drawer, immutable type after activity.
 */
import { LocationType, PaymentMethod, Prisma, Role } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as drawerService from "../src/services/drawer.service.js";
import * as salesService from "../src/services/sales.service.js";
import * as storesService from "../src/services/stores.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createProduct,
  createStore,
  createUser,
  seedCashierStore,
} from "./helpers/factories.js";

describe("LocationType rules", () => {
  it("rejects a WAREHOUSE with operatorPercent !== 0", async () => {
    const coop = await createUser({
      email: `coop-loc-${Date.now()}@test.local`,
      role: Role.COOP_ADMIN,
    });
    await expect(
      storesService.createStore(asAuthUser(coop), {
        name: "Bad Warehouse",
        address: "1 Wharf",
        locationType: LocationType.WAREHOUSE,
        operatorPercent: 5,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: "A warehouse must have operatorPercent 0",
    });

    const warehouse = await createStore({
      name: "Ok Warehouse",
      locationType: LocationType.WAREHOUSE,
    });
    await expect(
      storesService.updateStore(warehouse.id, asAuthUser(coop), {
        operatorPercent: 2,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: "A warehouse must have operatorPercent 0",
    });
  });

  it('createSale rejects a WAREHOUSE with 409 "Point-of-sale sales are not taken at a warehouse"', async () => {
    const warehouse = await createStore({
      name: "WH POS",
      locationType: LocationType.WAREHOUSE,
    });
    const cashier = await createUser({
      email: `wh-cashier-${Date.now()}@test.local`,
      role: Role.CASHIER,
      storeId: warehouse.id,
    });
    const product = await createProduct(warehouse.id, { stock: 5, price: 10 });

    await expect(
      salesService.createSale(warehouse.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: PaymentMethod.CASH,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Point-of-sale sales are not taken at a warehouse",
    });
  });

  it("openDrawer rejects a WAREHOUSE", async () => {
    const warehouse = await createStore({
      name: "WH Drawer",
      locationType: LocationType.WAREHOUSE,
    });
    const manager = await createUser({
      email: `wh-mgr-${Date.now()}@test.local`,
      role: Role.STORE_ADMIN,
      storeId: warehouse.id,
    });

    await expect(
      drawerService.openDrawer(warehouse.id, asAuthUser(manager), 50),
    ).rejects.toMatchObject({
      status: 409,
      message: "Cash drawers are not opened at a warehouse",
    });
  });

  it("locationType cannot change once a location has lots or sales", async () => {
    const { store, cashier } = await seedCashierStore();
    const coop = await createUser({
      email: `coop-immut-${Date.now()}@test.local`,
      role: Role.COOP_ADMIN,
    });
    const product = await createProduct(store.id, { stock: 3, price: 5 });

    await prisma.cashDrawer.create({
      data: {
        storeId: store.id,
        openedByUserId: cashier.id,
        openingFloat: new Prisma.Decimal(50),
      },
    });
    await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: PaymentMethod.CASH,
    });

    await expect(
      storesService.updateStore(store.id, asAuthUser(coop), {
        locationType: LocationType.WAREHOUSE,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "locationType cannot change once a location has lots or sales",
    });

    // Lots alone also lock the type (no sales).
    const empty = await createStore({ name: "Lots only" });
    await createProduct(empty.id, { stock: 2 });
    await expect(
      storesService.updateStore(empty.id, asAuthUser(coop), {
        locationType: LocationType.WAREHOUSE,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
