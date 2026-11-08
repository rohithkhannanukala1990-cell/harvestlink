-- Registered (OH) vs operating (TX) co-op location fields.
ALTER TABLE "CooperativeSettings" ADD COLUMN "operatingState" TEXT NOT NULL DEFAULT '';
ALTER TABLE "CooperativeSettings" ADD COLUMN "principalOfficeAddress" TEXT NOT NULL DEFAULT '';

-- Lot-level before/after on StockAdjustment (rollup previousStock/newStock stay product-level).
ALTER TABLE "StockAdjustment" ADD COLUMN "lotPreviousQty" INTEGER;
ALTER TABLE "StockAdjustment" ADD COLUMN "lotNewQty" INTEGER;

-- Per-lot refund restock trail.
CREATE TABLE "RefundRestockLot" (
    "id" TEXT NOT NULL,
    "saleRefundId" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCostSnapshot" DECIMAL(14,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundRestockLot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RefundRestockLot_lotId_idx" ON "RefundRestockLot"("lotId");
CREATE INDEX "RefundRestockLot_saleRefundId_idx" ON "RefundRestockLot"("saleRefundId");

ALTER TABLE "RefundRestockLot" ADD CONSTRAINT "RefundRestockLot_saleRefundId_fkey"
  FOREIGN KEY ("saleRefundId") REFERENCES "SaleRefund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefundRestockLot" ADD CONSTRAINT "RefundRestockLot_saleItemId_fkey"
  FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundRestockLot" ADD CONSTRAINT "RefundRestockLot_lotId_fkey"
  FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
