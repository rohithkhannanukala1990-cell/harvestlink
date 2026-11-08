/**
 * Staging walkthrough — anonymised past container (Rabi turmeric, Nhava Sheva → Houston).
 *
 * Paperwork basis (names/numbers fictionalised):
 *   Commercial invoice INV-DG-2026-0418 · INR · Deccan Growers PC (Latur)
 *   BL MSDU7845123 · 40' FCL · vessel "Pacific Bridge V.092E"
 *   Est. costs from booking note; finals from broker settlement + ocean invoice.
 *
 * Run: npx tsx scripts/staging-container-walkthrough.ts
 * Writes JSON summary to scripts/out/container-walkthrough-summary.json
 */
import {
  CertificationType,
  CostAllocationBasis,
  ImportShipmentStatus,
  Incoterm,
  LocationType,
  OrganicStatus,
  ShipmentCostStatus,
  ShipmentCostType,
  ShipmentDocType,
  ShipmentMode,
  SupplierType,
} from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import * as catalog from "../src/services/catalog.service.js";
import * as compliance from "../src/services/compliance.service.js";
import * as documents from "../src/services/document.service.js";
import * as inventory from "../src/services/inventory.service.js";
import {
  previewAllocation,
  previewTrueUp,
  trueUpShipment,
} from "../src/services/landedCost.service.js";
import * as purchasing from "../src/services/purchasing.service.js";
import * as shipment from "../src/services/shipment.service.js";
import { prisma } from "../src/lib/prisma.js";
import type { AuthUser } from "../src/types/auth.js";

dotenv.config();

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "out", "container-walkthrough-summary.json");

function money(n: number | string): number {
  return Math.round(Number(n) * 100) / 100;
}

function asAdmin(user: { id: string; storeId: string | null; role: string }): AuthUser {
  return {
    id: user.id,
    storeId: user.storeId,
    role: user.role as AuthUser["role"],
    mustChangePassword: false,
  };
}

