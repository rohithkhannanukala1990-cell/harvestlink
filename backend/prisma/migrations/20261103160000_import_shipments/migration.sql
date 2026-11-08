-- PO currency / FX / supplier payment (unitCost stays USD).
ALTER TABLE "PurchaseOrder" ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "PurchaseOrder" ADD COLUMN "fxRateToUsd" DECIMAL(14,6) NOT NULL DEFAULT 1;
ALTER TABLE "PurchaseOrder" ADD COLUMN "paidAmountUsd" DECIMAL(12,2);
ALTER TABLE "PurchaseOrder" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN "paymentReference" TEXT;

ALTER TABLE "PurchaseOrderLine" ADD COLUMN "unitCostForeign" DECIMAL(14,4);

-- Import shipment enums + sequence (IMP-YYYY-NNNN).
CREATE TYPE "ImportShipmentStatus" AS ENUM (
  'PLANNED', 'BOOKED', 'IN_TRANSIT', 'AT_PORT', 'CUSTOMS_HOLD', 'CLEARED',
  'DELIVERED', 'RECEIVED', 'COSTED', 'CLOSED', 'CANCELLED'
);
CREATE TYPE "ShipmentMode" AS ENUM ('SEA_FCL', 'SEA_LCL', 'AIR');
CREATE TYPE "Incoterm" AS ENUM ('FOB', 'CIF', 'CFR', 'EXW', 'DAP');
CREATE TYPE "ShipmentCostType" AS ENUM (
  'OCEAN_FREIGHT', 'AIR_FREIGHT', 'INSURANCE', 'CUSTOMS_DUTY', 'BROKER_FEE',
  'PORT_CHARGES', 'DRAYAGE', 'INLAND_FREIGHT', 'FDA_EXAM', 'STORAGE_DEMURRAGE',
  'FX_DIFFERENCE', 'OTHER'
);
CREATE TYPE "CostAllocationBasis" AS ENUM ('VALUE', 'WEIGHT', 'VOLUME', 'QUANTITY', 'LINE_SPECIFIC');
CREATE TYPE "ShipmentCostStatus" AS ENUM ('ESTIMATED', 'FINAL');

CREATE SEQUENCE IF NOT EXISTS "import_shipment_number_seq" START 1;

CREATE TABLE "ImportShipment" (
    "id" TEXT NOT NULL,
    "shipmentNumber" TEXT NOT NULL,
    "status" "ImportShipmentStatus" NOT NULL DEFAULT 'PLANNED',
    "mode" "ShipmentMode" NOT NULL,
    "incoterm" "Incoterm" NOT NULL,
    "originPort" TEXT NOT NULL DEFAULT '',
    "destinationPort" TEXT NOT NULL DEFAULT 'USHOU',
    "carrier" TEXT NOT NULL DEFAULT '',
    "vesselVoyage" TEXT NOT NULL DEFAULT '',
    "containerNumber" TEXT,
    "billOfLadingNumber" TEXT,
    "customsEntryNumber" TEXT,
    "etd" TIMESTAMP(3),
    "eta" TIMESTAMP(3),
    "actualDeparture" TIMESTAMP(3),
    "actualArrival" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "destinationStoreId" TEXT NOT NULL,
    "holdReason" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportShipment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImportShipment_shipmentNumber_key" ON "ImportShipment"("shipmentNumber");
CREATE INDEX "ImportShipment_status_idx" ON "ImportShipment"("status");
CREATE INDEX "ImportShipment_destinationStoreId_idx" ON "ImportShipment"("destinationStoreId");
CREATE INDEX "ImportShipment_createdByUserId_idx" ON "ImportShipment"("createdByUserId");
CREATE INDEX "ImportShipment_eta_idx" ON "ImportShipment"("eta");
CREATE INDEX "ImportShipment_createdAt_idx" ON "ImportShipment"("createdAt");

ALTER TABLE "ImportShipment" ADD CONSTRAINT "ImportShipment_destinationStoreId_fkey"
  FOREIGN KEY ("destinationStoreId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportShipment" ADD CONSTRAINT "ImportShipment_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ImportShipmentPurchaseOrder" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportShipmentPurchaseOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImportShipmentPurchaseOrder_shipmentId_poId_key"
  ON "ImportShipmentPurchaseOrder"("shipmentId", "poId");
CREATE INDEX "ImportShipmentPurchaseOrder_poId_idx" ON "ImportShipmentPurchaseOrder"("poId");
CREATE INDEX "ImportShipmentPurchaseOrder_shipmentId_idx" ON "ImportShipmentPurchaseOrder"("shipmentId");

ALTER TABLE "ImportShipmentPurchaseOrder" ADD CONSTRAINT "ImportShipmentPurchaseOrder_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "ImportShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportShipmentPurchaseOrder" ADD CONSTRAINT "ImportShipmentPurchaseOrder_poId_fkey"
  FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ImportShipmentLine" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "poLineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "grossWeightKg" DECIMAL(12,3),
    "volumeCbm" DECIMAL(12,4),
    "htsCode" TEXT,
    "dutyRatePercent" DECIMAL(8,4),
    "customsValueUsd" DECIMAL(12,2) NOT NULL,
    "dutyAmountUsd" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportShipmentLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImportShipmentLine_shipmentId_poLineId_key"
  ON "ImportShipmentLine"("shipmentId", "poLineId");
CREATE INDEX "ImportShipmentLine_shipmentId_idx" ON "ImportShipmentLine"("shipmentId");
CREATE INDEX "ImportShipmentLine_poLineId_idx" ON "ImportShipmentLine"("poLineId");

ALTER TABLE "ImportShipmentLine" ADD CONSTRAINT "ImportShipmentLine_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "ImportShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportShipmentLine" ADD CONSTRAINT "ImportShipmentLine_poLineId_fkey"
  FOREIGN KEY ("poLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ShipmentCost" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "costType" "ShipmentCostType" NOT NULL,
    "vendorName" TEXT NOT NULL DEFAULT '',
    "invoiceNumber" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "amountForeign" DECIMAL(14,4) NOT NULL,
    "fxRateToUsd" DECIMAL(14,6) NOT NULL DEFAULT 1,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "allocationBasis" "CostAllocationBasis" NOT NULL DEFAULT 'VALUE',
    "status" "ShipmentCostStatus" NOT NULL DEFAULT 'ESTIMATED',
    "supersedesCostId" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidAmountUsd" DECIMAL(12,2),
    "paymentReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipmentCost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShipmentCost_supersedesCostId_key" ON "ShipmentCost"("supersedesCostId");
CREATE INDEX "ShipmentCost_shipmentId_idx" ON "ShipmentCost"("shipmentId");
CREATE INDEX "ShipmentCost_costType_idx" ON "ShipmentCost"("costType");
CREATE INDEX "ShipmentCost_status_idx" ON "ShipmentCost"("status");

ALTER TABLE "ShipmentCost" ADD CONSTRAINT "ShipmentCost_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "ImportShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShipmentCost" ADD CONSTRAINT "ShipmentCost_supersedesCostId_fkey"
  FOREIGN KEY ("supersedesCostId") REFERENCES "ShipmentCost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ShipmentEvent" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "payload" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShipmentEvent_shipmentId_createdAt_idx" ON "ShipmentEvent"("shipmentId", "createdAt");
CREATE INDEX "ShipmentEvent_createdByUserId_idx" ON "ShipmentEvent"("createdByUserId");

ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "ImportShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
