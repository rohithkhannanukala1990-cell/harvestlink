-- Snapshot member-benefit fields on Sale / SaleItem so later benefit edits never rewrite history.

-- Sale snapshots
ALTER TABLE "Sale" ADD COLUMN "membershipClassId" TEXT;
ALTER TABLE "Sale" ADD COLUMN "subtotalBeforeDiscount" DECIMAL(12,2);
ALTER TABLE "Sale" ADD COLUMN "memberDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN "memberDiscountBearer" "DiscountBearer" NOT NULL DEFAULT 'COOP';

-- Backfill existing rows: pre-discount = net subtotal + total discounts; no benefit yet.
UPDATE "Sale"
SET
  "subtotalBeforeDiscount" = "subtotal" + "discountAmount",
  "memberDiscountAmount" = 0,
  "memberDiscountBearer" = 'COOP'
WHERE "subtotalBeforeDiscount" IS NULL;

ALTER TABLE "Sale" ALTER COLUMN "subtotalBeforeDiscount" SET NOT NULL;

CREATE INDEX "Sale_membershipClassId_idx" ON "Sale"("membershipClassId");

ALTER TABLE "Sale"
  ADD CONSTRAINT "Sale_membershipClassId_fkey"
  FOREIGN KEY ("membershipClassId") REFERENCES "MembershipClass"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- SaleItem benefit snapshots
ALTER TABLE "SaleItem" ADD COLUMN "benefitId" TEXT;
ALTER TABLE "SaleItem" ADD COLUMN "benefitDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE INDEX "SaleItem_benefitId_idx" ON "SaleItem"("benefitId");

ALTER TABLE "SaleItem"
  ADD CONSTRAINT "SaleItem_benefitId_fkey"
  FOREIGN KEY ("benefitId") REFERENCES "MemberBenefit"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
