-- AlterTable: rename the recount thresholds (values preserved) and add cycle-count scheduling settings
ALTER TABLE "CooperativeSettings" RENAME COLUMN "stockCountRecountPercent" TO "varianceThresholdPercent";
ALTER TABLE "CooperativeSettings" RENAME COLUMN "stockCountRecountValue" TO "varianceThresholdValue";
ALTER TABLE "CooperativeSettings" ADD COLUMN     "cycleCountEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "cycleCountFrequencyDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "highValueThreshold" DECIMAL(12,2) NOT NULL DEFAULT 500;

-- AlterTable: scheduler-created counts have no human creator
ALTER TABLE "StockCount" ALTER COLUMN "createdByUserId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countId_lotId_key" ON "StockCountLine"("countId", "lotId");
