/**
 * Sales / checkout business logic for Harvestlink (Stripe-aware).
 *
 * TWO-PHASE CHECKOUT + STOCK RESERVATION
 * --------------------------------------
 * BUG THIS FIXES (do not "simplify" away):
 * Previously createSale locked rows, verified `stock`, committed, then waited for Stripe.
 * FOR UPDATE ends at commit — so two cashiers could both create PENDING sales for the
 * last unit, both customers could pay, and the second finalizePaidSale threw
 * "Insufficient stock" AFTER the card was charged. Reservation closes that hole.
 *
 * 1) createSale — under FOR UPDATE, require (stock - reserved) >= qty, then
 *    reserved += qty, write PENDING sale with reservationExpiresAt = now + 15m.
 *    Physical `stock` is NOT decremented yet.
 * 2) finalizePaidSale — stock -= qty AND reserved -= qty (reservation converts to sale).
 * 3) markSalePaymentFailed / expireStaleReservations — reserved -= qty only (release hold).
 * 4) refundSale (PAID) — DB-first REFUNDING → Stripe → finalize REFUNDED/PAID.
 *    Restock increments stock only when restock=true; reserved was cleared at finalize.
 *
 * Available stock everywhere = stock - reserved.
 *
 * MONEY ROUTING
 * -------------
 * Stripe card funds go to the CO-OP Stripe account (merchant of record / payout destination).
 * Sale.operatorAmount is an INTERNAL accrual for settlement — not a Stripe payout
 * to the store operator. The co-op pays operators later (e.g. weekly bank transfer).
 */
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Role,
  SaleRefundStatus,
  type Sale,
  type SaleItem,
} from "@prisma/client";
import { env } from "../config/env.js";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { getStripe, toStripeCents } from "../lib/stripe.js";
import { resolveStoreScope } from "../lib/storeScope.js";
import type { AuthUser } from "../types/auth.js";
import { assertMemberActiveForSale } from "./membership.service.js";

export { resolveStoreScope };

/** How long a PENDING sale may hold reserved units before the cleanup job releases them. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

/** Stuck REFUNDING rows older than this are eligible for Stripe reconciliation. */
export const REFUNDING_RECONCILE_AFTER_MS = 2 * 60 * 1000;

export type SaleLineInput = {
  productId: string;
  quantity: number;
  /** Manual dollar discount on this line (STORE_ADMIN / COOP_ADMIN only). */
  manualDiscount?: number;
  /** Required when manualDiscount > 0. */
  discountReason?: string;
};

export type RefundLineInput = {
  saleItemId: string;
  quantity: number;
};

export type RefundSaleInput = {
  /** When omitted, refund every remaining (unrefunded) unit on the sale. */
  items?: RefundLineInput[];
  /** When false, do not increment Product.stock — record InventoryWriteOff instead. Default true. */
  restock?: boolean;
  createdByUserId?: string;
  ipAddress?: string | null;
};

export type CreateSaleInput = {
  items: SaleLineInput[];
  memberId?: string | null;
  paymentMethod: PaymentMethod;
  /** Optional card last4 when known (Terminal); ignored for CASH. */
  cardLast4?: string | null;
  ipAddress?: string | null;
  /**
   * Client-generated unique key (UUID). Required for offline queue replay.
   * Duplicate keys return the existing sale — never a second stock decrement.
   */
  idempotencyKey?: string | null;
  /**
   * Set by the POS offline sync worker when replaying a cash sale queued during
   * an outage. Enables negative-stock acceptance + reconciliation flagging, and
   * skips the open-drawer gate (cash was already taken while offline).
   */
  offlineSync?: boolean;
};

export type ListSalesFilter = {
  storeId: string;
  page: number;
  pageSize: number;
  from?: Date;
  to?: Date;
};

export type SaleWithItems = Sale & { items: SaleItem[] };

export type CreateSaleResult = {
  sale: SaleWithItems;
  checkout?: { sessionId: string; url: string };
  terminal?: { paymentIntentId: string; clientSecret: string };
  /** True when this response is a safe replay of an existing idempotencyKey. */
  replayed?: boolean;
  /** True when one or more lines drove stock negative (offline sync conflict). */
  stockReconciliationQueued?: boolean;
};

type LockedProductRow = {
  id: string;
  storeId: string;
  sku: string;
  name: string;
  price: Prisma.Decimal;
  stock: number;
  reserved: number;
  taxExempt: boolean;
};

function moneyDec(value: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function stockNeededByProduct(items: SaleLineInput[]): Map<string, number> {
  const quantityByProductId = new Map<string, number>();
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new AppError(400, "Each item quantity must be a positive integer");
    }
    quantityByProductId.set(
      item.productId,
      (quantityByProductId.get(item.productId) ?? 0) + item.quantity,
    );
  }
  return quantityByProductId;
}

function availableStock(stock: number, reserved: number): number {
  return stock - reserved;
}

/**
 * Releases Product.reserved for every line on a PENDING sale (payment failed / expired).
 * Does not change physical stock — units return to the available pool only.
 */
async function releaseReservationForSale(
  tx: Prisma.TransactionClient,
  saleId: string,
  storeId: string,
): Promise<void> {
  const items = await tx.saleItem.findMany({ where: { saleId } });
  for (const item of items) {
    const updated = await tx.product.updateMany({
      where: {
        id: item.productId,
        storeId,
        reserved: { gte: item.quantity },
      },
      data: { reserved: { decrement: item.quantity } },
    });
    if (updated.count !== 1) {
      throw new AppError(500, "Failed to release stock reservation", {
        productId: item.productId,
        quantity: item.quantity,
      });
    }
  }
}

