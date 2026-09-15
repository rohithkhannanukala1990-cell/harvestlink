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
      "CapitalContribution",
      "MemberEquityAccount",
      "SaleItem",
      "Sale",
      "StockAdjustment",
      "Payout",
      "CashDrawer",
      "Product",
      "Member",
      "MembershipClass",
      "User",
      "Store"
    RESTART IDENTITY CASCADE
  `);
}

export { prisma };
