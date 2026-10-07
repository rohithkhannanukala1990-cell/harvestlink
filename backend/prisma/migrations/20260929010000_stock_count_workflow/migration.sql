-- AlterTable
ALTER TABLE "CooperativeSettings" ADD COLUMN     "cycleCountSize" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "stockCountRecountPercent" DECIMAL(5,2) NOT NULL DEFAULT 10,
ADD COLUMN     "stockCountRecountValue" DECIMAL(12,2) NOT NULL DEFAULT 25;

-- AlterTable
ALTER TABLE "InventoryWriteOff" ADD COLUMN     "unitCost" DECIMAL(12,2),
ADD COLUMN     "value" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "StockCount" ADD COLUMN     "approvedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "StockCountLine" ADD COLUMN     "countedAt" TIMESTAMP(3),
ADD COLUMN     "countedByUserId" TEXT,
ADD COLUMN     "movementDuringCount" INTEGER,
ADD COLUMN     "recountedAt" TIMESTAMP(3),
ADD COLUMN     "recountedByUserId" TEXT;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countedByUserId_fkey" FOREIGN KEY ("countedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_recountedByUserId_fkey" FOREIGN KEY ("recountedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