/**
 * Creates a sale with tax, member/manual discounts, and payment routing.
 *
 * MONEY MATH (do not "simplify"):
 * 1) lineGross = price × qty
 * 2) discounts = optional manual $ (admin only) — capital contributions are NOT discounts
 *    and NEVER flow through this function (see membership.service)
 * 3) lineNet = lineGross − discounts  (pre-tax)
 * 4) lineTax = taxExempt ? 0 : lineNet × store.taxRate / 100
 * 5) Sale.subtotal = Σ lineNet   ← PRE-TAX
 * 6) Sale.taxAmount = Σ lineTax  ← remitted to the state, NOT revenue
 * 7) Sale.total = subtotal + taxAmount  ← what the customer pays
 * 8) operatorAmount = subtotal × operatorPercent / 100
 *    IMPORTANT: operator % applies to PRE-TAX subtotal only. Tax is not co-op/operator
 *    revenue — charging operatorPercent on post-tax total would overpay the operator.
 *    Capital contributions are equity and earn ZERO operator percentage.
 *
 * Member attachment: status must be ACTIVE (memberships never expire).
 *
 * CASH: requires an open cash drawer (unless offlineSync); creates PAID immediately.
 * CARD: reserves stock and starts Checkout/Terminal (existing two-phase flow).
 *
 * IDEMPOTENCY / OFFLINE SYNC:
 * - Clients that queue sales offline MUST send a stable idempotencyKey per queued sale.
 * - A duplicate key returns the existing Sale (replayed: true) — never double-decrements stock.
 * - offlineSync cash sales: if physical stock is insufficient, we still ACCEPT the sale and
 *   allow Product.stock to go negative, then insert StockReconciliation rows for review.
 *   WHY: the cashier already handed goods to the customer while the network was down. The
 *   database's stock count is a lagging estimate; physical reality outranks it. Silently
 *   dropping the sale would understate revenue and leave cash unaccounted for.
 */
