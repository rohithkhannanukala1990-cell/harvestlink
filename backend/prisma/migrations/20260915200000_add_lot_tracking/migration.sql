-- Lot tracking: inventory batches with FEFO indexes and lot-level unitCost.
-- Available to sell = quantityRemaining - quantityReserved, and ONLY when status = ACTIVE.

CREATE TYPE "LotStatus" AS ENUM ('ACTIVE', 'QUARANTINED', 'RECALLED', 'EXPIRED', 'DEPLETED');

CREATE TABLE "Lot" (
    "id" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "supplierId" TEXT,
    "goodsReceiptLineId" TEXT,
    "harvestDate" TIMESTAMP(3),
    "packDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "quantityReceived" INTEGER NOT NULL,
    "quantityRemaining" INTEGER NOT NULL,
    "quantityReserved" INTEGER NOT NULL DEFAULT 0,
    "status" "LotStatus" NOT NULL DEFAULT 'ACTIVE',
    "countryOfOrigin" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Lot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Lot_productId_status_expiryDate_idx" ON "Lot"("productId", "status", "expiryDate");
CREATE INDEX "Lot_status_idx" ON "Lot"("status");
CREATE INDEX "Lot_expiryDate_idx" ON "Lot"("expiryDate");
CREATE INDEX "Lot_storeId_idx" ON "Lot"("storeId");
CREATE INDEX "Lot_supplierId_idx" ON "Lot"("supplierId");
CREATE INDEX "Lot_goodsReceiptLineId_idx" ON "Lot"("goodsReceiptLineId");
CREATE UNIQUE INDEX "Lot_productId_lotNumber_storeId_key" ON "Lot"("productId", "lotNumber", "storeId");

ALTER TABLE "Lot" ADD CONSTRAINT "Lot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_goodsReceiptLineId_fkey" FOREIGN KEY ("goodsReceiptLineId") REFERENCES "GoodsReceiptLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;