-- Snapshot the pre-tax operator base used at sale time for correct refund proration.

ALTER TABLE "Sale" ADD COLUMN "operatorBaseSnapshot" DECIMAL(12,2);

-- Pre-migration sales were all computed from post-discount subtotal.
UPDATE "Sale"
SET "operatorBaseSnapshot" = "subtotal"
WHERE "operatorBaseSnapshot" IS NULL;
