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
  catalogItemId?: string | null;
  sku: string;
  name: string;
  category: string;
  price: string | number;
  /** Omitted for CASHIER — cost is admin-only on product DTOs. */
  cost?: string | number;
  /** Physical on-hand units. */
  stock: number;
  /** Units held by unpaid PENDING sales. */
  reserved?: number;
  /** Sellable = stock - reserved (prefer this in POS). */
  available?: number;
  /**
   * True when sellable qty is 0 but QUARANTINED/RECALLED lots still hold units.
   * POS must show a recall/quarantine message, not a generic out-of-stock cue.
   */
  blockedByQuarantineOrRecall?: boolean;
  reorderAt: number;
  taxExempt?: boolean;
  lowStock?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CatalogItem = {
  id: string;
  sku: string;
  name: string;
  category: string;
  taxExempt: boolean;
  isActive: boolean;
  unitsPerCase: number;
  casesPerPallet: number | null;
  caseWeightKg: string | number | null;
  caseGtin: string | null;
  maxShelfPrice: string | number;
  createdAt: string;
  updatedAt: string;
};

export type CatalogDisagreement = {
  id: string;
  sku: string;
  field: "name" | "category" | "taxExempt";
  chosenValue: string;
  values: Array<{ value: string | boolean; count: number; storeIds: string[] }>;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  createdAt: string;
};

/** Co-op-wide settings (singleton). Voting threshold lives here — never hardcoded. */
export type CooperativeSettings = {
  id: string;
  votingThresholdAmount: string | number;
  fiscalYearEnd: string;
  legalEntityName: string;
  /** Where the co-op is REGISTERED (e.g. OH). */
  stateOfIncorporation: string;
  /** Where the co-op OPERATES (e.g. TX) — may differ from registration. */
  operatingState: string;
  /** Principal operating office street address. */
  principalOfficeAddress: string;
  /** Days closed-shift cash may sit undeposited before the store is prompted to bank it. */
  cashDepositGraceDays: number;
  createdAt: string;
  updatedAt: string;
};

export type UndepositedDrawer = {
  drawerId: string;
  closedAt: string;
  bankableCash: string;
  coveredByConfirmedDeposits: string;
  undeposited: string;
  ageDays: number;
};

export type StoreCashPosition = {
  storeId: string;
  storeName: string;
  graceDays: number;
  cashOnHandByDrawer: UndepositedDrawer[];
  undepositedTotal: string;
  oldestUndepositedAt: string | null;
  daysOutstanding: number;
  pastGrace: boolean;
  pastDoubleGrace: boolean;
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
  /** Scannable lot label (normalized), when the lot carries its own barcode. */
  barcode: string | null;
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
  /** Omitted for CASHIER — unit cost is admin-only. */
  unitCost?: string;
  countryOfOrigin: string | null;
  /** Omitted for CASHIER. */
  supplier?: { id: string; name: string } | null;
  daysUntilExpiry: number | null;
};

/** GET /barcodes/products/:productId — UPC/EAN (GTIN) from the manufacturer, or a store code. */
export type ProductBarcode = {
  id: string;
  productId: string;
  code: string;
  kind: "GTIN" | "INTERNAL";
  label: string | null;
  createdAt: string;
};

export type SettlementSummary = {
  storeId: string;
  storeName: string;
  grossSales: string;
  operatorAccrued: string;
  totalPaidOut: string;
  currentlyOwed: string;
  grossSalesCard: string;
  grossSalesCash: string;
  /** Co-op share of card sales — settles to the co-op account through the processor. */
  coopAmountCard: string;
  /** Co-op share of cash sales — held in the store until an operator banks it. */
  coopAmountCash: string;
  cashCollectedButNotDeposited: string;
};

export type Payout = {
  id: string;
  storeId: string;
  amount: string | number;
  note: string | null;
  paidByUserId: string;
  createdAt: string;
};

export type LocationType = "RETAIL_STORE" | "WAREHOUSE";

export type Store = {
  id: string;
  name: string;
  address: string;
  /** RETAIL_STORE (POS) or WAREHOUSE (no POS; co-op operated). */
  locationType?: LocationType;
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
  drawerVariance: {
    windowFrom: string;
    windowTo: string;
    threshold: string;
    shifts: VarianceShift[];
    patterns: VariancePattern[];
  };
};

export type CountLineStatus = "PENDING" | "COUNTED" | "RECOUNT_REQUIRED" | "RESOLVED";
export type StockCountStatus = "DRAFT" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