export async function createSale(
  storeId: string,
  cashier: AuthUser,
  input: CreateSaleInput,
): Promise<CreateSaleResult> {
  if (!input.items.length) {
    throw new AppError(400, "Sale must include at least one item");
  }

  const isCash = input.paymentMethod === PaymentMethod.CASH;
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  const offlineSync = Boolean(input.offlineSync);

  if (offlineSync) {
    if (!isCash) {
      throw new AppError(400, "offlineSync is only valid for CASH sales");
    }
    if (!idempotencyKey) {
      throw new AppError(400, "offlineSync requires an idempotencyKey");
    }
  }

  // Fast path: identical retry / sync replay — return the first successful sale.
  if (idempotencyKey) {
    const existing = await prisma.sale.findUnique({
      where: { idempotencyKey },
      include: { items: true },
    });
    if (existing) {
      if (existing.storeId !== storeId) {
        throw new AppError(409, "idempotencyKey already used by another store");
      }
      return { sale: existing, replayed: true };
    }
  }

  const stockNeeded = stockNeededByProduct(input.items);
  const productIds = [...stockNeeded.keys()];
  const reservationExpiresAt = new Date(Date.now() + RESERVATION_TTL_MS);

  // Manual discounts are STORE_ADMIN / COOP_ADMIN only — always audited when used.
  for (const line of input.items) {
    const manual = line.manualDiscount ?? 0;
    if (manual < 0) {
      throw new AppError(400, "manualDiscount cannot be negative");
    }
    if (manual > 0) {
      if (cashier.role !== Role.STORE_ADMIN && cashier.role !== Role.COOP_ADMIN) {
        throw new AppError(403, "Only STORE_ADMIN or COOP_ADMIN may apply manual discounts");
      }
      if (!line.discountReason?.trim()) {
        throw new AppError(400, "discountReason is required for manual discounts");
      }
    }
  }

  let sale: SaleWithItems;
  let stockReconciliationQueued = false;
  let replayedFromTxn = false;
  let manualDiscountAudit: Array<{
    productId: string;
    amount: string;
    reason: string;
  }> = [];

  try {
    sale = await prisma.$transaction(async (tx) => {
      // Race guard: another request may have inserted the same key between the
      // pre-check and this transaction. Re-read under the txn before creating.
      if (idempotencyKey) {
        const raced = await tx.sale.findUnique({
          where: { idempotencyKey },
          include: { items: true },
        });
        if (raced) {
          if (raced.storeId !== storeId) {
            throw new AppError(409, "idempotencyKey already used by another store");
          }
          replayedFromTxn = true;
          return raced;
        }
      }

      const lockedProducts = await tx.$queryRaw<LockedProductRow[]>`
        SELECT id, "storeId", sku, name, price, stock, reserved, "taxExempt"
        FROM "Product"
        WHERE id IN (${Prisma.join(productIds)})
          AND "storeId" = ${storeId}
        FOR UPDATE
      `;

      if (lockedProducts.length !== productIds.length) {
        const found = new Set(lockedProducts.map((p) => p.id));
        const missing = productIds.filter((id) => !found.has(id));
        throw new AppError(404, "One or more products were not found for this store", {
          productIds: missing,
        });
      }

      const productById = new Map(lockedProducts.map((p) => [p.id, p]));

      // Lines that will drive stock below zero (offline sync only) — flagged after create.
      const negativeStockFlags: Array<{
        productId: string;
        quantitySold: number;
        stockBefore: number;
        stockAfter: number;
      }> = [];

      for (const [productId, quantity] of stockNeeded) {
        const product = productById.get(productId)!;
        const available = availableStock(product.stock, product.reserved);

        if (available >= quantity) {
          continue;
        }

        // Online / card / normal cash: refuse — cashier can see live stock.
        if (!offlineSync) {
          throw new AppError(409, "Insufficient stock for product", {
            productId,
            sku: product.sku,
            requested: quantity,
            available,
            stock: product.stock,
            reserved: product.reserved,
          });
        }

        // -----------------------------------------------------------------
        // OFFLINE SYNC CONFLICT — DO NOT DROP THE SALE
        //
        // The goods physically left the store while the till was offline.
        // Another channel may have sold the last units online in the meantime,
        // so Product.stock (or available = stock − reserved) is now too low.
        //
        // Physical reality outranks the database stock count: we ACCEPT the
        // cash sale, allow stock to go negative, and enqueue a StockReconciliation
        // row so ops can recount / adjust. Silently discarding the queued sale
        // would erase real revenue and leave drawer cash unexplained.
        // -----------------------------------------------------------------
        const stockAfter = product.stock - quantity;
        negativeStockFlags.push({
          productId,
          quantitySold: quantity,
          stockBefore: product.stock,
          stockAfter,
        });
      }

      const stores = await tx.$queryRaw<
        Array<{
          id: string;
          operatorPercent: Prisma.Decimal;
          isActive: boolean;
          taxRate: Prisma.Decimal;
        }>
      >`
        SELECT id, "operatorPercent", "isActive", "taxRate"
        FROM "Store"
        WHERE id = ${storeId}
        FOR UPDATE
      `;

      const store = stores[0];
      if (!store) {
        throw new AppError(404, "Store not found");
      }
      if (!store.isActive) {
        throw new AppError(400, "Store is inactive and cannot accept sales");
      }

      // Offline cash was already taken during the outage — do not block sync on drawer state.
      if (isCash && !offlineSync) {
        const openDrawer = await tx.cashDrawer.findFirst({
          where: { storeId, closedAt: null },
        });
        if (!openDrawer) {
          throw new AppError(409, "Open a cash drawer before taking cash sales");
        }
      }

      if (input.memberId) {
        const member = await tx.member.findUnique({ where: { id: input.memberId } });
        if (!member) {
          throw new AppError(404, "Member not found");
        }
        // Memberships NEVER expire — ACTIVE status is the only gate (replaces expiresAt).
        assertMemberActiveForSale(member);
      }

      const taxRate = new Prisma.Decimal(store.taxRate);

      let subtotal = new Prisma.Decimal(0);
      let discountAmount = new Prisma.Decimal(0);
      let taxAmount = new Prisma.Decimal(0);
      const lineDrafts: Array<{
        productId: string;
        skuSnapshot: string;
        nameSnapshot: string;
        priceSnapshot: Prisma.Decimal;
        quantity: number;
        discountAmount: Prisma.Decimal;
        discountReason: string | null;
        taxAmount: Prisma.Decimal;
        taxExempt: boolean;
      }> = [];
      manualDiscountAudit = [];

      for (const item of input.items) {
        const product = productById.get(item.productId)!;
        const priceSnapshot = new Prisma.Decimal(product.price);
        const lineGross = moneyDec(priceSnapshot.mul(item.quantity));

        let manual = moneyDec(item.manualDiscount ?? 0);
        if (manual.gt(lineGross)) {
          throw new AppError(400, "manualDiscount exceeds line amount", {
            productId: item.productId,
          });
        }
        const lineDiscount = moneyDec(manual);
        const lineNet = moneyDec(lineGross.sub(lineDiscount));
        const exempt = product.taxExempt;
        const lineTax = exempt ? moneyDec(0) : moneyDec(lineNet.mul(taxRate).div(100));

        subtotal = subtotal.add(lineNet);
        discountAmount = discountAmount.add(lineDiscount);
        taxAmount = taxAmount.add(lineTax);

        if (manual.gt(0)) {
          manualDiscountAudit.push({
            productId: item.productId,
            amount: manual.toFixed(2),
            reason: item.discountReason!.trim(),
          });
        }

        lineDrafts.push({
          productId: product.id,
          skuSnapshot: product.sku,
          nameSnapshot: product.name,
          priceSnapshot,
          quantity: item.quantity,
          discountAmount: lineDiscount,
          discountReason: manual.gt(0) ? item.discountReason!.trim() : null,
          taxAmount: lineTax,
          taxExempt: exempt,
        });
      }

      subtotal = moneyDec(subtotal);
      discountAmount = moneyDec(discountAmount);
      taxAmount = moneyDec(taxAmount);
      const total = moneyDec(subtotal.add(taxAmount));

      // Operator share is PRE-TAX only (see function docblock).
      const operatorPercent = new Prisma.Decimal(store.operatorPercent);
      const operatorAmount = moneyDec(subtotal.mul(operatorPercent).div(100));
      const coopAmount = moneyDec(subtotal.sub(operatorAmount));

      if (isCash) {
        for (const [productId, quantity] of stockNeeded) {
          // Unconditional decrement — may leave stock negative on offlineSync conflicts.
          await tx.product.update({
            where: { id: productId },
            data: { stock: { decrement: quantity } },
          });
        }

        const created = await tx.sale.create({
          data: {
            storeId,
            cashierId: cashier.id,
            memberId: input.memberId ?? null,
            subtotal,
            discountAmount,
            taxAmount,
            total,
            operatorPercent,
            operatorAmount,
            coopAmount,
            paymentStatus: PaymentStatus.PAID,
            paymentMethod: PaymentMethod.CASH,
            cardLast4: null,
            paidAt: new Date(),
            reservationExpiresAt: null,
            idempotencyKey,
            items: {
              create: lineDrafts.map((line) => ({
                productId: line.productId,
                skuSnapshot: line.skuSnapshot,
                nameSnapshot: line.nameSnapshot,
                priceSnapshot: line.priceSnapshot,
                quantity: line.quantity,
                discountAmount: line.discountAmount,
                discountReason: line.discountReason,
                taxAmount: line.taxAmount,
                taxExempt: line.taxExempt,
              })),
            },
          },
          include: { items: true },
        });

        if (negativeStockFlags.length) {
          stockReconciliationQueued = true;
          for (const flag of negativeStockFlags) {
            await tx.stockReconciliation.create({
              data: {
                storeId,
                saleId: created.id,
                productId: flag.productId,
                quantitySold: flag.quantitySold,
                stockBefore: flag.stockBefore,
                stockAfter: flag.stockAfter,
                reason: "OFFLINE_SALE_NEGATIVE_STOCK",
              },
            });
          }
        }

        return created;
      }

      // Card path: hold reservation across the payment gap.
      for (const [productId, quantity] of stockNeeded) {
        await tx.product.update({
          where: { id: productId },
          data: { reserved: { increment: quantity } },
        });
      }

      return tx.sale.create({
        data: {
          storeId,
          cashierId: cashier.id,
          memberId: input.memberId ?? null,
          subtotal,
          discountAmount,
          taxAmount,
          total,
          operatorPercent,
          operatorAmount,
          coopAmount,
          paymentStatus: PaymentStatus.PENDING,
          paymentMethod: input.paymentMethod,
          cardLast4: input.cardLast4 ?? null,
          reservationExpiresAt,
          idempotencyKey,
          items: {
            create: lineDrafts.map((line) => ({
              productId: line.productId,
              skuSnapshot: line.skuSnapshot,
              nameSnapshot: line.nameSnapshot,
              priceSnapshot: line.priceSnapshot,
              quantity: line.quantity,
              discountAmount: line.discountAmount,
              discountReason: line.discountReason,
              taxAmount: line.taxAmount,
              taxExempt: line.taxExempt,
            })),
          },
        },
        include: { items: true },
      });
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    // Concurrent insert of the same idempotencyKey → treat as successful replay.
    if (
      idempotencyKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await prisma.sale.findUnique({
        where: { idempotencyKey },
        include: { items: true },
      });
      if (existing && existing.storeId === storeId) {
        return { sale: existing, replayed: true };
      }
    }
    console.error("Pending sale creation failed — rolled back", error);
    throw new AppError(500, "Checkout failed; no sale was created");
  }

  // If the txn returned an existing sale from the in-txn idempotency re-read, stop here.
  if (replayedFromTxn) {
    return { sale, replayed: true };
  }

  for (const disc of manualDiscountAudit) {
    await writeAuditLog(
      {
        userId: cashier.id,
        storeId,
        action: AuditAction.SALE_MANUAL_DISCOUNT,
        entityType: "Sale",
        entityId: sale.id,
        after: disc,
        ipAddress: input.ipAddress ?? null,
      },
      { throwOnError: false },
    );
  }

  if (isCash) {
    return { sale, stockReconciliationQueued: stockReconciliationQueued || undefined };
  }

  if (input.paymentMethod === PaymentMethod.CHECKOUT) {
    const checkout = await startCheckoutPayment(sale);
    return { sale: checkout.sale, checkout: checkout.checkout };
  }

  const terminal = await startTerminalPayment(sale);
  return { sale: terminal.sale, terminal: terminal.terminal };
}

async function startCheckoutPayment(sale: SaleWithItems): Promise<CreateSaleResult> {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: sale.items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: env.STRIPE_CURRENCY,
        unit_amount: toStripeCents(item.priceSnapshot),
        product_data: {
          name: item.nameSnapshot,
          metadata: { sku: item.skuSnapshot, productId: item.productId },
        },
      },
    })),
    success_url: `${env.FRONTEND_URL}/pos/success?saleId=${sale.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.FRONTEND_URL}/pos/cancel?saleId=${sale.id}`,
    metadata: { saleId: sale.id, storeId: sale.storeId },
    payment_intent_data: {
      metadata: { saleId: sale.id, storeId: sale.storeId },
    },
  });

  if (!session.url) {
    throw new AppError(502, "Stripe Checkout Session did not return a URL");
  }

  const updated = await prisma.sale.update({
    where: { id: sale.id },
    data: {
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId:
        typeof session.payment_intent === "string" ? session.payment_intent : undefined,
    },
    include: { items: true },
  });

  return {
    sale: updated,
    checkout: { sessionId: session.id, url: session.url },
  };
}

