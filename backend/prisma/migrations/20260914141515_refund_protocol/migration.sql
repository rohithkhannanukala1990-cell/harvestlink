-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUNDING';

-- CreateEnum
CREATE TYPE "SaleRefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- AlterTable Sale
ALTER TABLE "Sale" ADD COLUMN "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN "refundedOperatorAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN "pendingRefundId" TEXT;

-- AlterTable SaleItem
ALTER TABLE "SaleItem" ADD COLUMN "refundedQuantity" INTEGER NOT NULL DEFAULT 0;

-- CreateTable SaleRefund
CREATE TABLE "SaleRefund" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "operatorAmount" DECIMAL(12,2) NOT NULL,
    "restock" BOOLEAN NOT NULL DEFAULT true,
    "status" "SaleRefundStatus" NOT NULL DEFAULT 'PENDING',
    "stripeRefundId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SaleRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable SaleRefundLine
CREATE TABLE "SaleRefundLine" (
    "id" TEXT NOT NULL,
    "saleRefundId" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "SaleRefundLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable InventoryWriteOff
CREATE TABLE "InventoryWriteOff" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "saleRefundId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryWriteOff_pkey" PRIMARY KEY ("id")
);

-- Indexes / FKs
CREATE UNIQUE INDEX "SaleRefund_stripeRefundId_key" ON "SaleRefund"("stripeRefundId");
CREATE INDEX "SaleRefund_saleId_idx" ON "SaleRefund"("saleId");
CREATE INDEX "SaleRefund_status_idx" ON "SaleRefund"("status");
CREATE INDEX "SaleRefundLine_saleRefundId_idx" ON "SaleRefundLine"("saleRefundId");
CREATE INDEX "SaleRefundLine_saleItemId_idx" ON "SaleRefundLine"("saleItemId");
CREATE INDEX "InventoryWriteOff_storeId_idx" ON "InventoryWriteOff"("storeId");
CREATE INDEX "InventoryWriteOff_productId_idx" ON "InventoryWriteOff"("productId");
CREATE INDEX "InventoryWriteOff_saleRefundId_idx" ON "InventoryWriteOff"("saleRefundId");

ALTER TABLE "SaleRefund" ADD CONSTRAINT "SaleRefund_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SaleRefundLine" ADD CONSTRAINT "SaleRefundLine_saleRefundId_fkey" FOREIGN KEY ("saleRefundId") REFERENCES "SaleRefund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SaleRefundLine" ADD CONSTRAINT "SaleRefundLine_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryWriteOff" ADD CONSTRAINT "InventoryWriteOff_saleRefundId_fkey" FOREIGN KEY ("saleRefundId") REFERENCES "SaleRefund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