/** GET /stock-counts — list rows carry no quantities. */
export type StockCountSummary = {
  id: string;
  type: "FULL" | "CYCLE" | "SPOT" | "RECEIVING_VERIFY";
  status: StockCountStatus;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  approvedAt: string | null;
  lineCount: number;
  scheduledBySystem: boolean;
  createdAt: string;
};

/** One lot to count. Blind by construction: no expected quantity, variance or anyone's figure. */
export type StockCountSheetLine = {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  lotId: string | null;
  lotNumber: string | null;
  expiryDate: string | null;
  /** Normalized codes (see scanner/barcode.ts) for resolving scans offline. */
  productBarcodes: string[];
  lotBarcode: string | null;
  status: CountLineStatus;
  countedByYou: boolean;
  recountByAnotherPerson: boolean;
};

/** GET /stock-counts/:id — the counter's view. */
export type StockCountSheet = {
  id: string;
  storeId: string;
  type: StockCountSummary["type"];
  status: StockCountStatus;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  notes: string | null;
  lines: StockCountSheetLine[];
};

export type ShrinkageSource =
  | "EXPIRY_JOB"
  | "RECALL"
  | "REFUND_NO_RESTOCK"
  | "STOCK_COUNT"
  | "MANUAL_ADJUSTMENT"
  | "OTHER_WRITE_OFF";

export type ShrinkageTotals = {
  value: string;
  units: number;
  events: number;
  salesAtCost: string;
  /** null when there were no sales at cost to divide by. */
  ratePercent: string | null;
};

export type ShrinkageProductRow = ShrinkageTotals & {
  productId: string;
  sku: string;
  productName: string;
  category: string;
};

/** GET /reports/shrinkage */
export type ShrinkageReport = {
  storeId: string | null;
  storeName: string | null;
  from: string;
  to: string;
  granularity: "day" | "week" | "month";
  totals: ShrinkageTotals & { countOverageValue: string; countOverageUnits: number };
  byReason: Array<{ reason: string; value: string; units: number; events: number; sharePercent: string }>;
  bySource: Array<{ source: ShrinkageSource; value: string; units: number; events: number }>;
  byProduct: ShrinkageProductRow[];
  byCategory: Array<ShrinkageTotals & { category: string }>;
  byLot: Array<{
    lotId: string;
    lotNumber: string;
    productId: string;
    sku: string;
    productName: string;
    supplierId: string | null;
    supplierName: string | null;
    value: string;
    units: number;
    events: number;
  }>;
  bySupplier: Array<ShrinkageTotals & { supplierId: string | null; supplierName: string }>;
  topLossProducts: ShrinkageProductRow[];
  trend: Array<ShrinkageTotals & { bucketStart: string; networkRatePercent: string | null }>;
  comparison: {
    storeRatePercent: string | null;
    networkRatePercent: string | null;
    networkValue: string;
    networkSalesAtCost: string;
    /** COOP_ADMIN only; empty for a store admin. */
    stores: Array<ShrinkageTotals & { storeId: string; storeName: string }>;
  };
  offlineStockConflicts: {
    rows: number;
    open: number;
    unitsOversold: number;
    products: Array<{
      productId: string;
      sku: string;
      productName: string;
      rows: number;
      open: number;
      unitsOversold: number;
    }>;
  };
};

export type VarianceDirection = "SHORT" | "OVER" | "BALANCED";

export type VarianceShift = {
  drawerId: string;
  storeId: string;
  storeName: string;
  /** Who opened the drawer — the person running the till. */
  userId: string;
  userEmail: string;
  closedByEmail: string | null;
  openedAt: string;
  closedAt: string;
  expectedCash: string;
  countedCash: string;
  variance: string;
  direction: VarianceDirection;
  overThreshold: boolean;
};

export type VarianceAggregate = {
  shiftCount: number;
  totalVariance: string;
  averageVariance: string;
  shortTotal: string;
  overTotal: string;
  shortCount: number;
  overCount: number;
  overThresholdCount: number;
};

export type VariancePattern = {
  userId: string;
  userEmail: string;
  direction: "SHORT" | "OVER";
  shiftCount: number;
  totalVariance: string;
  firstClosedAt: string;
  lastClosedAt: string;
  ongoing: boolean;
  drawerIds: string[];
};