async function startTerminalPayment(sale: SaleWithItems): Promise<CreateSaleResult> {
  const stripe = getStripe();
  const intent = await stripe.paymentIntents.create({
    amount: toStripeCents(sale.total),
    currency: env.STRIPE_CURRENCY,
    payment_method_types: ["card_present"],
    capture_method: "automatic",
    metadata: { saleId: sale.id, storeId: sale.storeId },
  });

  if (!intent.client_secret) {
    throw new AppError(502, "Stripe PaymentIntent missing client_secret");
  }

  const updated = await prisma.sale.update({
    where: { id: sale.id },
    data: { stripePaymentIntentId: intent.id },
    include: { items: true },
  });

  return {
    sale: updated,
    terminal: { paymentIntentId: intent.id, clientSecret: intent.client_secret },
  };
}

export async function createTerminalConnectionToken(): Promise<{ secret: string }> {
  const stripe = getStripe();
  const token = await stripe.terminal.connectionTokens.create();
  if (!token.secret) {
    throw new AppError(502, "Stripe did not return a Terminal connection token");
  }
  return { secret: token.secret };
}

/**
 * Phase 2: after Stripe success — convert reservation into a physical stock decrement.
 * Decrements BOTH stock and reserved. The reserved check is a safety assertion: the
 * primary guard already ran at createSale. Idempotent if already PAID.
 */
