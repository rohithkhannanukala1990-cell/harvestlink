-- Stock-holding locations: retail store or warehouse (same Store model / storeId).
CREATE TYPE "LocationType" AS ENUM ('RETAIL_STORE', 'WAREHOUSE');

ALTER TABLE "Store" ADD COLUMN "locationType" "LocationType" NOT NULL DEFAULT 'RETAIL_STORE';

ALTER TABLE "CooperativeSettings" ADD COLUMN "mainWarehouseId" TEXT;

ALTER TABLE "CooperativeSettings" ADD CONSTRAINT "CooperativeSettings_mainWarehouseId_fkey"
  FOREIGN KEY ("mainWarehouseId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