export type DrawerVarianceReport = {
  storeId: string | null;
  from: string;
  to: string;
  threshold: string;
  tolerance: string;
  minStreak: number;
  totals: VarianceAggregate;
  byShift: VarianceShift[];
  byUser: Array<VarianceAggregate & { userId: string; userEmail: string }>;
  byStore: Array<VarianceAggregate & { storeId: string; storeName: string }>;
  patterns: VariancePattern[];
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

export type SupplierType =
  | "FPO"
  | "EXPORTER"
  | "DOMESTIC_DISTRIBUTOR"
  | "DOMESTIC_VENDOR"
  | "OTHER";

export type FpoLegalForm = "PRODUCER_COMPANY" | "COOPERATIVE_SOCIETY" | "OTHER";

export type OrganicStatus = "CONVENTIONAL" | "IN_CONVERSION" | "CERTIFIED_ORGANIC";

export type CertificationType =
  | "FSSAI_LICENSE"
  | "APEDA_RCMC"
  | "FDA_FOOD_FACILITY_REGISTRATION"
  | "ORGANIC_NPOP"
  | "ORGANIC_USDA"
  | "FSVP_VERIFICATION"
  | "LAB_ACCREDITATION"
  | "OTHER";

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
  supplierType?: SupplierType;
  country?: string;
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

export type FpoProfile = {
  id: string;
  supplierId: string;
  legalForm: FpoLegalForm;
  registrationNumber: string;
  state: string;
  district: string;
  block: string | null;
  memberFarmerCount: number;
  memberFarmerCountAsOf: string;
  womenFarmerCount: number | null;
  primaryCrops: string[];
  exportsViaSupplierId: string | null;
  onboardedAt: string;
  notes: string;
};

export type SupplierCertification = {
  id: string;
  supplierId: string;
  certType: CertificationType;
  certNumber: string;
  issuedAt: string;
  expiresAt: string | null;
  nextReviewDue: string | null;
  documentId: string | null;
  notes: string;
  verifiedAt: string | null;
};

export type PurchaseOrderLine = {
  id: string;
  productId: string;
  orderedQty: number;
  receivedQty: number;
  unitCost: string | number;
  unitCostForeign?: string | number | null;
  lineTotal: string | number;
  shortClosed?: boolean;
  product?: { id: string; sku: string; name: string; storeId: string; stock?: number };
};

export type PoImportShipmentSummary = {
  id: string;
  shipmentNumber: string;
  status: ImportShipmentStatus;
  containerNumber: string | null;
  eta: string | null;
  costCount: number;
};

export type PurchaseOrder = {
  id: string;
  poNumber: string;
  supplierId: string;
  storeId: string | null;
  status: PurchaseOrderStatus;
  expectedDate: string | null;
  submittedAt: string | null;
  currency?: string;
  fxRateToUsd?: string | number;
  paidAmountUsd?: string | number | null;
  paidAt?: string | null;
  paymentReference?: string | null;
  subtotal: string | number;
  tax: string | number;
  shipping: string | number;
  total: string | number;
  createdAt: string;
  supplier?: { id: string; name: string; supplierType?: SupplierType; country?: string };
  store?: { id: string; name: string } | null;
  lines: PurchaseOrderLine[];
  /** Present on GET /purchase-orders/:id when the PO is on an active import shipment. */
  importShipment?: PoImportShipmentSummary | null;
  landedPreviewByPoLineId?: Record<
    string,
    { landedAddOnPerUnit: string; quantity: number }
  >;
  complianceGaps?: Array<{ code: string; message: string }>;
  requiresLandedCostAck?: boolean;
};

export type ImportShipmentStatus =
  | "PLANNED"
  | "BOOKED"
  | "IN_TRANSIT"
  | "AT_PORT"
  | "CUSTOMS_HOLD"
  | "CLEARED"
  | "DELIVERED"
  | "RECEIVED"
  | "COSTED"
  | "CLOSED"
  | "CANCELLED";

export type ShipmentMode = "SEA_FCL" | "SEA_LCL" | "AIR";
export type Incoterm = "FOB" | "CIF" | "CFR" | "EXW" | "DAP";
export type ShipmentCostStatus = "ESTIMATED" | "FINAL";
export type ShipmentCostType =
  | "OCEAN_FREIGHT"
  | "AIR_FREIGHT"
  | "INSURANCE"
  | "CUSTOMS_DUTY"
  | "BROKER_FEE"
  | "PORT_CHARGES"
  | "DRAYAGE"
  | "INLAND_FREIGHT"
  | "FDA_EXAM"
  | "STORAGE_DEMURRAGE"
  | "FX_DIFFERENCE"
  | "OTHER";
export type CostAllocationBasis =
  | "VALUE"
  | "WEIGHT"
  | "VOLUME"
  | "QUANTITY"
  | "LINE_SPECIFIC";
export type ShipmentDocType =
  | "COMMERCIAL_INVOICE"
  | "PACKING_LIST"
  | "BILL_OF_LADING"
  | "AIR_WAYBILL"
  | "CERTIFICATE_OF_ORIGIN"
  | "PHYTOSANITARY_CERTIFICATE"
  | "FDA_PRIOR_NOTICE"
  | "CUSTOMS_ENTRY_SUMMARY"
  | "LAB_REPORT"
  | "FUMIGATION_CERTIFICATE"
  | "INSURANCE_CERTIFICATE"
  | "OTHER";

export type ShipmentCost = {
  id: string;
  shipmentId: string;
  costType: ShipmentCostType;
  vendorName: string;
  invoiceNumber: string | null;
  currency: string;
  amountForeign: string | number;
  fxRateToUsd: string | number;
  amountUsd: string | number;
  allocationBasis: CostAllocationBasis;
  status: ShipmentCostStatus;
  supersedesCostId: string | null;
  paidAt: string | null;
  paidAmountUsd: string | number | null;
  paymentReference: string | null;
  createdAt: string;
};

export type ShipmentEvent = {
  id: string;
  shipmentId: string;
  eventType: string;
  message: string;
  createdAt: string;
  createdByUserId: string | null;
};

export type ShipmentLine = {
  id: string;
  shipmentId: string;
  poLineId: string;
  quantity: number;
  grossWeightKg: string | number | null;
  volumeCbm: string | number | null;
  htsCode: string | null;
  dutyRatePercent: string | number | null;
  customsValueUsd: string | number;
  dutyAmountUsd: string | number | null;
  poLine?: {
    id: string;
    product?: { id: string; sku: string; name: string };
    po?: { id: string; poNumber: string };
  };
};

export type ImportShipment = {
  id: string;
  shipmentNumber: string;
  status: ImportShipmentStatus;
  mode: ShipmentMode;
  incoterm: Incoterm;
  originPort: string;
  destinationPort: string;
  carrier: string;
  vesselVoyage: string;
  containerNumber: string | null;
  billOfLadingNumber: string | null;
  customsEntryNumber: string | null;
  etd: string | null;
  eta: string | null;
  actualDeparture: string | null;
  actualArrival: string | null;
  clearedAt: string | null;
  deliveredAt: string | null;
  destinationStoreId: string;
  holdReason: string | null;
  createdAt: string;
  destinationStore?: { id: string; name: string; locationType: string };
  purchaseOrders?: Array<{
    id: string;
    poId: string;
    po: PurchaseOrder & {
      supplier?: { id: string; name: string; supplierType?: SupplierType };
    };
  }>;
  lines?: ShipmentLine[];
  costs?: ShipmentCost[];
  events?: ShipmentEvent[];
  goodsValueUsd: string | number;
  estimatedCostsUsd: string | number;
  finalCostsUsd: string | number;
  landedCostsUsd: string | number;
  landedTotalUsd: string | number;
  upliftPercent: string | number;
};

export type AllocationPreview = {
  shipmentId: string;
  shipmentNumber: string;
  status: ImportShipmentStatus;
  costCount: number;
  lines: Array<{
    shipmentLineId: string;
    poLineId: string;
    poId: string;
    poNumber: string;
    productId: string;
    sku: string;
    name: string;
    quantity: number;
    customsValueUsd: string | number;
    allocatedByCostType: Record<string, string>;
    landedAddOnTotal: string;
    landedAddOnPerUnit: string;
    landedUnitCost: string;
    upliftPercent: string;
  }>;
};

export type TrueUpPreview = {
  shipmentId: string;
  shipmentNumber: string;
  status: ImportShipmentStatus;
  hasChanges: boolean;
  allCostsFinal: boolean;
  totalVarianceUsd: string;
  lots: Array<{
    lotId: string;
    productId: string;
    poLineId: string;
    quantityReceived: number;
    unitsConsumed: number;
    previousAddOn: string;
    newAddOn: string;
    deltaPerUnit: string;
    previousUnitCost: string;
    newUnitCost: string;
    varianceAmountUsd: string;
  }>;
  wroteChanges?: boolean;
  movedToCosted?: boolean;
};

export type ShipmentDocumentRow = {
  id: string;
  shipmentId: string;
  docType: ShipmentDocType;
  documentId: string;
  referenceNumber: string | null;
  uploadedAt: string;
  document?: { id: string; fileName: string; mimeType: string; sizeBytes: number };
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
    /** Outstanding on SUBMITTED / PARTIALLY_RECEIVED POs. */
    onOrder: number;
    openPoNumbers: string[];
    /** Qty on DRAFT POs (not counted in position). */
    draftOnOrder: number;
    draftPoNumbers: string[];
    /** available + onOrder. */
    position: number;
    reorderAt: number;
    caseSize: number;
    minOrderQty: number;
    unitCost: string;
    suggestedQty: number;
    lineTotal: string;
  }>;
};
