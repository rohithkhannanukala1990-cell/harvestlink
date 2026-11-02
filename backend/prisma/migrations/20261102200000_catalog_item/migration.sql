-- Network master SKU (CatalogItem) + optional link from each location Product.

CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "unitsPerCase" INTEGER NOT NULL DEFAULT 1,
    "casesPerPallet" INTEGER,
    "caseWeightKg" DECIMAL(12,3),
    "caseGtin" TEXT,
    "maxShelfPrice" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CatalogItem_sku_key" ON "CatalogItem"("sku");

ALTER TABLE "Product" ADD COLUMN "catalogItemId" TEXT;

CREATE INDEX "Product_catalogItemId_idx" ON "Product"("catalogItemId");

ALTER TABLE "Product" ADD CONSTRAINT "Product_catalogItemId_fkey"
  FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
