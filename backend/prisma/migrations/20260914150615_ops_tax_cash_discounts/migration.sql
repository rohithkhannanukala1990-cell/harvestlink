-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'CASH';

-- AlterTable Store
ALTER TABLE "Store" ADD COLUMN "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "Store" ADD COLUMN "tierDiscountStandard" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "Store" ADD COLUMN "tierDiscountPlus" DECIMAL(5,2) NOT NULL DEFAULT 5;
ALTER TABLE "Store" ADD COLUMN "tierDiscountExecutive" DECIMAL(5,2) NOT NULL DEFAULT 10;
ALTER TABLE "Store" ADD COLUMN "refundPolicy" TEXT NOT NULL DEFAULT 'Returns accepted within 14 days with receipt. Refunds to original form of payment.';

-- AlterTable Product
ALTER TABLE "Product" ADD COLUMN "taxExempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable Sale
ALTER TABLE "Sale" ADD COLUMN "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN "cardLast4" TEXT;

-- AlterTable SaleItem
ALTER TABLE "SaleItem" ADD COLUMN "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "SaleItem" ADD COLUMN "discountReason" TEXT;
ALTER TABLE "SaleItem" ADD COLUMN "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "SaleItem" ADD COLUMN "taxExempt" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable CashDrawer
CREATE TABLE "CashDrawer" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "openedByUserId" TEXT NOT NULL,
    "closedByUserId" TEXT,
    "openingFloat" DECIMAL(12,2) NOT NULL,
    "expectedCash" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "countedCash" DECIMAL(12,2),
    "variance" DECIMAL(12,2),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "CashDrawer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CashDrawer_storeId_idx" ON "CashDrawer"("storeId");
CREATE INDEX "CashDrawer_storeId_closedAt_idx" ON "CashDrawer"("storeId", "closedAt");

ALTER TABLE "CashDrawer" ADD CONSTRAINT "CashDrawer_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDrawer" ADD CONSTRAINT "CashDrawer_openedByUserId_fkey" FOREIGN KEY ("openedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDrawer" ADD CONSTRAINT "CashDrawer_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
