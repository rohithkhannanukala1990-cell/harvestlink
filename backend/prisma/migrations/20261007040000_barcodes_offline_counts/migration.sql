-- CreateEnum
CREATE TYPE "BarcodeKind" AS ENUM ('GTIN', 'INTERNAL');

-- AlterTable
ALTER TABLE "Lot" ADD COLUMN     "barcode" TEXT;

-- AlterTable
ALTER TABLE "StockCountLine" ADD COLUMN     "countSubmissionKey" TEXT,
ADD COLUMN     "recountSubmissionKey" TEXT;

-- CreateTable
CREATE TABLE "ProductBarcode" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "BarcodeKind" NOT NULL,
    "label" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductBarcode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductBarcode_productId_idx" ON "ProductBarcode"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductBarcode_storeId_code_key" ON "ProductBarcode"("storeId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_storeId_barcode_key" ON "Lot"("storeId", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countSubmissionKey_key" ON "StockCountLine"("countSubmissionKey");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_recountSubmissionKey_key" ON "StockCountLine"("recountSubmissionKey");

-- AddForeignKey
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
