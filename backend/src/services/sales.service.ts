/**
 * Sales / checkout business logic for Harvestlink (Stripe-aware).
 *
 * TWO-PHASE CHECKOUT
 * ------------------
 * 1) createSale — snapshots prices + operatorPercent, verifies stock, writes Sale as
 *    paymentStatus=PENDING. Does NOT decrement inventory yet (payment may still fail).
 * 2) finalizePaidSale — runs only after Stripe reports success (webhook or confirm).
 *    Decrements stock and sets paymentStatus=PAID in one transaction.
 *
 * MONEY ROUTING
 * -------------
 * Stripe card funds go to the CO-OP Stripe account (merchant of record / payout destination).
 * Sale.operatorAmount is an INTERNAL accrual for Phase 6 settlement — not a Stripe payout
 * to the store operator. The co-op pays operators later (e.g. weekly bank transfer).
 *
 * Snapshot policy (unchanged): price/name/SKU and operatorPercent are frozen on the Sale
 * so history and settlement stay correct after catalog or rate changes.
 */
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  type Sale,
  type SaleItem,
} from "@prisma/client";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { getStripe, toStripeCents } from "../lib/stripe.js";
import { resolveStoreScope } from "../lib/storeScope.js";
import { env } from "../config/env.js";
import type { AuthUser } from "../types/auth.js";

export { resolveStoreScope };

export type SaleLineInput = {
  productId: string;
  quantity: number;
};

export type CreateSaleInput = {
  items: SaleLineInput[];
  memberId?: string | null;
  paymentMethod: PaymentMethod;
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
  /** Present when paymentMethod = CHECKOUT */
  checkout?: { sessionId: string; url: string };
  /** Present when paymentMethod = TERMINAL */
  terminal?: { paymentIntentId: string; clientSecret: string };
};

type LockedProductRow = {
  id: string;
  storeId: string;
  sku: string;
  name: string;
  price: Prisma.Decimal;
  stock: number;
};

