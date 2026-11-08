CREATE TYPE "LandedCostVarianceReason" AS ENUM ('TRUE_UP', 'RESTOCK_REVERSAL');

CREATE TABLE "LandedCostVariance" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT,
    "lotId" TEXT NOT NULL,
    "deltaPerUnit" DECIMAL(14,4) NOT NULL,
    "units" INTEGER NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "recognisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT NOT NULL,
    "reason" "LandedCostVarianceReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LandedCostVariance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LandedCostVariance_shipmentId_idx" ON "LandedCostVariance"("shipmentId");
CREATE INDEX "LandedCostVariance_lotId_idx" ON "LandedCostVariance"("lotId");
CREATE INDEX "LandedCostVariance_recognisedAt_idx" ON "LandedCostVariance"("recognisedAt");
CREATE INDEX "LandedCostVariance_createdByUserId_idx" ON "LandedCostVariance"("createdByUserId");
CREATE INDEX "LandedCostVariance_reason_idx" ON "LandedCostVariance"("reason");

ALTER TABLE "LandedCostVariance" ADD CONSTRAINT "LandedCostVariance_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "ImportShipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LandedCostVariance" ADD CONSTRAINT "LandedCostVariance_lotId_fkey"
  FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LandedCostVariance" ADD CONSTRAINT "LandedCostVariance_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
