-- Catalog backfill disagreements live in the DB so API hosts share them with the backfill job.
CREATE TYPE "CatalogDisagreementField" AS ENUM ('name', 'category', 'taxExempt');

CREATE TABLE "CatalogDisagreement" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "field" "CatalogDisagreementField" NOT NULL,
    "values" JSONB NOT NULL,
    "chosenValue" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogDisagreement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogDisagreement_resolvedAt_idx" ON "CatalogDisagreement"("resolvedAt");

CREATE INDEX "CatalogDisagreement_sku_field_idx" ON "CatalogDisagreement"("sku", "field");

-- At most one unresolved disagreement per sku+field (re-backfill updates that row).
CREATE UNIQUE INDEX "CatalogDisagreement_sku_field_open_key"
  ON "CatalogDisagreement"("sku", "field")
  WHERE "resolvedAt" IS NULL;

ALTER TABLE "CatalogDisagreement"
  ADD CONSTRAINT "CatalogDisagreement_resolvedByUserId_fkey"
  FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