export async function finalizePaidSale(saleId: string): Promise<SaleWithItems> {
  try {
    return await prisma.$transaction(async (tx) => {
      const sales = await tx.$queryRaw<Sale[]>`
        SELECT * FROM "Sale" WHERE id = ${saleId} FOR UPDATE
      `;
      const sale = sales[0];
      if (!sale) {
        throw new AppError(404, "Sale not found");
      }

      if (sale.paymentStatus === PaymentStatus.PAID) {
        return tx.sale.findFirstOrThrow({
          where: { id: saleId },
          include: { items: true },
        });
      }

      if (sale.paymentStatus === PaymentStatus.REFUNDED) {
        throw new AppError(409, "Sale is already refunded");
      }

      if (sale.paymentStatus === PaymentStatus.REFUNDING) {
        throw new AppError(409, "Sale has a refund in progress");
      }

      if (sale.paymentStatus === PaymentStatus.FAILED) {
        throw new AppError(409, "Sale payment failed; create a new sale");
      }

      if (sale.paymentStatus === PaymentStatus.EXPIRED) {
        throw new AppError(409, "Sale reservation expired; create a new sale");
      }

      const items = await tx.saleItem.findMany({ where: { saleId } });
      if (!items.length) {
        throw new AppError(500, "Sale has no line items");
      }

      for (const item of items) {
        // Prefer the reserved path (normal). If the hold was already released by the
        // expiry job, attempt a last-chance claim on available stock so a late webhook
        // after expiry can still complete when units remain.
        const reservedPath = await tx.product.updateMany({
          where: {
            id: item.productId,
            storeId: sale.storeId,
            reserved: { gte: item.quantity },
            stock: { gte: item.quantity },
          },
          data: {
            stock: { decrement: item.quantity },
            reserved: { decrement: item.quantity },
          },
        });

        if (reservedPath.count === 1) {
          continue;
        }

        const claim = await tx.$executeRaw`
          UPDATE "Product"
          SET stock = stock - ${item.quantity}
          WHERE id = ${item.productId}
            AND "storeId" = ${sale.storeId}
            AND (stock - reserved) >= ${item.quantity}
        `;

        if (claim !== 1) {
          throw new AppError(409, "Insufficient stock at payment finalization", {
            productId: item.productId,
            quantity: item.quantity,
          });
        }
      }

      return tx.sale.update({
        where: { id: saleId },
        data: {
          paymentStatus: PaymentStatus.PAID,
          paidAt: new Date(),
          reservationExpiresAt: null,
        },
        include: { items: true },
      });
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    console.error("finalizePaidSale failed — rolled back", error);
    throw new AppError(500, "Unable to finalize paid sale");
  }
}

/**
 * Marks a PENDING sale FAILED and releases reserved units (does not change physical stock).
 */
export async function markSalePaymentFailed(saleId: string): Promise<SaleWithItems> {
  return settleUnpaidSale(saleId, PaymentStatus.FAILED);
}

/**
 * Marks a PENDING sale EXPIRED (abandoned checkout) and releases reserved units.
 * Used by the expirePendingSales job after confirming Stripe did not collect payment.
 */
export async function markSaleExpired(saleId: string): Promise<SaleWithItems> {
  return settleUnpaidSale(saleId, PaymentStatus.EXPIRED);
}

async function settleUnpaidSale(
  saleId: string,
  nextStatus: typeof PaymentStatus.FAILED | typeof PaymentStatus.EXPIRED,
): Promise<SaleWithItems> {
  try {
    return await prisma.$transaction(async (tx) => {
      const sales = await tx.$queryRaw<Sale[]>`
        SELECT * FROM "Sale" WHERE id = ${saleId} FOR UPDATE
      `;
      const sale = sales[0];
      if (!sale) {
        throw new AppError(404, "Sale not found");
      }
      if (
        sale.paymentStatus === PaymentStatus.PAID ||
        sale.paymentStatus === PaymentStatus.REFUNDED ||
        sale.paymentStatus === PaymentStatus.REFUNDING
      ) {
        throw new AppError(409, `Cannot mark ${sale.paymentStatus} sale as ${nextStatus}`);
      }
      if (
        sale.paymentStatus === PaymentStatus.FAILED ||
        sale.paymentStatus === PaymentStatus.EXPIRED
      ) {
        return tx.sale.findFirstOrThrow({
          where: { id: saleId },
          include: { items: true },
        });
      }

      await releaseReservationForSale(tx, saleId, sale.storeId);

      return tx.sale.update({
        where: { id: saleId },
        data: {
          paymentStatus: nextStatus,
          reservationExpiresAt: null,
        },
        include: { items: true },
      });
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    console.error(`settleUnpaidSale(${nextStatus}) failed`, error);
    throw new AppError(500, `Unable to mark sale ${nextStatus}`);
  }
}

type RefundClaim = {
  saleId: string;
  storeId: string;
  refundId: string;
  amount: Prisma.Decimal;
  operatorAmount: Prisma.Decimal;
  restock: boolean;
};

function money(value: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

async function resolvePaymentIntentId(sale: Sale): Promise<string> {
  const stripe = getStripe();
  let paymentIntentId = sale.stripePaymentIntentId;

  if (!paymentIntentId && sale.stripeCheckoutSessionId) {
    const session = await stripe.checkout.sessions.retrieve(sale.stripeCheckoutSessionId);
    paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
  }

  if (!paymentIntentId) {
    throw new AppError(409, "Sale has no Stripe PaymentIntent to refund");
  }
  return paymentIntentId;
}

/**
 * Builds refund lines + $ amounts from optional item list (full remaining when omitted).
 * Customer refund = proportional (lineNet + lineTax); operator clawback uses PRE-TAX lineNet only.
 */
function planRefundLines(
  sale: Sale,
  items: SaleItem[],
  requested: RefundLineInput[] | undefined,
): { lines: Array<{ saleItemId: string; productId: string; quantity: number; lineAmount: Prisma.Decimal; lineNet: Prisma.Decimal }>; amount: Prisma.Decimal; operatorAmount: Prisma.Decimal } {
  const byId = new Map(items.map((item) => [item.id, item]));
  const specs: Array<{ item: SaleItem; quantity: number }> = [];

  if (!requested || requested.length === 0) {
    for (const item of items) {
      const remaining = item.quantity - item.refundedQuantity;
      if (remaining > 0) {
        specs.push({ item, quantity: remaining });
      }
    }
  } else {
    const seen = new Set<string>();
    for (const row of requested) {
      if (!Number.isInteger(row.quantity) || row.quantity <= 0) {
        throw new AppError(400, "Refund quantity must be a positive integer", {
          saleItemId: row.saleItemId,
        });
      }
      if (seen.has(row.saleItemId)) {
        throw new AppError(400, "Duplicate saleItemId in refund items", {
          saleItemId: row.saleItemId,
        });
      }
      seen.add(row.saleItemId);
      const item = byId.get(row.saleItemId);
      if (!item) {
        throw new AppError(400, "saleItemId does not belong to this sale", {
          saleItemId: row.saleItemId,
        });
      }
      const remaining = item.quantity - item.refundedQuantity;
      if (row.quantity > remaining) {
        throw new AppError(400, "Refund quantity exceeds remaining refundable units", {
          saleItemId: row.saleItemId,
          remaining,
          requested: row.quantity,
        });
      }
      specs.push({ item, quantity: row.quantity });
    }
  }

  if (specs.length === 0) {
    throw new AppError(409, "Sale has no remaining refundable quantity");
  }

  const lines = specs.map(({ item, quantity }) => {
    const gross = item.priceSnapshot.mul(item.quantity);
    const netTotal = money(gross.sub(item.discountAmount));
    const unitNet = netTotal.div(item.quantity);
    const unitTax = item.taxAmount.div(item.quantity);
    const lineNet = money(unitNet.mul(quantity));
    const lineTax = money(unitTax.mul(quantity));
    return {
      saleItemId: item.id,
      productId: item.productId,
      quantity,
      lineNet,
      lineAmount: money(lineNet.add(lineTax)),
    };
  });

  let amount = lines.reduce((sum, line) => sum.add(line.lineAmount), new Prisma.Decimal(0));
  amount = money(amount);

  const saleTotal = money(sale.total);
  const alreadyRefunded = money(sale.refundedAmount);
  const remainingCustomer = money(saleTotal.sub(alreadyRefunded));
  if (amount.gt(remainingCustomer)) {
    amount = remainingCustomer;
  }
  if (amount.lte(0)) {
    throw new AppError(409, "Nothing left to refund on this sale");
  }

  const refundsAllRemaining = items.every((item) => {
    const planned = lines.find((l) => l.saleItemId === item.id)?.quantity ?? 0;
    return item.refundedQuantity + planned >= item.quantity;
  });

  let operatorAmount: Prisma.Decimal;
  if (refundsAllRemaining) {
    operatorAmount = money(sale.operatorAmount.sub(sale.refundedOperatorAmount));
    amount = remainingCustomer;
  } else if (sale.subtotal.eq(0)) {
    operatorAmount = money(0);
  } else {
    const netRefunded = lines.reduce((sum, line) => sum.add(line.lineNet), new Prisma.Decimal(0));
    operatorAmount = money(sale.operatorAmount.mul(netRefunded).div(sale.subtotal));
  }

  return { lines, amount, operatorAmount };
}

/**
 * Phase 1 — claim refund in DB (REFUNDING) before any Stripe money movement.
 * If Stripe later fails, abortFailedRefund returns the sale to PAID.
 * If Stripe succeeds but finalize crashes, reconcileRefundingSales finishes from Stripe state.
 */
async function claimRefundInDb(
  saleId: string,
  storeId: string,
  input: RefundSaleInput,
): Promise<RefundClaim> {
  const restock = input.restock !== false;

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Sale[]>`
      SELECT * FROM "Sale" WHERE id = ${saleId} FOR UPDATE
    `;
    const sale = locked[0];
    if (!sale || sale.storeId !== storeId) {
      throw new AppError(404, "Sale not found for this store");
    }
    if (sale.paymentStatus === PaymentStatus.REFUNDING) {
      throw new AppError(409, "A refund is already in progress for this sale", {
        pendingRefundId: sale.pendingRefundId,
      });
    }
    if (sale.paymentStatus !== PaymentStatus.PAID) {
      throw new AppError(409, "Only PAID sales can be refunded", {
        paymentStatus: sale.paymentStatus,
      });
    }

    const items = await tx.saleItem.findMany({ where: { saleId } });
    const plan = planRefundLines(sale, items, input.items);

    const refund = await tx.saleRefund.create({
      data: {
        saleId,
        amount: plan.amount,
        operatorAmount: plan.operatorAmount,
        restock,
        status: SaleRefundStatus.PENDING,
        createdByUserId: input.createdByUserId ?? null,
        lines: {
          create: plan.lines.map((line) => ({
            saleItemId: line.saleItemId,
            quantity: line.quantity,
          })),
        },
      },
    });

    await tx.sale.update({
      where: { id: saleId },
      data: {
        paymentStatus: PaymentStatus.REFUNDING,
        pendingRefundId: refund.id,
      },
    });

    return {
      saleId,
      storeId,
      refundId: refund.id,
      amount: plan.amount,
      operatorAmount: plan.operatorAmount,
      restock,
    };
  });
}

/**
 * Phase 3 — apply inventory + ledger after Stripe confirms the refund.
 * Idempotent: safe for the reconciliation job when finalize previously crashed.
 */
export async function finalizeSucceededRefund(
  refundId: string,
  options?: { ipAddress?: string | null },
): Promise<SaleWithItems> {
  return prisma.$transaction(async (tx) => {
    const refund = await tx.saleRefund.findUnique({
      where: { id: refundId },
      include: { lines: true },
    });
    if (!refund) {
      throw new AppError(404, "SaleRefund not found");
    }

    const locked = await tx.$queryRaw<Sale[]>`
      SELECT * FROM "Sale" WHERE id = ${refund.saleId} FOR UPDATE
    `;
    const sale = locked[0];
    if (!sale) {
      throw new AppError(404, "Sale not found");
    }

    if (refund.status === SaleRefundStatus.SUCCEEDED) {
      return tx.sale.findFirstOrThrow({
        where: { id: sale.id },
        include: { items: true },
      });
    }

    if (refund.status === SaleRefundStatus.FAILED) {
      throw new AppError(409, "Cannot finalize a FAILED refund");
    }

    const items = await tx.saleItem.findMany({ where: { saleId: sale.id } });
    const itemById = new Map(items.map((item) => [item.id, item]));

    for (const line of refund.lines) {
      const item = itemById.get(line.saleItemId);
      if (!item) {
        throw new AppError(500, "Refund line references missing SaleItem");
      }
      const remaining = item.quantity - item.refundedQuantity;
      if (line.quantity > remaining) {
        throw new AppError(409, "Refund line exceeds remaining quantity at finalize", {
          saleItemId: line.saleItemId,
        });
      }

      await tx.saleItem.update({
        where: { id: item.id },
        data: { refundedQuantity: { increment: line.quantity } },
      });
      item.refundedQuantity += line.quantity;

      if (refund.restock) {
        // Reservation was cleared at PAID finalize — restore shelf count only.
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { increment: line.quantity } },
        });
      } else {
        await tx.inventoryWriteOff.create({
          data: {
            storeId: sale.storeId,
            productId: item.productId,
            saleId: sale.id,
            saleItemId: item.id,
            saleRefundId: refund.id,
            quantity: line.quantity,
            reason: "REFUND_NO_RESTOCK",
          },
        });
      }
    }

    const updatedItems = await tx.saleItem.findMany({ where: { saleId: sale.id } });
    const fullyRefunded = updatedItems.every((item) => item.refundedQuantity >= item.quantity);

    await tx.saleRefund.update({
      where: { id: refund.id },
      data: {
        status: SaleRefundStatus.SUCCEEDED,
        completedAt: new Date(),
      },
    });

    const updatedSale = await tx.sale.update({
      where: { id: sale.id },
      data: {
        paymentStatus: fullyRefunded ? PaymentStatus.REFUNDED : PaymentStatus.PAID,
        refundedAt: fullyRefunded ? new Date() : sale.refundedAt,
        refundedAmount: { increment: refund.amount },
        refundedOperatorAmount: { increment: refund.operatorAmount },
        pendingRefundId: null,
      },
      include: { items: true },
    });

    await writeAuditLog(
      {
        userId: refund.createdByUserId,
        storeId: sale.storeId,
        action: AuditAction.SALE_REFUND,
        entityType: "Sale",
        entityId: sale.id,
        before: {
          paymentStatus: sale.paymentStatus,
          refundedAmount: sale.refundedAmount.toFixed(2),
          refundedOperatorAmount: sale.refundedOperatorAmount.toFixed(2),
        },
        after: {
          paymentStatus: updatedSale.paymentStatus,
          refundedAmount: updatedSale.refundedAmount.toFixed(2),
          refundedOperatorAmount: updatedSale.refundedOperatorAmount.toFixed(2),
          saleRefundId: refund.id,
          amount: refund.amount.toFixed(2),
          operatorAmount: refund.operatorAmount.toFixed(2),
          restock: refund.restock,
          lines: refund.lines.map((l) => ({
            saleItemId: l.saleItemId,
            quantity: l.quantity,
          })),
          stripeRefundId: refund.stripeRefundId,
        },
        ipAddress: options?.ipAddress ?? null,
      },
      { tx },
    );

    return updatedSale;
  });
}

