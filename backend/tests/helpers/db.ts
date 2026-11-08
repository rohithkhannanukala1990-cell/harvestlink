/**
 * Database helpers for Vitest — truncate between tests for isolation.
 */
import { prisma } from "../../src/lib/prisma.js";

/**
 * Every Prisma model table must appear here (see tests/harness.test.ts).
 * Order does not matter — CASCADE clears FKs.
 */
export const TRUNCATE_TABLES = [
  "AuditLog",
  "ProcessedStripeEvent",
  "InventoryWriteOff",
  "SaleRefundLine",
  "SaleRefund",
  "StockReconciliation",
  "SourcingOrigin",
  "GoodsReceiptLine",
  "GoodsReceipt",
  "ShipmentEvent",
  "ShipmentCost",
  "ImportShipmentLine",
  "ImportShipmentPurchaseOrder",
  "ShipmentDocument",
  "LandedCostVariance",
  "ImportShipment",
  "SupplierCertification",
  "Document",
  "PurchaseOrderLine",
  "PurchaseOrder",
  "SupplierProduct",
  "FpoProfile",
  "Supplier",
  "MemberVote",
  "BallotOption",
  "Ballot",
  "DividendAllocation",
  "Dividend",
  "BoardResolution",
  "MemberBenefitUsage",
  "MemberBenefit",
  "CapitalInvestment",
  "MembershipFee",
  "MemberEquityAccount",
  "RecallNotification",
  "RecallLot",
  "Recall",
  "RefundRestockLot",
  "SaleItemLot",
  "SaleItem",
  "Sale",
  "StockAdjustment",
  "Payout",
  "CashDepositDrawer",
  "CashDeposit",
  "CashDrawer",
  "StockCountLine",
  "StockCount",
  "Lot",
  "ProductBarcode",
  "Product",
  "CatalogDisagreement",
  "CatalogItem",
  "Member",
  "CooperativeSettings",
  "User",
  "Store",
] as const;

export async function truncateAll(): Promise<void> {
  const list = TRUNCATE_TABLES.map((t) => `"${t}"`).join(",\n      ");
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      ${list}
    RESTART IDENTITY CASCADE
  `);
}

export { prisma };
