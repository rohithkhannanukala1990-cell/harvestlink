-- AlterTable
ALTER TABLE "Product" ADD COLUMN "reserved" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN "reservationExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Sale_reservationExpiresAt_idx" ON "Sale"("reservationExpiresAt");