/** Roll back REFUNDING → PAID when Stripe never took the money (or refund failed). */
export async function abortFailedRefund(refundId: string): Promise<SaleWithItems> {
  return prisma.$transaction(async (tx) => {
    const refund = await tx.saleRefund.findUnique({ where: { id: refundId } });
    if (!refund) {
      throw new AppError(404, "SaleRefund not found");
    }
    if (refund.status === SaleRefundStatus.SUCCEEDED) {
      throw new AppError(409, "Cannot abort a SUCCEEDED refund");
    }

    if (refund.status === SaleRefundStatus.PENDING) {
      await tx.saleRefund.update({
        where: { id: refundId },
        data: {
          status: SaleRefundStatus.FAILED,
          completedAt: new Date(),
        },
      });
    }

    const locked = await tx.$queryRaw<Sale[]>`
      SELECT * FROM "Sale" WHERE id = ${refund.saleId} FOR UPDATE
    `;
    const sale = locked[0];
    if (!sale) {
      throw new AppError(404, "Sale not found");
    }

    if (sale.paymentStatus === PaymentStatus.REFUNDING && sale.pendingRefundId === refundId) {
      return tx.sale.update({
        where: { id: sale.id },
        data: {
          paymentStatus: PaymentStatus.PAID,
          pendingRefundId: null,
        },
        include: { items: true },
      });
    }

    return tx.sale.findFirstOrThrow({
      where: { id: sale.id },
      include: { items: true },
    });
  });
}

