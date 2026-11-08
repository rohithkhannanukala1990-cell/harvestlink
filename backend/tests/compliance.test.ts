/**
 * Document storage, certifications, shipment docs, receive compliance gaps, expiring feed.
 */
import {
  CertificationType,
  Incoterm,
  LocationType,
  OrganicStatus,
  ShipmentDocType,
  ShipmentMode,
  SupplierType,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runFlagExpiringCertificationsOnce } from "../src/jobs/flagExpiringCertifications.js";
import { AppError } from "../src/lib/errors.js";
import * as compliance from "../src/services/compliance.service.js";
import * as documents from "../src/services/document.service.js";
import * as purchasing from "../src/services/purchasing.service.js";
import * as shipment from "../src/services/shipment.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createProduct,
  createStore,
  seedCashierStore,
} from "./helpers/factories.js";

async function warehouseForCoop() {
  const wh = await createStore({
    name: `WH-${Date.now()}`,
    locationType: LocationType.WAREHOUSE,
  });
  await prisma.cooperativeSettings.create({
    data: {
      legalEntityName: "Test Co-op",
      mainWarehouseId: wh.id,
      operatingState: "TX",
      stateOfIncorporation: "OH",
    },
  });
  return wh;
}

function pdfBuffer(label: string): Buffer {
  // Minimal PDF-ish bytes for storage tests (MIME is what we validate).
  return Buffer.from(`%PDF-1.4\n${label}\n%%EOF\n`);
}

const origin = {
  state: "Maharashtra",
  district: "Pune",
  crop: "turmeric",
  organicStatus: OrganicStatus.CONVENTIONAL,
};

