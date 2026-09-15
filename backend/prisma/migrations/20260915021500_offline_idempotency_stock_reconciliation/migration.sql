-- Offline POS: idempotent sale replay + stock reconciliation queue when sync drives stock negative.

ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Sale_idempotencyKey_key" ON "Sale"("idempotencyKey");

CREATE TABLE IF NOT EXISTS "StockReconciliation" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantitySold" INTEGER NOT NULL,
    "stockBefore" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StockReconciliation_storeId_idx" ON "StockReconciliation"("storeId");
CREATE INDEX IF NOT EXISTS "StockReconciliation_storeId_resolvedAt_idx" ON "StockReconciliation"("storeId", "resolvedAt");
CREATE INDEX IF NOT EXISTS "StockReconciliation_saleId_idx" ON "StockReconciliation"("saleId");
CREATE INDEX IF NOT EXISTS "StockReconciliation_productId_idx" ON "StockReconciliation"("productId");

DO $$ BEGIN
  ALTER TABLE "StockReconciliation" ADD CONSTRAINT "StockReconciliation_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "StockReconciliation" ADD CONSTRAINT "StockReconciliation_saleId_fkey"
    FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "StockReconciliation" ADD CONSTRAINT "StockReconciliation_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
