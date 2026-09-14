/**
 * Typed shapes mirrored from the Harvestlink backend API responses.
 */
export type Role = "CASHIER" | "STORE_ADMIN" | "COOP_ADMIN";
export type MemberTier = "STANDARD" | "PLUS" | "EXECUTIVE";
export type PaymentMethod = "CHECKOUT" | "TERMINAL";
export type PaymentStatus = "PENDING" | "PAID" | "FAILED" | "REFUNDED";

export type AuthUser = {
  id: string;
  email: string;
  storeId: string | null;
  role: Role;
};

export type Product = {
  id: string;
  storeId: string;
  sku: string;
  name: string;
  category: string;
  price: string | number;
  cost: string | number;
  stock: number;
  reorderAt: number;
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

export type SaleItem = {
  id: string;
  productId: string;
  skuSnapshot: string;
  nameSnapshot: string;
  priceSnapshot: string | number;
  quantity: number;
};

export type Sale = {
  id: string;
  storeId: string;
  cashierId: string;
  memberId: string | null;
  subtotal: string | number;
  total: string | number;
  operatorPercent: string | number;
  operatorAmount: string | number;
  coopAmount: string | number;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  createdAt: string;
  paidAt: string | null;
  items: SaleItem[];
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
  createdAt: string;
  isActive: boolean;
  /** Present on GET /stores — PAID sales total since UTC midnight. */
  todaysSales?: string;
  /** Present on GET /stores — products with stock <= reorderAt. */
  stockAlertCount?: number;
  /** Present on GET /stores — settlement currentlyOwed. */
  currentlyOwed?: string;
};
