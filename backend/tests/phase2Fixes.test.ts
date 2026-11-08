/**
 * Phase-2 follow-ups: registered/operating settings, backfill without partial index,
 * adjustLot blocked-lot override + lot delta ledger, price-ceiling race, RefundRestockLot.
 */
import { CatalogDisagreementField, LotStatus, PaymentMethod, Prisma, Role } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/lib/errors.js";
import { AuditAction } from "../src/lib/audit.js";
import { backfillCatalog } from "../scripts/backfill-catalog.js";
import * as catalogService from "../src/services/catalog.service.js";
import * as inventoryService from "../src/services/inventory.service.js";
import * as membershipService from "../src/services/membership.service.js";
import * as salesService from "../src/services/sales.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createProduct,
  createStore,
  createUser,
  seedCashierStore,
  signTestToken,
} from "./helpers/factories.js";
import request from "supertest";

describe("cooperative registered vs operating settings", () => {
  it("round-trips operatingState and principalOfficeAddress", async () => {
    const coop = await createUser({
      email: `coop-set-${Date.now()}@test.local`,
      role: Role.COOP_ADMIN,
    });
    await membershipService.getCooperativeSettings();

    const updated = await membershipService.updateCooperativeSettings(asAuthUser(coop), {
      stateOfIncorporation: "OH",
      operatingState: "tx",
      principalOfficeAddress: "1 Distribution Way, Houston, TX",
    });
    expect(updated.stateOfIncorporation).toBe("OH");
    expect(updated.operatingState).toBe("TX");
    expect(updated.principalOfficeAddress).toBe("1 Distribution Way, Houston, TX");

    const app = createApp();
    const token = signTestToken(coop);
    const get = await request(app)
      .get("/members/cooperative-settings")
      .set({ Authorization: `Bearer ${token}` });
    expect(get.status).toBe(200);
    expect(get.body.settings.operatingState).toBe("TX");

    const patch = await request(app)
      .patch("/members/cooperative-settings")
      .set({ Authorization: `Bearer ${token}` })
      .send({ principalOfficeAddress: "100 Market St, Houston, TX" });
    expect(patch.status).toBe(200);
    expect(patch.body.settings.principalOfficeAddress).toBe("100 Market St, Houston, TX");
  });
});

describe("catalog disagreement backfill without partial unique index", () => {
  it("remains idempotent after CatalogDisagreement_sku_field_open_key is dropped", async () => {
    const sku = `NOIDX-${Date.now()}`;
    const storeA = await createStore({ name: `A ${sku}` });
    const storeB = await createStore({ name: `B ${sku}` });
    await prisma.product.create({
      data: {
        storeId: storeA.id,
        sku,
        name: "Alpha",
        category: "G",
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
        name: "Beta",
        category: "G",
        price: new Prisma.Decimal(4),
        cost: new Prisma.Decimal(1),
        stock: 0,
        reserved: 0,
        reorderAt: 0,
      },
    });

    await prisma.$executeRawUnsafe(
      `DROP INDEX IF EXISTS "CatalogDisagreement_sku_field_open_key"`,
    );

    await backfillCatalog();
    await backfillCatalog();

    const open = await prisma.catalogDisagreement.findMany({
      where: { sku, field: CatalogDisagreementField.name, resolvedAt: null },
    });
    expect(open).toHaveLength(1);
  });
});

describe("adjustLot blocked-lot override and lot delta ledger", () => {
  it("QUARANTINED without override → 409; COOP_ADMIN override succeeds with lot delta", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { stock: 10, cost: 2.5 });
    const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });
    await inventoryService.quarantineLot(asAuthUser(storeAdmin), store.id, lot.id, "Hold");

    try {
      await inventoryService.adjustLot(product.id, store.id, asAuthUser(storeAdmin), {
        lotId: lot.id,
        newQuantity: 12,
        reason: "Found more",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(409);
    }

    const result = await inventoryService.adjustLot(product.id, store.id, asAuthUser(coopAdmin), {
      lotId: lot.id,
      newQuantity: 12,
      reason: "Found more",
      overrideBlockedLot: true,
      overrideReason: "Verified by warehouse",
    });
    expect(result.delta).toBe(2);

    const adj = await prisma.stockAdjustment.findFirstOrThrow({
      where: { productId: product.id, lotId: lot.id, reason: "MANUAL:Found more" },
    });
    expect(adj.delta).toBe(2);
    expect(adj.lotPreviousQty).toBe(10);
    expect(adj.lotNewQty).toBe(12);
    expect(adj.previousStock).toBe(0);
    expect(adj.newStock).toBe(0);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        entityId: lot.id,
        action: AuditAction.STOCK_COUNT_BLOCKED_LOT_OVERRIDE,
      },
    });
    expect(audit.userId).toBe(coopAdmin.id);
  });
});

