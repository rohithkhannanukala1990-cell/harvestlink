/**
 * Typed shapes mirrored from the Harvestlink backend API responses.
 */
export type Role = "CASHIER" | "STORE_ADMIN" | "COOP_ADMIN";
export type MemberStatus =
  | "PENDING"
  | "ACTIVE"
  | "WITHDRAWN"
  | "SUSPENDED"
  | "DECEASED"
  | "TRANSFERRED";
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

/** Co-op-wide settings (singleton). Voting threshold lives here — never hardcoded. */
export type CooperativeSettings = {
  id: string;
  votingThresholdAmount: string | number;
  fiscalYearEnd: string;
  legalEntityName: string;
  stateOfIncorporation: string;
  createdAt: string;
  updatedAt: string;
};

export type Member = {
  id: string;
  memberNumber: string;
  name: string;
  email: string;
  phone?: string;
  mailingAddress?: string;
  status: MemberStatus;
  joinedAt: string;
  approvedAt?: string | null;
  isEligibleToVote?: boolean;
  /** Rollup of CONFIRMED CapitalInvestment amounts only. */
  totalInvested: string | number;
  /** True when totalInvested >= CooperativeSettings.votingThresholdAmount. */
  hasVotingRights: boolean;
  equityAccount?: {
    totalContributed: string | number;
    distributedToDate: string | number;
    currentBalance: string | number;
  } | null;
};

export type Sale = {
  id: string;
  storeId: string;
  cashierId: string;
  memberId: string | null;
  subtotal: string | number;
  discountAmount?: string | number;
  /** Member benefit discount total (equity perk savings — not manual line discounts). */
  memberDiscountAmount?: string | number;
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
  lotAllocations?: SaleItemLot[];
};

export type SaleItemLot = {
  id: string;
  lotId: string;
  quantity: number;
  unitCostSnapshot?: string | number;
  lot?: {
    id: string;
    lotNumber: string;
    status?: LotStatus;
    expiryDate?: string | null;
  };
};

export type LotStatus =
  | "ACTIVE"
  | "QUARANTINED"
  | "RECALLED"
  | "EXPIRED"
  | "DEPLETED";

export type Lot = {
  id: string;
  lotNumber: string;
  productId: string;
  sku: string;
  productName: string;
  storeId: string;
  status: LotStatus;
  quantityReceived: number;
  quantityRemaining: number;
  quantityReserved: number;
  expiryDate: string | null;
  receivedAt: string;
  unitCost: string;
  countryOfOrigin: string | null;
  supplier: { id: string; name: string } | null;
  daysUntilExpiry: number | null;
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
  refundPolicy?: string;
  /** Who funds member discounts at this store (from API — presentation only). */
  memberDiscountBearer?: "COOP" | "OPERATOR" | "SHARED";
  memberDiscountSharedPercent?: string | number;
  honorsNetworkBenefits?: boolean;
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

export type PurchaseOrderStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "PARTIALLY_RECEIVED"
  | "RECEIVED"
  | "CANCELLED";

export type Supplier = {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  paymentTerms: string;
  leadTimeDays: number;
  isActive: boolean;
  notes: string;
  products?: Array<{
    id: string;
    supplierSku: string;
    caseSize: number;
    caseCost: string | number;
    unitCost: string | number;
    minOrderQty: number;
    isPreferred: boolean;
    product: { id: string; sku: string; name: string; storeId: string };
  }>;
};

export type PurchaseOrderLine = {
  id: string;
  productId: string;
  orderedQty: number;
  receivedQty: number;
  unitCost: string | number;
  lineTotal: string | number;
  shortClosed?: boolean;
  product?: { id: string; sku: string; name: string; storeId: string; stock?: number };
};

export type PurchaseOrder = {
  id: string;
  poNumber: string;
  supplierId: string;
  storeId: string | null;
  status: PurchaseOrderStatus;
  expectedDate: string | null;
  submittedAt: string | null;
  subtotal: string | number;
  tax: string | number;
  shipping: string | number;
  total: string | number;
  createdAt: string;
  supplier?: { id: string; name: string };
  store?: { id: string; name: string } | null;
  lines: PurchaseOrderLine[];
};

export type ReorderSuggestion = {
  supplierId: string;
  supplierName: string;
  suggestedSubtotal: string;
  lines: Array<{
    productId: string;
    sku: string;
    name: string;
    available: number;
    reorderAt: number;
    caseSize: number;
    minOrderQty: number;
    unitCost: string;
    suggestedQty: number;
    lineTotal: string;
  }>;
};
