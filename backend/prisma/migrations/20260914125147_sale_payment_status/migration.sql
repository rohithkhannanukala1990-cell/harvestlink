-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('TERMINAL', 'CHECKOUT');

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Sale" ADD COLUMN "paymentMethod" "PaymentMethod";
ALTER TABLE "Sale" ADD COLUMN "stripePaymentIntentId" TEXT;
ALTER TABLE "Sale" ADD COLUMN "stripeCheckoutSessionId" TEXT;
ALTER TABLE "Sale" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "Sale" ADD COLUMN "refundedAt" TIMESTAMP(3);

-- Existing rows were already stock-finalized before Stripe; treat them as PAID.
UPDATE "Sale" SET "paymentStatus" = 'PAID', "paidAt" = "createdAt" WHERE "paymentStatus" = 'PENDING';

-- CreateIndex
CREATE UNIQUE INDEX "Sale_stripePaymentIntentId_key" ON "Sale"("stripePaymentIntentId");
CREATE UNIQUE INDEX "Sale_stripeCheckoutSessionId_key" ON "Sale"("stripeCheckoutSessionId");
CREATE INDEX "Sale_paymentStatus_idx" ON "Sale"("paymentStatus");