describe("compliance documents", () => {
  it("CASHIER cannot upload, download, or list shipment documents", async () => {
    const { cashier, coopAdmin } = await seedCashierStore();
    await warehouseForCoop();
    const admin = asAuthUser(coopAdmin);
    const cashierActor = asAuthUser(cashier);
    const doc = await documents.uploadDocument(admin, {
      buffer: pdfBuffer("secret"),
      fileName: "secret.pdf",
      mimeType: "application/pdf",
    });
    const s = await shipment.createShipment(admin, {
      mode: ShipmentMode.SEA_FCL,
      incoterm: Incoterm.FOB,
    });

    await expect(
      documents.uploadDocument(cashierActor, {
        buffer: pdfBuffer("nope"),
        fileName: "nope.pdf",
        mimeType: "application/pdf",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(documents.openDocumentDownload(cashierActor, doc.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      compliance.listShipmentDocuments(cashierActor, s.id),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("uploads a PDF with sha256/size/mime; download opens; delete blocked after received shipment", async () => {
    const { store, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    await warehouseForCoop();
    const buf = pdfBuffer("invoice");
    const sha = createHash("sha256").update(buf).digest("hex");

    const doc = await documents.uploadDocument(admin, {
      buffer: buf,
      fileName: "invoice.pdf",
      mimeType: "application/pdf",
    });
    expect(doc.sha256).toBe(sha);
    expect(doc.sizeBytes).toBe(buf.byteLength);
    expect(doc.mimeType).toBe("application/pdf");

    const opened = await documents.openDocumentDownload(admin, doc.id);
    expect(opened.mimeType).toBe("application/pdf");
    expect(opened.sizeBytes).toBe(buf.byteLength);

    const product = await createProduct(store.id, { stock: 0, cost: 1, price: 3 });
    const supplier = await purchasing.createSupplier(admin, {
      name: `EXP-${Date.now()}`,
      supplierType: SupplierType.EXPORTER,
      country: "IN",
    });
    const po = await purchasing.createPurchaseOrder(admin, {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 2, unitCost: 1 }],
    });
    await purchasing.submitPurchaseOrder(admin, po.id);
    const s = await shipment.createShipment(admin, {
      mode: ShipmentMode.SEA_FCL,
      incoterm: Incoterm.FOB,
    });
    await shipment.attachPurchaseOrder(admin, s.id, po.id);
    await compliance.attachShipmentDocument(admin, {
      shipmentId: s.id,
      docType: ShipmentDocType.FDA_PRIOR_NOTICE,
      documentId: doc.id,
    });

    // Mark shipment received so document is locked
    await prisma.importShipment.update({
      where: { id: s.id },
      data: { status: "RECEIVED" },
    });

    await expect(documents.deleteDocument(admin, doc.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("receive warns on missing FSVP / FDA prior notice; COOP_ADMIN override is audited", async () => {
    const { store, storeAdmin, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    await warehouseForCoop();
    const product = await createProduct(store.id, { stock: 0, cost: 2, price: 5 });
    const supplier = await purchasing.createSupplier(admin, {
      name: `FPO-${Date.now()}`,
      supplierType: SupplierType.FPO,
      country: "IN",
    });
    const po = await purchasing.createPurchaseOrder(admin, {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 5, unitCost: 2 }],
    });
    await purchasing.submitPurchaseOrder(admin, po.id);
    const s = await shipment.createShipment(admin, {
      mode: ShipmentMode.AIR,
      incoterm: Incoterm.DAP,
    });
    await shipment.attachPurchaseOrder(admin, s.id, po.id);

    await expect(
      purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
        acknowledgeNoLandedCost: true,
        lines: [
          {
            poLineId: po.lines[0]!.id,
            quantityReceived: 5,
            unitCostActual: 2,
            origin,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(AppError);

    try {
      await purchasing.receiveGoods(admin, po.id, {
        acknowledgeNoLandedCost: true,
        lines: [
          {
            poLineId: po.lines[0]!.id,
            quantityReceived: 5,
            unitCostActual: 2,
            origin,
          },
        ],
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const err = error as AppError;
      expect(err.status).toBe(409);
      const gaps = (err.details as { gaps: Array<{ code: string }> }).gaps;
      expect(gaps.map((g) => g.code).sort()).toEqual([
        "MISSING_FDA_PRIOR_NOTICE",
        "MISSING_FSVP",
      ]);
    }

    const result = await purchasing.receiveGoods(admin, po.id, {
      acknowledgeNoLandedCost: true,
      acknowledgeComplianceGaps: true,
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 5,
          unitCostActual: 2,
          origin,
        },
      ],
    });
    expect(result.complianceGapsAcknowledged?.length).toBe(2);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "COMPLIANCE_GAP_OVERRIDE", entityId: s.id },
    });
    expect(audit).toBeTruthy();
  });

  it("current FSVP + FDA prior notice clears the receive warning", async () => {
    const { store, coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    await warehouseForCoop();
    const product = await createProduct(store.id, { stock: 0, cost: 2, price: 5 });
    const supplier = await purchasing.createSupplier(admin, {
      name: `OK-${Date.now()}`,
      supplierType: SupplierType.EXPORTER,
      country: "IN",
    });
    const fpo = await purchasing.createSupplier(admin, {
      name: `FPO-grow-${Date.now()}`,
      supplierType: SupplierType.FPO,
      country: "IN",
    });
    await compliance.upsertSupplierCertification(admin, {
      supplierId: supplier.id,
      certType: CertificationType.FSVP_VERIFICATION,
      certNumber: "FSVP-1",
      issuedAt: new Date(),
      nextReviewDue: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    const doc = await documents.uploadDocument(admin, {
      buffer: pdfBuffer("pn"),
      fileName: "prior-notice.pdf",
      mimeType: "application/pdf",
    });
    const po = await purchasing.createPurchaseOrder(admin, {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 3, unitCost: 2 }],
    });
    await purchasing.submitPurchaseOrder(admin, po.id);
    const s = await shipment.createShipment(admin, {
      mode: ShipmentMode.SEA_LCL,
      incoterm: Incoterm.CIF,
    });
    await shipment.attachPurchaseOrder(admin, s.id, po.id);
    await compliance.attachShipmentDocument(admin, {
      shipmentId: s.id,
      docType: ShipmentDocType.FDA_PRIOR_NOTICE,
      documentId: doc.id,
      referenceNumber: "PN-99",
    });

    const gaps = await compliance.findReceiveComplianceGaps({
      supplierId: supplier.id,
      supplierType: SupplierType.EXPORTER,
      shipmentId: s.id,
    });
    expect(gaps).toEqual([]);

    const result = await purchasing.receiveGoods(admin, po.id, {
      acknowledgeNoLandedCost: true,
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 3,
          unitCostActual: 2,
          origin: { ...origin, fpoSupplierId: fpo.id },
        },
      ],
    });
    expect(result.complianceGapsAcknowledged).toBeNull();
  });

  it("expiring certifications appear in the 30-day feed and job flags once per day", async () => {
    const { coopAdmin } = await seedCashierStore();
    const admin = asAuthUser(coopAdmin);
    const supplier = await purchasing.createSupplier(admin, { name: `CERT-${Date.now()}` });
    const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await compliance.upsertSupplierCertification(admin, {
      supplierId: supplier.id,
      certType: CertificationType.ORGANIC_USDA,
      certNumber: "ORG-1",
      issuedAt: new Date("2025-01-01"),
      expiresAt: soon,
      nextReviewDue: soon,
    });

    const feed = await compliance.listExpiringCertifications(admin, 30);
    expect(feed.some((r) => r.supplierId === supplier.id && r.reason === "EXPIRING")).toBe(
      true,
    );

    const first = await runFlagExpiringCertificationsOnce();
    expect(first.flaggedIds.length).toBeGreaterThan(0);
    const second = await runFlagExpiringCertificationsOnce();
    expect(second.alreadyFlaggedToday.length).toBeGreaterThan(0);
  });
});