async function main() {
  const adminUser = await prisma.user.findUniqueOrThrow({
    where: { email: process.env.SEED_ADMIN_EMAIL ?? "admin@harvestlink.local" },
  });
  const admin = asAdmin(adminUser);

  const warehouse = await prisma.store.findFirstOrThrow({
    where: { locationType: LocationType.WAREHOUSE, name: { contains: "Houston" } },
  });
  const settings = await prisma.cooperativeSettings.findFirst();
  if (!settings?.mainWarehouseId) {
    throw new Error("CooperativeSettings.mainWarehouseId missing — run seed first");
  }

  const stamp = Date.now().toString(36).toUpperCase();

  // ── 1. FPO profile (anonymised Deccan Growers PC, Latur) ───────────────────
  const fpo = await purchasing.createSupplier(admin, {
    name: `Deccan Growers PC (${stamp})`,
    contactName: "S. Patil",
    email: `ops+${stamp}@deccan-growers.example`,
    phone: "+91-23-8120-4400",
    address: "MIDC Area, Latur, Maharashtra 413531",
    paymentTerms: "CAD",
    leadTimeDays: 45,
    supplierType: SupplierType.FPO,
    country: "IN",
  });
  await purchasing.upsertFpoProfile(admin, {
    supplierId: fpo.id,
    legalForm: "PRODUCER_COMPANY",
    registrationNumber: "U01100MH2019PTC381204",
    state: "Maharashtra",
    district: "Latur",
    block: "Ausa",
    memberFarmerCount: 214,
    memberFarmerCountAsOf: "2026-01-15T00:00:00.000Z",
    womenFarmerCount: 68,
    primaryCrops: ["turmeric", "sorghum"],
    notes: "Anonymised staging fixture — Rabi 2026 container walkthrough",
  });
  await compliance.upsertSupplierCertification(admin, {
    supplierId: fpo.id,
    certType: CertificationType.FSVP_VERIFICATION,
    certNumber: `FSVP-DG-${stamp}`,
    issuedAt: "2025-11-01",
    expiresAt: "2027-11-01",
    nextReviewDue: "2027-05-01",
    notes: "Importer verification on file",
  });

  // ── 2. Catalog + warehouse products ────────────────────────────────────────
  const catFinger = await catalog.createCatalogItem(admin, {
    sku: `TRM-FINGER-${stamp}`,
    name: "Turmeric finger (dried)",
    category: "Spices",
    maxShelfPrice: 8.5,
    unitsPerCase: 20,
  });
  const catPowder = await catalog.createCatalogItem(admin, {
    sku: `TRM-PWD-${stamp}`,
    name: "Turmeric powder (organic)",
    category: "Spices",
    maxShelfPrice: 11.0,
    unitsPerCase: 20,
  });
  const fingers = await inventory.createProduct(
    warehouse.id,
    { catalogItemId: catFinger.id, cost: 2.0, stock: 0, reorderAt: 200 },
    admin,
  );
  const powder = await inventory.createProduct(
    warehouse.id,
    { catalogItemId: catPowder.id, cost: 2.5, stock: 0, reorderAt: 100 },
    admin,
  );

  // ── 3. PO in INR (commercial invoice INV-DG-2026-0418) ─────────────────────
  // FX: 1 USD = 83.333 INR → fxRateToUsd = 0.012
  const fx = 0.012;
  const po = await purchasing.createPurchaseOrder(admin, {
    supplierId: fpo.id,
    storeId: warehouse.id,
    currency: "INR",
    fxRateToUsd: fx,
    lines: [
      {
        productId: fingers.id,
        orderedQty: 8000, // kg
        unitCostForeign: 180, // INR/kg → $2.16
      },
      {
        productId: powder.id,
        orderedQty: 2000,
        unitCostForeign: 220, // INR/kg → $2.64
      },
    ],
  });
  await purchasing.submitPurchaseOrder(admin, po.id);

  const invoiceValueUsd = po.lines.reduce(
    (s, l) => s + Number(l.unitCost) * l.orderedQty,
    0,
  );

  // ── 4. Shipment + lines + estimated costs ──────────────────────────────────
  const s = await shipment.createShipment(admin, {
    mode: ShipmentMode.SEA_FCL,
    incoterm: Incoterm.FOB,
    originPort: "INNSA",
    destinationPort: "USHOU",
    carrier: "MSC",
    vesselVoyage: "Pacific Bridge V.092E",
    containerNumber: "MSDU7845123",
    billOfLadingNumber: `MEDU${stamp}INHOU`,
    etd: "2026-03-12T00:00:00.000Z",
    eta: "2026-04-18T00:00:00.000Z",
  });
  await shipment.attachPurchaseOrder(admin, s.id, po.id);

  // Customs values = invoice USD line totals; duty est. ~6% HTS 0910.30
  const fingerCustoms = money(8000 * 2.16); // 17280
  const powderCustoms = money(2000 * 2.64); // 5280
  const fingerDutyEst = money(fingerCustoms * 0.06); // 1036.80
  const powderDutyEst = money(powderCustoms * 0.06); // 316.80
  const dutyEstTotal = money(fingerDutyEst + powderDutyEst); // 1353.60

  await shipment.upsertShipmentLines(admin, s.id, [
    {
      poLineId: po.lines[0]!.id,
      quantity: 8000,
      grossWeightKg: 8200,
      volumeCbm: 18.4,
      htsCode: "0910.30.00",
      dutyRatePercent: 6,
      customsValueUsd: fingerCustoms,
      dutyAmountUsd: fingerDutyEst,
    },
    {
      poLineId: po.lines[1]!.id,
      quantity: 2000,
      grossWeightKg: 2100,
      volumeCbm: 4.2,
      htsCode: "0910.30.00",
      dutyRatePercent: 6,
      customsValueUsd: powderCustoms,
      dutyAmountUsd: powderDutyEst,
    },
  ]);

  let shipState = await shipment.addCost(admin, s.id, {
    costType: ShipmentCostType.OCEAN_FREIGHT,
    vendorName: "MSC Agency",
    invoiceNumber: "EST-MSC-092E",
    amountForeign: 4800,
    allocationBasis: CostAllocationBasis.VALUE,
    status: ShipmentCostStatus.ESTIMATED,
  });
  const freightEstId = shipState.costs.find(
    (c) => c.costType === ShipmentCostType.OCEAN_FREIGHT,
  )!.id;

  shipState = await shipment.addCost(admin, s.id, {
    costType: ShipmentCostType.INSURANCE,
    vendorName: "Marine Cover Co",
    invoiceNumber: "EST-INS-418",
    amountForeign: 350,
    allocationBasis: CostAllocationBasis.VALUE,
    status: ShipmentCostStatus.ESTIMATED,
  });
  shipState = await shipment.addCost(admin, s.id, {
    costType: ShipmentCostType.BROKER_FEE,
    vendorName: "Gulf Customs Brokers",
    invoiceNumber: "EST-BRK-2204",
    amountForeign: 450,
    allocationBasis: CostAllocationBasis.VALUE,
    status: ShipmentCostStatus.ESTIMATED,
  });
  shipState = await shipment.addCost(admin, s.id, {
    costType: ShipmentCostType.CUSTOMS_DUTY,
    vendorName: "CBP",
    invoiceNumber: "EST-DUTY-0910",
    amountForeign: dutyEstTotal,
    allocationBasis: CostAllocationBasis.LINE_SPECIFIC,
    status: ShipmentCostStatus.ESTIMATED,
  });
  const dutyEstId = shipState.costs.find(
    (c) => c.costType === ShipmentCostType.CUSTOMS_DUTY,
  )!.id;

  const allocAtEstimate = await previewAllocation(admin, s.id);

  // FDA prior notice (required at receive)
  const pnDoc = await documents.uploadDocument(admin, {
    buffer: Buffer.from("%PDF-1.4\nFDA Prior Notice — staging anonymised\n%%EOF\n"),
    fileName: `fda-prior-notice-${stamp}.pdf`,
    mimeType: "application/pdf",
  });
  await compliance.attachShipmentDocument(admin, {
    shipmentId: s.id,
    docType: ShipmentDocType.FDA_PRIOR_NOTICE,
    documentId: pnDoc.id,
    referenceNumber: `PN-${stamp}`,
  });

  for (const status of [
    ImportShipmentStatus.BOOKED,
    ImportShipmentStatus.IN_TRANSIT,
    ImportShipmentStatus.AT_PORT,
    ImportShipmentStatus.CLEARED,
    ImportShipmentStatus.DELIVERED,
  ] as const) {
    await shipment.transitionStatus(admin, s.id, {
      status,
      ...(status === ImportShipmentStatus.IN_TRANSIT
        ? { actualDeparture: "2026-03-12T18:00:00.000Z" }
        : {}),
      ...(status === ImportShipmentStatus.AT_PORT
        ? { actualArrival: "2026-04-17T14:00:00.000Z" }
        : {}),
      ...(status === ImportShipmentStatus.CLEARED
        ? { clearedAt: "2026-04-18T10:00:00.000Z" }
        : {}),
      ...(status === ImportShipmentStatus.DELIVERED
        ? { deliveredAt: "2026-04-19T16:00:00.000Z" }
        : {}),
    });
  }

  // ── 5. Receive into Houston warehouse ──────────────────────────────────────
  const received = await purchasing.receiveGoods(admin, po.id, {
    invoiceNumber: "INV-DG-2026-0418",
    notes: "Staging walkthrough — Rabi turmeric FCL",
    lines: [
      {
        poLineId: po.lines[0]!.id,
        quantityReceived: 8000,
        unitCostActual: 2.16,
        lotNumber: `LATUR-RABI26-F-${stamp}`,
        countryOfOrigin: "IN",
        origin: {
          state: "Maharashtra",
          district: "Latur",
          village: "Killari",
          crop: "turmeric",
          variety: "Salem finger",
          harvestSeason: "Rabi 2026",
          contributingFarmerCount: 214,
          organicStatus: OrganicStatus.CONVENTIONAL,
        },
      },
      {
        poLineId: po.lines[1]!.id,
        quantityReceived: 2000,
        unitCostActual: 2.64,
        lotNumber: `LATUR-RABI26-P-${stamp}`,
        countryOfOrigin: "IN",
        origin: {
          state: "Maharashtra",
          district: "Latur",
          crop: "turmeric",
          variety: "powdered",
          harvestSeason: "Rabi 2026",
          contributingFarmerCount: 86,
          organicStatus: OrganicStatus.CERTIFIED_ORGANIC,
        },
      },
    ],
  });

  const lotsAtReceive = await prisma.lot.findMany({
    where: { productId: { in: [fingers.id, powder.id] } },
    orderBy: { lotNumber: "asc" },
  });

  // ── 6. Final invoices + true-up ────────────────────────────────────────────
  // Ocean freight final $5,420 (was $4,800). Duty final 6.5% (was 6%).
  // Update LINE_SPECIFIC duty amounts only immediately before superseding duty —
  // otherwise allocation preview during VALUE supersedes fails the duty sum check.
  const fingerDutyFinal = money(fingerCustoms * 0.065);
  const powderDutyFinal = money(powderCustoms * 0.065);
  const dutyFinalTotal = money(fingerDutyFinal + powderDutyFinal);

  await shipment.supersedeCost(admin, s.id, freightEstId, {
    amountForeign: 5420,
    vendorName: "MSC Agency",
    invoiceNumber: "MSC-INV-092E-FINAL",
  });
  const afterFreight = await shipment.getShipment(admin, s.id);
  const insuranceEst = afterFreight.costs.find(
    (c) =>
      c.costType === ShipmentCostType.INSURANCE &&
      c.status === ShipmentCostStatus.ESTIMATED &&
      !afterFreight.costs.some((x) => x.supersedesCostId === c.id),
  )!;
  const brokerEst = afterFreight.costs.find(
    (c) =>
      c.costType === ShipmentCostType.BROKER_FEE &&
      c.status === ShipmentCostStatus.ESTIMATED &&
      !afterFreight.costs.some((x) => x.supersedesCostId === c.id),
  )!;

  await shipment.supersedeCost(admin, s.id, insuranceEst.id, {
    amountForeign: 380,
    invoiceNumber: "INS-FINAL-418",
  });
  await shipment.supersedeCost(admin, s.id, brokerEst.id, {
    amountForeign: 450,
    invoiceNumber: "BRK-FINAL-2204",
  });

  await shipment.upsertShipmentLines(admin, s.id, [
    {
      poLineId: po.lines[0]!.id,
      quantity: 8000,
      grossWeightKg: 8200,
      volumeCbm: 18.4,
      htsCode: "0910.30.00",
      dutyRatePercent: 6.5,
      customsValueUsd: fingerCustoms,
      dutyAmountUsd: fingerDutyFinal,
    },
    {
      poLineId: po.lines[1]!.id,
      quantity: 2000,
      grossWeightKg: 2100,
      volumeCbm: 4.2,
      htsCode: "0910.30.00",
      dutyRatePercent: 6.5,
      customsValueUsd: powderCustoms,
      dutyAmountUsd: powderDutyFinal,
    },
  ]);
  await shipment.supersedeCost(admin, s.id, dutyEstId, {
    amountForeign: dutyFinalTotal,
    invoiceNumber: "CBP-ENTRY-FINAL",
    allocationBasis: CostAllocationBasis.LINE_SPECIFIC,
  });

  const allocAtFinal = await previewAllocation(admin, s.id);
  const trueUpPreview = await previewTrueUp(admin, s.id);
  const trueUpResult = await trueUpShipment(admin, s.id);

  const finalShip = await shipment.getShipment(admin, s.id);
  const lotsAfter = await prisma.lot.findMany({
    where: { productId: { in: [fingers.id, powder.id] } },
    include: { product: { select: { sku: true, name: true } } },
    orderBy: { lotNumber: "asc" },
  });

  const estimateLanded = money(
    Number(allocAtEstimate.lines.reduce((s, l) => s + Number(l.landedAddOnTotal), 0)),
  );
  const finalLanded = money(Number(finalShip.landedCostsUsd));
  const activeFinalCosts = finalShip.costs.filter((c) => {
    const superseded = new Set(
      finalShip.costs.filter((x) => x.supersedesCostId).map((x) => x.supersedesCostId!),
    );
    return !superseded.has(c.id);
  });

  const summary = {
    title: "Staging container walkthrough — Rabi turmeric FCL (anonymised)",
    paperwork: {
      commercialInvoice: "INV-DG-2026-0418",
      billOfLading: `MEDU${stamp}INHOU`,
      container: "MSDU7845123",
      vessel: "Pacific Bridge V.092E",
      route: "INNSA → USHOU",
      fpo: fpo.name,
      district: "Latur",
      season: "Rabi 2026",
      farmers: 214,
    },
    shipment: {
      id: s.id,
      number: finalShip.shipmentNumber,
      status: finalShip.status,
      destination: warehouse.name,
    },
    purchaseOrder: {
      id: po.id,
      number: po.poNumber,
      currency: "INR",
      fxRateToUsd: fx,
    },
    invoiceValueUsd: money(invoiceValueUsd),
    invoiceLines: po.lines.map((l) => ({
      sku: l.productId === fingers.id ? fingers.sku : powder.sku,
      name: l.productId === fingers.id ? fingers.name : powder.name,
      qtyKg: l.orderedQty,
      unitInr: Number(l.unitCostForeign),
      unitUsd: Number(l.unitCost),
      lineUsd: money(Number(l.unitCost) * l.orderedQty),
    })),
    estimatedCosts: [
      { type: "OCEAN_FREIGHT", amountUsd: 4800 },
      { type: "INSURANCE", amountUsd: 350 },
      { type: "BROKER_FEE", amountUsd: 450 },
      { type: "CUSTOMS_DUTY", amountUsd: dutyEstTotal },
    ],
    finalCosts: activeFinalCosts.map((c) => ({
      type: c.costType,
      amountUsd: money(Number(c.amountUsd)),
      invoiceNumber: c.invoiceNumber,
      status: c.status,
    })),
    landedCostsUsd: {
      atEstimate: estimateLanded,
      atFinal: finalLanded,
      difference: money(finalLanded - estimateLanded),
    },
    upliftPercent: {
      atEstimate: money((estimateLanded / invoiceValueUsd) * 100),
      atFinal: money(Number(finalShip.upliftPercent)),
    },
    allocationByProduct: allocAtFinal.lines.map((l) => ({
      sku: l.sku,
      name: l.name,
      qty: l.quantity,
      invoiceUnitUsd: money(Number(l.customsValueUsd) / l.quantity),
      landedAddOnPerUnit: Number(l.landedAddOnPerUnit),
      landedUnitCost: Number(l.landedUnitCost),
      upliftPercent: Number(l.upliftPercent),
    })),
    lotsAfterTrueUp: lotsAfter.map((l) => ({
      lotNumber: l.lotNumber,
      sku: l.product.sku,
      name: l.product.name,
      qtyRemaining: l.quantityRemaining,
      unitCost: Number(l.unitCost),
      landedAddOnApplied: Number(l.landedAddOnApplied),
    })),
    trueUp: {
      hasChanges: trueUpPreview.hasChanges,
      totalVarianceUsd: trueUpPreview.totalVarianceUsd,
      wroteChanges: trueUpResult.wroteChanges,
      movedToCosted: trueUpResult.movedToCosted,
      lots: trueUpPreview.lots,
    },
    receive: {
      receiptId: received.receipt.id,
      shipmentMarkedReceived: received.shipmentMarkedReceived,
      lotsCreated: lotsAtReceive.map((l) => ({
        lotNumber: l.lotNumber,
        unitCostAtReceive: Number(l.unitCost),
        landedAddOnAtReceive: Number(l.landedAddOnApplied),
      })),
    },
    uiFrictionNotes: [
      "No Create Shipment form in the UI — list/detail are read-oriented; creation still needs API/seed.",
      "Shipment detail cannot attach POs, upsert lines (HTS/weight/duty), or add/supersede costs from the screen.",
      "Document upload is multipart; the FE client is JSON-only — FDA prior notice cannot be attached from the UI yet.",
      "PO edit supports INR + FX and live USD, but Receive Goods origin is a dense free-text block (FPO id for exporters is a raw supplier cuid).",
      "True-up preview/run exists on shipment detail, but status transitions and final cost entry must happen off-screen first.",
      "Supplier FPO profile + certs work for COOP_ADMIN; farmer count as-of is easy to miss if the date field is left blank on first save.",
    ],
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${OUT}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
