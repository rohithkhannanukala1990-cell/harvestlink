-- Allow InventoryWriteOff rows that are not tied to a refund (lot expiry),
-- and optionally link a write-off to the lot that left sellable stock.

ALTER TABLE "InventoryWriteOff" ALTER COLUMN "saleId" DROP NOT NULL;
ALTER TABLE "InventoryWriteOff" ALTER COLUMN "saleItemId" DROP NOT NULL;
ALTER TABLE "InventoryWriteOff" ALTER COLUMN "saleRefundId" DROP NOT NULL;

ALTER TABLE "InventoryWriteOff" ADD COLUMN "lotId" TEXT;

CREATE INDEX "InventoryWriteOff_lotId_idx" ON "InventoryWriteOff"("lotId");

ALTER TABLE "InventoryWriteOff" ADD CONSTRAINT "InventoryWriteOff_lotId_fkey"
  FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