describe("price ceiling race", () => {
  it("concurrent ceiling-lower + price-save never leaves retail price above the ceiling", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const catalog = await prisma.catalogItem.create({
      data: {
        sku: `CEIL-${Date.now()}`,
        name: "Ceiling Race",
        category: "Test",
        taxExempt: false,
        unitsPerCase: 1,
        maxShelfPrice: new Prisma.Decimal(10),
      },
    });
    const product = await inventoryService.createProduct(
      store.id,
      {
        catalogItemId: catalog.id,
        price: 9,
        cost: 2,
        stock: 0,
        reorderAt: 0,
      },
      asAuthUser(storeAdmin),
    );

    const results = await Promise.allSettled([
      catalogService.updateCatalogItem(asAuthUser(coopAdmin), catalog.id, {
        maxShelfPrice: 5,
      }),
      inventoryService.updateProduct(
        product.id,
        store.id,
        { price: 8 },
        asAuthUser(storeAdmin),
      ),
    ]);

    const final = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    const ceiling = await prisma.catalogItem.findUniqueOrThrow({ where: { id: catalog.id } });
    expect(Number(final.price)).toBeLessThanOrEqual(Number(ceiling.maxShelfPrice));
    expect(Number(ceiling.maxShelfPrice)).toBe(5);

    // At least one path completed; if price-save lost the race it threw 400 or was clamped by ceiling update.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });
});

describe("RefundRestockLot", () => {
  it("partial refund with restock across two lots writes two RefundRestockLot rows", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, {
      stock: 0,
      cost: 2,
      price: 10,
      skipLot: true,
      sku: `RRL-${Date.now()}`,
    });

    // Two ACTIVE lots, FEFO will consume from lot A then B.
    const lotA = await prisma.lot.create({
      data: {
        lotNumber: "A-1",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 3,
        quantityRemaining: 3,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(2),
        receivedAt: new Date("2026-01-01"),
        expiryDate: new Date("2026-06-01"),
        status: LotStatus.ACTIVE,
      },
    });
    const lotB = await prisma.lot.create({
      data: {
        lotNumber: "B-1",
        productId: product.id,
        storeId: store.id,
        quantityReceived: 3,
        quantityRemaining: 3,
        quantityReserved: 0,
        unitCost: new Prisma.Decimal(3),
        receivedAt: new Date("2026-01-02"),
        expiryDate: new Date("2026-07-01"),
        status: LotStatus.ACTIVE,
      },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { stock: 6 },
    });

    const { sale } = await salesService.createSale(store.id, asAuthUser(cashier), {
      items: [{ productId: product.id, quantity: 4 }],
      paymentMethod: PaymentMethod.TERMINAL,
    });
    const paid = await salesService.finalizePaidSale(sale.id);
    const line = paid.items[0]!;

    const beforeA = (await prisma.lot.findUniqueOrThrow({ where: { id: lotA.id } })).quantityRemaining;
    const beforeB = (await prisma.lot.findUniqueOrThrow({ where: { id: lotB.id } })).quantityRemaining;

    // Refund the whole line (4 units) — FEFO allocated 3 from A and 1 from B.
    await salesService.refundSale(paid.id, store.id, {
      items: [{ saleItemId: line.id, quantity: 4 }],
      restock: true,
      createdByUserId: storeAdmin.id,
    });

    const rows = await prisma.refundRestockLot.findMany({
      where: { saleItemId: line.id },
      orderBy: { lotId: "asc" },
    });
    expect(rows).toHaveLength(2);
    const byLot = Object.fromEntries(rows.map((r) => [r.lotId, r.quantity]));
    expect(byLot[lotA.id]).toBe(3);
    expect(byLot[lotB.id]).toBe(1);

    const afterA = (await prisma.lot.findUniqueOrThrow({ where: { id: lotA.id } })).quantityRemaining;
    const afterB = (await prisma.lot.findUniqueOrThrow({ where: { id: lotB.id } })).quantityRemaining;
    expect(afterA - beforeA).toBe(3);
    expect(afterB - beforeB).toBe(1);
  });
});
