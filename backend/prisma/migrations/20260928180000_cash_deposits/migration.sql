-- CreateEnum
CREATE TYPE "CashDepositStatus" AS ENUM ('RECORDED', 'CONFIRMED', 'DISPUTED');

-- CreateTable
CREATE TABLE "CashDeposit" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "depositedByUserId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "depositedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bankReference" TEXT,
    "depositSlipUrl" TEXT,
    "status" "CashDepositStatus" NOT NULL DEFAULT 'RECORDED',
    "confirmedAmount" DECIMAL(12,2),
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "disputedByUserId" TEXT,
    "disputedAt" TIMESTAMP(3),
    "disputeReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashDepositDrawer" (
    "depositId" TEXT NOT NULL,
    "cashDrawerId" TEXT NOT NULL,

    CONSTRAINT "CashDepositDrawer_pkey" PRIMARY KEY ("depositId","cashDrawerId")
);

-- CreateIndex
CREATE INDEX "CashDeposit_storeId_status_idx" ON "CashDeposit"("storeId", "status");

-- CreateIndex
CREATE INDEX "CashDeposit_depositedAt_idx" ON "CashDeposit"("depositedAt");

-- CreateIndex
CREATE INDEX "CashDepositDrawer_cashDrawerId_idx" ON "CashDepositDrawer"("cashDrawerId");

-- AddForeignKey
ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_depositedByUserId_fkey" FOREIGN KEY ("depositedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_disputedByUserId_fkey" FOREIGN KEY ("disputedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashDepositDrawer" ADD CONSTRAINT "CashDepositDrawer_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "CashDeposit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashDepositDrawer" ADD CONSTRAINT "CashDepositDrawer_cashDrawerId_fkey" FOREIGN KEY ("cashDrawerId") REFERENCES "CashDrawer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