/**
 * DB-first refund protocol:
 * 1) Mark sale REFUNDING + insert SaleRefund (PENDING) under row lock
 * 2) stripe.refunds.create (partial amount when not full remaining)
 * 3) Finalize inventory / refundedQuantity / settlement clawback → PAID or REFUNDED
 *
 * restock=false writes InventoryWriteOff instead of incrementing Product.stock.
 */
export async function refundSale(
  saleId: string,
  storeId: string,
  input: RefundSaleInput = {},
): Promise<SaleWithItems> {
  const claim = await claimRefundInDb(saleId, storeId, input);

  const saleForPay = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } });

  // Cash refunds never touch Stripe — finalize inventory/ledger immediately.
  if (saleForPay.paymentMethod === PaymentMethod.CASH) {
    return finalizeSucceededRefund(claim.refundId, {
      ipAddress: input.ipAddress ?? null,
    });
  }

  const stripe = getStripe();

  try {
    const paymentIntentId = await resolvePaymentIntentId(saleForPay);

    const stripeRefund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: toStripeCents(claim.amount),
      metadata: {
        saleId: claim.saleId,
        storeId: claim.storeId,
        saleRefundId: claim.refundId,
      },
    });

    await prisma.saleRefund.update({
      where: { id: claim.refundId },
      data: { stripeRefundId: stripeRefund.id },
    });

    return await finalizeSucceededRefund(claim.refundId, {
      ipAddress: input.ipAddress ?? null,
    });
  } catch (error) {
    const stripeId = await prisma.saleRefund
      .findUnique({ where: { id: claim.refundId }, select: { stripeRefundId: true } })
      .then((r) => r?.stripeRefundId ?? null)
      .catch(() => null);

    if (!stripeId) {
      try {
        await abortFailedRefund(claim.refundId);
      } catch (abortError) {
        console.error("abortFailedRefund after Stripe error", abortError);
      }
    }

    if (error instanceof AppError) {
      throw error;
    }
    console.error("refundSale Stripe/finalize failed", error);
    throw new AppError(
      500,
      stripeId
        ? "Stripe refund recorded; finalizing inventory — reconciliation will complete if needed"
        : "Unable to refund sale",
      { saleId, refundId: claim.refundId },
    );
  }
}

