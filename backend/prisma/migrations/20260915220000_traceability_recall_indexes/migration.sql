-- Traceability / recall query indexes.
-- Forward recall walks SaleItemLot(lotId) → SaleItem → Sale → Member; these keep that path in seconds.

CREATE INDEX "Sale_storeId_paymentStatus_idx" ON "Sale"("storeId", "paymentStatus");

CREATE INDEX "SaleItemLot_lotId_saleItemId_idx" ON "SaleItemLot"("lotId", "saleItemId");
