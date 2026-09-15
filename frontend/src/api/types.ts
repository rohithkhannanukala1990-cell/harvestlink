/**
 * Typed shapes mirrored from the Harvestlink backend API responses.
 */
export type Role = "CASHIER" | "STORE_ADMIN" | "COOP_ADMIN";
export type MemberTier = "STANDARD" | "PLUS" | "EXECUTIVE";
export type PaymentMethod = "CHECKOUT" | "TERMINAL" | "CASH";
export type PaymentStatus = "PENDING" | "PAID" | "FAILED" | "REFUNDED" | "EXPIRED" | "REFUNDING";

export type AuthUser = {
  id: string;
  email: string;
  storeId: string | null;
  role: Role;
  mustChangePassword?: boolean;
};

export type Product = {
  id: string;
  storeId: string;
  sku: string;
  name: string;
  category: string;
  price: string | number;
  cost: string | number;
  /** Physical on-hand units. */
  stock: number;
  /** Units held by unpaid PENDING sales. */
  reserved?: number;
  /** Sellable = stock - reserved (prefer this in POS). */
  available?: number;
  reorderAt: number;
  taxExempt?: boolean;
  lowStock?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Member = {
  id: string;
  memberNumber: string;
  name: string;
  email: string;
  tier: MemberTier;
  joinedAt: string;
  expiresAt: string;
};

export type Sale = {
  id: string;
  storeId: string;
  cashierId: string;
  memberId: string | null;
  subtotal: string | number;
  discountAmount?: string | number;
  taxAmount?: string | number;
  total: string | number;
  operatorPercent: string | number;
  operatorAmount: string | number;
  coopAmount: string | number;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  cardLast4?: string | null;
  createdAt: string;
  paidAt: string | null;
  items: SaleItem[];
};

export type SaleItem = {
  id: string;
  productId: string;
  skuSnapshot: string;
  nameSnapshot: string;
  priceSnapshot: string | number;
  quantity: number;
  discountAmount?: string | number;
  taxAmount?: string | number;
  taxExempt?: boolean;
};

export type SettlementSummary = {
  storeId: string;
  storeName: string;
  grossSales: string;
  operatorAccrued: string;
  totalPaidOut: string;
  currentlyOwed: string;
};

export type Payout = {
  id: string;
  storeId: string;
  amount: string | number;
  note: string | null;
  paidByUserId: string;
  createdAt: string;
};

export type Store = {
  id: string;
  name: string;
  address: string;
  operatorPercent: string | number;
  taxRate?: string | number;
  tierDiscountStandard?: string | number;
  tierDiscountPlus?: string | number;
  tierDiscountExecutive?: string | number;
  refundPolicy?: string;
  createdAt: string;
  isActive: boolean;
  todaysSales?: string;
  stockAlertCount?: number;
  currentlyOwed?: string;
};

export type CashDrawer = {
  id: string;
  storeId: string;
  openingFloat: string | number;
  expectedCash: string | number;
  countedCash: string | number | null;
  variance: string | number | null;
  openedAt: string;
  closedAt: string | null;
};

export type DailyCloseReport = {
  storeId: string;
  storeName: string;
  date: string;
  salesByPaymentMethod: Record<string, string>;
  taxCollected: string;
  refundsTotal: string;
  operatorShareAccrued: string;
  cashVariance: string | null;
  cashierBreakdown: Array<{
    cashierId: string;
    email: string;
    saleCount: number;
    grossSales: string;
    operatorShare: string;
  }>;
};

export type AuditLogEntry = {
  id: string;
  userId: string | null;
  storeId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  createdAt: string;
};
