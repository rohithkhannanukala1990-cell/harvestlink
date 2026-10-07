/**
 * Barcodes: normalization / GS1 parsing, registration rules, scan lookup, receiving lot labels.
 */
import { BarcodeKind, Role } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuditAction } from "../src/lib/audit.js";
import {
  GS,
  expandUpcE,
  gtinCheckDigitValid,
  isValidGtin,
  normalizeBarcode,
  parseGs1,
} from "../src/lib/barcode.js";
import * as barcodeService from "../src/services/barcode.service.js";
import * as purchasing from "../src/services/purchasing.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createProduct,
  createStore,
  createUser,
  seedCashierStore,
  signTestToken,
} from "./helpers/factories.js";

const UPC_A = "036000291452";
const GS1_GTIN = "09506000134352";

describe("barcode normalization", () => {
  it("treats UPC-A, EAN-13 and GTIN-14 forms of one item as the same code", () => {
    expect(normalizeBarcode(UPC_A).code).toBe("00036000291452");
    expect(normalizeBarcode(`0${UPC_A}`).code).toBe("00036000291452");
    expect(normalizeBarcode(`00${UPC_A}`).code).toBe("00036000291452");
  });

  it("strips AIM prefixes and control characters, and undoes Caps Lock", () => {
    expect(normalizeBarcode(`]E0${UPC_A}\r\n`)).toEqual({ code: "00036000291452", symbology: "]E0" });
    expect(normalizeBarcode("  shelf-77\t").code).toBe("SHELF-77");
  });

  it("validates GS1 check digits, including UPC-E via its UPC-A expansion", () => {
    expect(gtinCheckDigitValid(UPC_A)).toBe(true);
    expect(gtinCheckDigitValid("036000291453")).toBe(false);
    expect(expandUpcE("04252614")).toBe("042100005264");
    expect(isValidGtin("04252614")).toBe(true);
    expect(isValidGtin("96385074")).toBe(true); // EAN-8
    expect(isValidGtin("12345678")).toBe(false);
  });

  it("parses GS1 element strings in printed and scanned forms", () => {
    expect(parseGs1(`(01)${GS1_GTIN}(17)201225(10)ABC123`)).toMatchObject({
      gtin: GS1_GTIN,
      lot: "ABC123",
      expiry: "2020-12-25",
    });
    expect(parseGs1(`]C101${GS1_GTIN}10abc${GS}17260200`)).toMatchObject({
      gtin: GS1_GTIN,
      lot: "ABC",
      expiry: "2026-02-28",
    });
    expect(parseGs1(UPC_A)).toBeNull();
    expect(parseGs1("SHELF-77")).toBeNull();
    expect(parseGs1("0109506000134353")).toBeNull(); // bad GTIN check digit
  });
});