/**
 * Reconciles stuck REFUNDING sales by asking Stripe for the refund's true state.
 * Called by the reconcileRefundingSales job.
 */
export async function reconcileRefundingSale(saleId: string): Promise<"finalized" | "aborted" | "pending"> {
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: {
      refunds: {
        where: { status: SaleRefundStatus.PENDING },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!sale || sale.paymentStatus !== PaymentStatus.REFUNDING) {
    return "pending";
  }

  const refund =
    (sale.pendingRefundId
      ? await prisma.saleRefund.findUnique({ where: { id: sale.pendingRefundId } })
      : null) ??
    sale.refunds[0] ??
    null;

  if (!refund) {
    // Orphan REFUNDING with no refund row — return to PAID so settlement is not frozen.
    await prisma.sale.update({
      where: { id: saleId },
      data: { paymentStatus: PaymentStatus.PAID, pendingRefundId: null },
    });
    return "aborted";
  }

  const stripe = getStripe();
  let stripeStatus: string | null = null;

  if (refund.stripeRefundId) {
    const remote = await stripe.refunds.retrieve(refund.stripeRefundId);
    stripeStatus = remote.status;
  } else {
    const paymentIntentId = await resolvePaymentIntentId(sale);
    const listed = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 20 });
    const match = listed.data.find((r) => r.metadata?.saleRefundId === refund.id);
    if (match) {
      await prisma.saleRefund.update({
        where: { id: refund.id },
        data: { stripeRefundId: match.id },
      });
      stripeStatus = match.status;
    }
  }

  if (stripeStatus === "succeeded") {
    await finalizeSucceededRefund(refund.id);
    return "finalized";
  }
  if (stripeStatus === "failed" || stripeStatus === "canceled") {
    await abortFailedRefund(refund.id);
    return "aborted";
  }

  // No Stripe refund yet after the grace window → money never left; abort claim.
  const ageMs = Date.now() - refund.createdAt.getTime();
  if (!stripeStatus && ageMs >= REFUNDING_RECONCILE_AFTER_MS) {
    await abortFailedRefund(refund.id);
    return "aborted";
  }

  return "pending";
}

export async function confirmSalePayment(saleId: string, storeId: string): Promise<SaleWithItems> {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, storeId },
    include: { items: true },
  });
  if (!sale) {
    throw new AppError(404, "Sale not found for this store");
  }
  if (sale.paymentStatus === PaymentStatus.PAID) {
    return sale;
  }
  if (sale.paymentStatus !== PaymentStatus.PENDING) {
    throw new AppError(409, `Cannot confirm sale in status ${sale.paymentStatus}`);
  }

  const stripe = getStripe();

  if (sale.stripeCheckoutSessionId) {
    const session = await stripe.checkout.sessions.retrieve(sale.stripeCheckoutSessionId);
    if (session.payment_status !== "paid") {
      throw new AppError(402, "Checkout session is not paid yet", {
        payment_status: session.payment_status,
      });
    }
    return finalizePaidSale(saleId);
  }

  if (!sale.stripePaymentIntentId) {
    throw new AppError(409, "Sale has no Stripe payment to confirm");
  }

  const intent = await stripe.paymentIntents.retrieve(sale.stripePaymentIntentId);
  if (intent.status !== "succeeded") {
    throw new AppError(402, "PaymentIntent has not succeeded yet", { status: intent.status });
  }

  return finalizePaidSale(saleId);
}

/**
 * Re-checks Stripe for a PENDING sale: true if Checkout/Terminal already collected payment.
 * Used by the expiry job so a lost webhook does not release reserved stock on a paid sale.
 */
export async function isSalePaidInStripe(sale: {
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
}): Promise<boolean> {
  if (!env.STRIPE_SECRET_KEY) {
    return false;
  }

  const stripe = getStripe();

  if (sale.stripeCheckoutSessionId) {
    const session = await stripe.checkout.sessions.retrieve(sale.stripeCheckoutSessionId);
    if (session.payment_status === "paid") {
      return true;
    }
    if (typeof session.payment_intent === "string") {
      const intent = await stripe.paymentIntents.retrieve(session.payment_intent);
      return intent.status === "succeeded";
    }
  }

  if (sale.stripePaymentIntentId) {
    const intent = await stripe.paymentIntents.retrieve(sale.stripePaymentIntentId);
    return intent.status === "succeeded";
  }

  return false;
}

export async function listSales(filter: ListSalesFilter): Promise<{
  sales: SaleWithItems[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}> {
  const where: Prisma.SaleWhereInput = {
    storeId: filter.storeId,
    ...(filter.from || filter.to
      ? {
          createdAt: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
  };

  const skip = (filter.page - 1) * filter.pageSize;

  const [total, sales] = await prisma.$transaction([
    prisma.sale.count({ where }),
    prisma.sale.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: "desc" },
      skip,
      take: filter.pageSize,
    }),
  ]);

  return {
    sales,
    page: filter.page,
    pageSize: filter.pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / filter.pageSize),
  };
}

export async function getSaleById(saleId: string, storeId: string): Promise<SaleWithItems> {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, storeId },
    include: { items: true },
  });

  if (!sale) {
    throw new AppError(404, "Sale not found for this store");
  }

  return sale;
}