function collapseQuantities(items: SaleLineInput[]): Map<string, number> {
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

/**
 * Phase 1: create a PENDING sale + start Stripe Checkout or Terminal collection.
 * Stock is checked (locked) but not decremented until finalizePaidSale.
 */
export async function createSale(
  storeId: string,
  cashier: AuthUser,
  input: CreateSaleInput,
): Promise<CreateSaleResult> {
  if (!input.items.length) {
    throw new AppError(400, "Sale must include at least one item");
  }

  const quantityByProductId = collapseQuantities(input.items);
  const productIds = [...quantityByProductId.keys()];

  let sale: SaleWithItems;

  try {
    sale = await prisma.$transaction(async (tx) => {
      const lockedProducts = await tx.$queryRaw<LockedProductRow[]>`
        SELECT id, "storeId", sku, name, price, stock
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

      for (const [productId, quantity] of quantityByProductId) {
        const product = productById.get(productId)!;
        if (product.stock < quantity) {
          throw new AppError(409, "Insufficient stock for product", {
            productId,
            sku: product.sku,
            requested: quantity,
            available: product.stock,
          });
        }
      }

      let subtotal = new Prisma.Decimal(0);
      const lineDrafts: Array<{
        productId: string;
        skuSnapshot: string;
        nameSnapshot: string;
        priceSnapshot: Prisma.Decimal;
        quantity: number;
      }> = [];

      for (const [productId, quantity] of quantityByProductId) {
        const product = productById.get(productId)!;
        const priceSnapshot = new Prisma.Decimal(product.price);
        subtotal = subtotal.add(priceSnapshot.mul(quantity));
        lineDrafts.push({
          productId,
          skuSnapshot: product.sku,
          nameSnapshot: product.name,
          priceSnapshot,
          quantity,
        });
      }

      subtotal = subtotal.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

      const stores = await tx.$queryRaw<
        Array<{ id: string; operatorPercent: Prisma.Decimal; isActive: boolean }>
      >`
        SELECT id, "operatorPercent", "isActive"
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

      const operatorPercent = new Prisma.Decimal(store.operatorPercent);
      const operatorAmount = subtotal
        .mul(operatorPercent)
        .div(100)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const coopAmount = subtotal.sub(operatorAmount);
      const total = subtotal;

      if (input.memberId) {
        const member = await tx.member.findUnique({ where: { id: input.memberId } });
        if (!member) {
          throw new AppError(404, "Member not found");
        }
        if (member.expiresAt.getTime() < Date.now()) {
          throw new AppError(400, "Member membership is expired");
        }
      }

      // PENDING: record the sale intent + snapshots, but leave stock untouched until PAID.
      return tx.sale.create({
        data: {
          storeId,
          cashierId: cashier.id,
          memberId: input.memberId ?? null,
          subtotal,
          total,
          operatorPercent,
          operatorAmount,
          coopAmount,
          paymentStatus: PaymentStatus.PENDING,
          paymentMethod: input.paymentMethod,
          items: {
            create: lineDrafts.map((line) => ({
              productId: line.productId,
              skuSnapshot: line.skuSnapshot,
              nameSnapshot: line.nameSnapshot,
              priceSnapshot: line.priceSnapshot,
              quantity: line.quantity,
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
    console.error("Pending sale creation failed — rolled back", error);
    throw new AppError(500, "Checkout failed; no sale was created");
  }

  if (input.paymentMethod === PaymentMethod.CHECKOUT) {
    const checkout = await startCheckoutPayment(sale);
    return { sale: checkout.sale, checkout: checkout.checkout };
  }

  const terminal = await startTerminalPayment(sale);
  return { sale: terminal.sale, terminal: terminal.terminal };
}

/**
 * Starts Stripe Checkout (card-not-present). Funds settle to the co-op Stripe account.
 */
async function startCheckoutPayment(sale: SaleWithItems): Promise<CreateSaleResult> {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    // Co-op is merchant of record — do not set transfer_data / destination to an operator.
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

/**
 * Starts a Terminal PaymentIntent (card-present). Client uses connection token + reader SDK.
 * Funds settle to the co-op Stripe account — not the store operator.
 */
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

/**
 * Issues a Stripe Terminal connection token for the POS reader SDK.
 */
export async function createTerminalConnectionToken(): Promise<{ secret: string }> {
  const stripe = getStripe();
  const token = await stripe.terminal.connectionTokens.create();
  if (!token.secret) {
    throw new AppError(502, "Stripe did not return a Terminal connection token");
  }
  return { secret: token.secret };
}

/**
 * Phase 2: after Stripe success — decrement stock and mark PAID atomically.
 * Idempotent: if already PAID, returns the sale without double-decrementing stock.
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

      if (sale.paymentStatus === PaymentStatus.FAILED) {
        throw new AppError(409, "Sale payment failed; create a new sale");
      }

      const items = await tx.saleItem.findMany({ where: { saleId } });
      if (!items.length) {
        throw new AppError(500, "Sale has no line items");
      }

      for (const item of items) {
        const updated = await tx.product.updateMany({
          where: {
            id: item.productId,
            storeId: sale.storeId,
            stock: { gte: item.quantity },
          },
          data: { stock: { decrement: item.quantity } },
        });

        if (updated.count !== 1) {
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
 * Marks a PENDING sale FAILED (no stock was taken, so nothing to restore).
 */
export async function markSalePaymentFailed(saleId: string): Promise<SaleWithItems> {
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: { items: true },
  });
  if (!sale) {
    throw new AppError(404, "Sale not found");
  }
  if (sale.paymentStatus === PaymentStatus.PAID || sale.paymentStatus === PaymentStatus.REFUNDED) {
    throw new AppError(409, `Cannot mark ${sale.paymentStatus} sale as FAILED`);
  }
  if (sale.paymentStatus === PaymentStatus.FAILED) {
    return sale;
  }

  return prisma.sale.update({
    where: { id: saleId },
    data: { paymentStatus: PaymentStatus.FAILED },
    include: { items: true },
  });
}

/**
 * Refunds a PAID sale: Stripe refund (co-op account) + restock + paymentStatus=REFUNDED.
 *
 * Operator settlement: REFUNDED sales drop out of PAID accruals (see settlement.service).
 * That is an internal ledger adjustment — still not a Stripe payout to/from the operator.
 */
export async function refundSale(saleId: string, storeId: string): Promise<SaleWithItems> {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, storeId },
    include: { items: true },
  });
  if (!sale) {
    throw new AppError(404, "Sale not found for this store");
  }
  if (sale.paymentStatus !== PaymentStatus.PAID) {
    throw new AppError(409, "Only PAID sales can be refunded", {
      paymentStatus: sale.paymentStatus,
    });
  }

  const stripe = getStripe();
  let paymentIntentId = sale.stripePaymentIntentId;

  if (!paymentIntentId && sale.stripeCheckoutSessionId) {
    const session = await stripe.checkout.sessions.retrieve(sale.stripeCheckoutSessionId);
    paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  }

  if (!paymentIntentId) {
    throw new AppError(409, "Sale has no Stripe PaymentIntent to refund");
  }

  await stripe.refunds.create({
    payment_intent: paymentIntentId,
    metadata: { saleId: sale.id, storeId: sale.storeId },
  });

  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Sale[]>`
        SELECT * FROM "Sale" WHERE id = ${saleId} FOR UPDATE
      `;
      const current = locked[0];
      if (!current) {
        throw new AppError(404, "Sale not found");
      }
      if (current.paymentStatus === PaymentStatus.REFUNDED) {
        return tx.sale.findFirstOrThrow({
          where: { id: saleId },
          include: { items: true },
        });
      }
      if (current.paymentStatus !== PaymentStatus.PAID) {
        throw new AppError(409, "Sale is no longer PAID");
      }

      const items = await tx.saleItem.findMany({ where: { saleId } });
      for (const item of items) {
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });
      }

      return tx.sale.update({
        where: { id: saleId },
        data: {
          paymentStatus: PaymentStatus.REFUNDED,
          refundedAt: new Date(),
        },
        include: { items: true },
      });
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    console.error("Refund stock restore failed after Stripe refund", error);
    throw new AppError(
      500,
      "Stripe refund succeeded but inventory restore failed — reconcile manually",
      { saleId },
    );
  }
}

/**
 * Confirms Terminal (or delayed Checkout) payment from the client after the reader succeeds.
 * Prefer webhooks in production; this endpoint covers local/dev and reader SDK callbacks.
 */
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
