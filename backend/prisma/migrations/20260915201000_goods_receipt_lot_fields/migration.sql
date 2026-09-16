-- Goods receipt lines carry optional lot metadata; StockAdjustment can reference a Lot.

ALTER TABLE "StockAdjustment" ADD COLUMN "lotId" TEXT;
CREATE INDEX "StockAdjustment_lotId_idx" ON "StockAdjustment"("lotId");
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GoodsReceiptLine" ADD COLUMN "lotNumber" TEXT;
ALTER TABLE "GoodsReceiptLine" ADD COLUMN "expiryDate" TIMESTAMP(3);
ALTER TABLE "GoodsReceiptLine" ADD COLUMN "harvestDate" TIMESTAMP(3);
ALTER TABLE "GoodsReceiptLine" ADD COLUMN "countryOfOrigin" TEXT;