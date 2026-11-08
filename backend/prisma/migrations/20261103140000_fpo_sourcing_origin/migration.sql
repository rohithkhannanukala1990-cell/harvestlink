-- Supplier classification + country.
CREATE TYPE "SupplierType" AS ENUM ('FPO', 'EXPORTER', 'DOMESTIC_DISTRIBUTOR', 'DOMESTIC_VENDOR', 'OTHER');
CREATE TYPE "FpoLegalForm" AS ENUM ('PRODUCER_COMPANY', 'COOPERATIVE_SOCIETY', 'OTHER');
CREATE TYPE "OrganicStatus" AS ENUM ('CONVENTIONAL', 'IN_CONVERSION', 'CERTIFIED_ORGANIC');

ALTER TABLE "Supplier" ADD COLUMN "supplierType" "SupplierType" NOT NULL DEFAULT 'DOMESTIC_VENDOR';
ALTER TABLE "Supplier" ADD COLUMN "country" TEXT NOT NULL DEFAULT 'US';
CREATE INDEX "Supplier_supplierType_idx" ON "Supplier"("supplierType");

CREATE TABLE "FpoProfile" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "legalForm" "FpoLegalForm" NOT NULL DEFAULT 'OTHER',
    "registrationNumber" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "district" TEXT NOT NULL DEFAULT '',
    "block" TEXT,
    "memberFarmerCount" INTEGER NOT NULL DEFAULT 0,
    "memberFarmerCountAsOf" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "womenFarmerCount" INTEGER,
    "primaryCrops" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exportsViaSupplierId" TEXT,
    "onboardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FpoProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FpoProfile_supplierId_key" ON "FpoProfile"("supplierId");
CREATE INDEX "FpoProfile_exportsViaSupplierId_idx" ON "FpoProfile"("exportsViaSupplierId");
CREATE INDEX "FpoProfile_state_idx" ON "FpoProfile"("state");

ALTER TABLE "FpoProfile" ADD CONSTRAINT "FpoProfile_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FpoProfile" ADD CONSTRAINT "FpoProfile_exportsViaSupplierId_fkey"
  FOREIGN KEY ("exportsViaSupplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SourcingOrigin" (
    "id" TEXT NOT NULL,
    "goodsReceiptLineId" TEXT NOT NULL,
    "fpoSupplierId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "village" TEXT,
    "crop" TEXT NOT NULL,
    "variety" TEXT,
    "harvestSeason" TEXT,
    "harvestDate" TIMESTAMP(3),
    "contributingFarmerCount" INTEGER,
    "organicStatus" "OrganicStatus" NOT NULL DEFAULT 'CONVENTIONAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourcingOrigin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SourcingOrigin_goodsReceiptLineId_key" ON "SourcingOrigin"("goodsReceiptLineId");
CREATE INDEX "SourcingOrigin_fpoSupplierId_idx" ON "SourcingOrigin"("fpoSupplierId");
CREATE INDEX "SourcingOrigin_state_district_idx" ON "SourcingOrigin"("state", "district");
CREATE INDEX "SourcingOrigin_crop_idx" ON "SourcingOrigin"("crop");

ALTER TABLE "SourcingOrigin" ADD CONSTRAINT "SourcingOrigin_goodsReceiptLineId_fkey"
  FOREIGN KEY ("goodsReceiptLineId") REFERENCES "GoodsReceiptLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourcingOrigin" ADD CONSTRAINT "SourcingOrigin_fpoSupplierId_fkey"
  FOREIGN KEY ("fpoSupplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
