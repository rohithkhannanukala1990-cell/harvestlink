/**
 * Database helpers for Vitest — truncate between tests for isolation.
 */
import { prisma } from "../../src/lib/prisma.js";

export async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog",
      "ProcessedStripeEvent",
      "InventoryWriteOff",
      "SaleRefundLine",
      "SaleRefund",
      "StockReconciliation",
      "GoodsReceiptLine",
      "GoodsReceipt",
      "PurchaseOrderLine",
      "PurchaseOrder",
      "SupplierProduct",
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
      "SaleItemLot",
      "SaleItem",
      "Sale",
      "StockAdjustment",
      "Payout",
      "CashDrawer",
      "Lot",
      "Product",
      "Member",
      "CooperativeSettings",
      "User",
      "Store"
    RESTART IDENTITY CASCADE
  `);
}

export { prisma };
