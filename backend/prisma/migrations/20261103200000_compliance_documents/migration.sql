CREATE TYPE "CertificationType" AS ENUM (
  'FSSAI_LICENSE', 'APEDA_RCMC', 'FDA_FOOD_FACILITY_REGISTRATION',
  'ORGANIC_NPOP', 'ORGANIC_USDA', 'FSVP_VERIFICATION', 'LAB_ACCREDITATION', 'OTHER'
);
CREATE TYPE "ShipmentDocType" AS ENUM (
  'COMMERCIAL_INVOICE', 'PACKING_LIST', 'BILL_OF_LADING', 'AIR_WAYBILL',
  'CERTIFICATE_OF_ORIGIN', 'PHYTOSANITARY_CERTIFICATE', 'FDA_PRIOR_NOTICE',
  'CUSTOMS_ENTRY_SUMMARY', 'LAB_REPORT', 'FUMIGATION_CERTIFICATE',
  'INSURANCE_CERTIFICATE', 'OTHER'
);

CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Document_storageKey_key" ON "Document"("storageKey");
CREATE INDEX "Document_uploadedByUserId_idx" ON "Document"("uploadedByUserId");
CREATE INDEX "Document_sha256_idx" ON "Document"("sha256");
CREATE INDEX "Document_createdAt_idx" ON "Document"("createdAt");

ALTER TABLE "Document" ADD CONSTRAINT "Document_uploadedByUserId_fkey"
  FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SupplierCertification" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "certType" "CertificationType" NOT NULL,
    "certNumber" TEXT NOT NULL DEFAULT '',
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "nextReviewDue" TIMESTAMP(3),
    "documentId" TEXT,
    "verifiedByUserId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierCertification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierCertification_supplierId_idx" ON "SupplierCertification"("supplierId");
CREATE INDEX "SupplierCertification_certType_idx" ON "SupplierCertification"("certType");
CREATE INDEX "SupplierCertification_expiresAt_idx" ON "SupplierCertification"("expiresAt");
CREATE INDEX "SupplierCertification_nextReviewDue_idx" ON "SupplierCertification"("nextReviewDue");
CREATE INDEX "SupplierCertification_documentId_idx" ON "SupplierCertification"("documentId");
CREATE INDEX "SupplierCertification_verifiedByUserId_idx" ON "SupplierCertification"("verifiedByUserId");

ALTER TABLE "SupplierCertification" ADD CONSTRAINT "SupplierCertification_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierCertification" ADD CONSTRAINT "SupplierCertification_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierCertification" ADD CONSTRAINT "SupplierCertification_verifiedByUserId_fkey"
  FOREIGN KEY ("verifiedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ShipmentDocument" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "docType" "ShipmentDocType" NOT NULL,
    "documentId" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShipmentDocument_shipmentId_idx" ON "ShipmentDocument"("shipmentId");
CREATE INDEX "ShipmentDocument_docType_idx" ON "ShipmentDocument"("docType");
CREATE INDEX "ShipmentDocument_documentId_idx" ON "ShipmentDocument"("documentId");
CREATE INDEX "ShipmentDocument_uploadedByUserId_idx" ON "ShipmentDocument"("uploadedByUserId");

ALTER TABLE "ShipmentDocument" ADD CONSTRAINT "ShipmentDocument_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "ImportShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShipmentDocument" ADD CONSTRAINT "ShipmentDocument_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentDocument" ADD CONSTRAINT "ShipmentDocument_uploadedByUserId_fkey"
  FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
