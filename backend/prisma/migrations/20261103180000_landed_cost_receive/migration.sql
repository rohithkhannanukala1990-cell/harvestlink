-- Landed-cost fields on receipt lines and lots.
ALTER TABLE "GoodsReceiptLine" ADD COLUMN "landedAddOnPerUnit" DECIMAL(14,4) NOT NULL DEFAULT 0;
ALTER TABLE "GoodsReceiptLine" ADD COLUMN "receivedValue" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "GoodsReceiptLine" ADD COLUMN "shipmentId" TEXT;

CREATE INDEX "GoodsReceiptLine_shipmentId_idx" ON "GoodsReceiptLine"("shipmentId");

ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "ImportShipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Lot" ADD COLUMN "landedAddOnApplied" DECIMAL(14,4) NOT NULL DEFAULT 0;
