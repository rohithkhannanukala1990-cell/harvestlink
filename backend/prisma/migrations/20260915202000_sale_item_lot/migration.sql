-- SaleItemLot: FEFO lot allocations per sale line, with frozen unit cost.

CREATE TABLE "SaleItemLot" (
    "id" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCostSnapshot" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "SaleItemLot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SaleItemLot_saleItemId_idx" ON "SaleItemLot"("saleItemId");
CREATE INDEX "SaleItemLot_lotId_idx" ON "SaleItemLot"("lotId");

ALTER TABLE "SaleItemLot" ADD CONSTRAINT "SaleItemLot_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SaleItemLot" ADD CONSTRAINT "SaleItemLot_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;