-- Widen unit-cost columns to NUMERIC(14,4). Type widening only — existing values keep.
-- Totals (lineTotal, value, caseCost, money fields) stay NUMERIC(12,2).

ALTER TABLE "Product" ALTER COLUMN "cost" TYPE DECIMAL(14,4);

ALTER TABLE "SaleItemLot" ALTER COLUMN "unitCostSnapshot" TYPE DECIMAL(14,4);

ALTER TABLE "InventoryWriteOff" ALTER COLUMN "unitCost" TYPE DECIMAL(14,4);

ALTER TABLE "SupplierProduct" ALTER COLUMN "unitCost" TYPE DECIMAL(14,4);

ALTER TABLE "PurchaseOrderLine" ALTER COLUMN "unitCost" TYPE DECIMAL(14,4);

ALTER TABLE "GoodsReceiptLine" ALTER COLUMN "unitCostActual" TYPE DECIMAL(14,4);

ALTER TABLE "Lot" ALTER COLUMN "unitCost" TYPE DECIMAL(14,4);