describe("barcode registration and lookup", () => {
  it("allows several codes per product but one meaning per code within a store", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const admin = asAuthUser(storeAdmin);
    const beans = await createProduct(store.id, { sku: "BEANS-1", name: "Beans" });
    const rice = await createProduct(store.id, { sku: "RICE-1", name: "Rice" });

    const upc = await barcodeService.addProductBarcode(admin, store.id, beans.id, { code: UPC_A });
    expect(upc).toMatchObject({ code: "00036000291452", kind: BarcodeKind.GTIN });
    const shelf = await barcodeService.addProductBarcode(admin, store.id, beans.id, {
      code: "shelf-77",
      label: "shelf tag",
    });
    expect(shelf.kind).toBe(BarcodeKind.INTERNAL);

    // Same item, EAN-13 form, on a different product: a duplicate, not a new code.
    await expect(
      barcodeService.addProductBarcode(admin, store.id, rice.id, { code: `0${UPC_A}` }),
    ).rejects.toMatchObject({ status: 409 });
    // Another product's SKU would make scans ambiguous.
    await expect(
      barcodeService.addProductBarcode(admin, store.id, beans.id, { code: "rice-1" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      barcodeService.addProductBarcode(admin, store.id, rice.id, {
        code: "036000291453",
        kind: BarcodeKind.GTIN,
      }),
    ).rejects.toMatchObject({ status: 400 });

    // The same UPC exists once per store: each store has its own product row.
    const other = await createStore({ name: "Other" });
    const otherAdmin = await createUser({ email: `oa-${Date.now()}@t.local`, role: Role.STORE_ADMIN, storeId: other.id });
    const otherBeans = await createProduct(other.id, { sku: "BEANS-1" });
    await barcodeService.addProductBarcode(asAuthUser(otherAdmin), other.id, otherBeans.id, { code: UPC_A });

    const viaEan = await barcodeService.lookupBarcode(store.id, `0${UPC_A}`);
    expect(viaEan.matches).toEqual([
      expect.objectContaining({ matchedBy: "PRODUCT_BARCODE", product: expect.objectContaining({ id: beans.id }) }),
    ]);
    const viaSku = await barcodeService.lookupBarcode(store.id, "rice-1");
    expect(viaSku.matches[0]).toMatchObject({ matchedBy: "SKU", product: { id: rice.id } });
    expect((await barcodeService.lookupBarcode(store.id, "NOPE-404")).matches).toEqual([]);

    const audits = await prisma.auditLog.count({
      where: { storeId: store.id, action: AuditAction.PRODUCT_BARCODE_ADD },
    });
    expect(audits).toBe(2);

    await barcodeService.removeProductBarcode(admin, store.id, shelf.id);
    expect((await barcodeService.lookupBarcode(store.id, "SHELF-77")).matches).toEqual([]);
  });

  it("stores UPC-E as its UPC-A expansion so either form scans", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id);
    const row = await barcodeService.addProductBarcode(asAuthUser(storeAdmin), store.id, product.id, {
      code: "04252614",
    });
    expect(row.code).toBe("00042100005264");
    for (const scan of ["04252614", "042100005264"]) {
      const result = await barcodeService.lookupBarcode(store.id, scan);
      expect(result.matches[0]?.product.id).toBe(product.id);
    }
  });

  it("resolves lot labels and GS1 lot data to the lot", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const admin = asAuthUser(storeAdmin);
    const product = await createProduct(store.id, { sku: "OIL-1" });
    await barcodeService.addProductBarcode(admin, store.id, product.id, { code: GS1_GTIN });
    const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });
    await prisma.lot.update({ where: { id: lot.id }, data: { lotNumber: "ABC123" } });

    const gs1 = await barcodeService.lookupBarcode(store.id, `(01)${GS1_GTIN}(17)201225(10)abc123`);
    expect(gs1.gs1).toMatchObject({ lot: "ABC123", expiry: "2020-12-25" });
    expect(gs1.matches[0]).toMatchObject({ matchedBy: "GS1", lot: { id: lot.id } });

    await barcodeService.setLotBarcode(admin, store.id, lot.id, "lot-label-9");
    const byLabel = await barcodeService.lookupBarcode(store.id, "LOT-LABEL-9");
    expect(byLabel.matches[0]).toMatchObject({ matchedBy: "LOT_BARCODE", lot: { id: lot.id } });
    await expect(
      barcodeService.addProductBarcode(admin, store.id, product.id, { code: "LOT-LABEL-9" }),
    ).rejects.toMatchObject({ status: 409 });

    const byLotNumber = await barcodeService.lookupBarcode(store.id, "abc123");
    expect(byLotNumber.matches[0]).toMatchObject({ matchedBy: "LOT_NUMBER", lot: { id: lot.id } });
  });

  it("captures a lot label at receiving and refuses one already in use", async () => {
    const { store, storeAdmin } = await seedCashierStore();
    const admin = asAuthUser(storeAdmin);
    const product = await createProduct(store.id, { stock: 0 });
    const supplier = await purchasing.createSupplier(admin, { name: "Hill FPO" });
    const po = await purchasing.createPurchaseOrder(admin, {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 10, unitCost: 2 }],
    });
    await purchasing.submitPurchaseOrder(admin, po.id);

    await purchasing.receiveGoods(admin, po.id, {
      lines: [{ poLineId: po.lines[0]!.id, quantityReceived: 4, unitCostActual: 2, lotBarcode: "crate-001" }],
    });
    const lot = await prisma.lot.findFirstOrThrow({ where: { productId: product.id } });
    expect(lot.barcode).toBe("CRATE-001");

    await expect(
      purchasing.receiveGoods(admin, po.id, {
        lines: [{ poLineId: po.lines[0]!.id, quantityReceived: 2, unitCostActual: 2, lotBarcode: "CRATE-001" }],
      }),
    ).rejects.toMatchObject({ status: 409 });
    const lots = await prisma.lot.count({ where: { productId: product.id } });
    expect(lots).toBe(1);
  });

  it("lets any store role look up, but only admins register, within their own store", async () => {
    const { store, cashier, storeAdmin } = await seedCashierStore();
    const product = await createProduct(store.id, { sku: "TEA-1" });
    const app = createApp();
    const cashierAuth = { Authorization: `Bearer ${signTestToken(cashier)}` };
    const adminAuth = { Authorization: `Bearer ${signTestToken(storeAdmin)}` };

    await request(app)
      .post(`/barcodes/products/${product.id}`)
      .set(cashierAuth)
      .send({ code: UPC_A })
      .expect(403);
    await request(app)
      .post(`/barcodes/products/${product.id}`)
      .set(adminAuth)
      .send({ code: UPC_A })
      .expect(201);

    const lookup = await request(app)
      .get(`/barcodes/lookup?code=${UPC_A}`)
      .set(cashierAuth)
      .expect(200);
    expect(lookup.body.matches[0].product.id).toBe(product.id);
    expect(JSON.stringify(lookup.body)).not.toMatch(/stock|quantity/i);

    const other = await createStore({ name: "Elsewhere" });
    await request(app)
      .get(`/barcodes/lookup?code=${UPC_A}&storeId=${other.id}`)
      .set(cashierAuth)
      .expect(403);

    const list = await request(app).get(`/barcodes/products/${product.id}`).set(cashierAuth).expect(200);
    expect(list.body.barcodes).toHaveLength(1);
  });
});
