/**
 * Sales / checkout HTTP routes for Harvestlink (Stripe Checkout + Terminal).
 *
 * POST /sales creates a PENDING sale and returns Checkout URL or Terminal client_secret.
 * Stock decrements only after payment succeeds (webhook or POST /sales/:id/confirm-payment).
 * POST /sales/:id/refund — DB-first REFUNDING → Stripe → PAID/REFUNDED.
 * Optional body.items for partial line refunds; restock defaults true.
 */
import { PaymentMethod, Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { clientIp } from "../lib/audit.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as salesService from "../services/sales.service.js";
import * as receiptService from "../services/receipt.service.js";

const createSaleSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().positive(),
        manualDiscount: z.number().nonnegative().optional(),
        discountReason: z.string().min(1).optional(),
      }),
    )
    .min(1),
  memberId: z.string().min(1).nullable().optional(),
  storeId: z.string().min(1).optional(),
  paymentMethod: z.nativeEnum(PaymentMethod),
  cardLast4: z.string().length(4).optional(),
  /** Client UUID for offline queue / retry safety. */
  idempotencyKey: z.string().min(8).max(128).optional(),
  /** Replay of a sale queued while the POS was offline (CASH only). */
  offlineSync: z.boolean().optional(),
});

const emailReceiptSchema = z.object({
  storeId: z.string().min(1).optional(),
  email: z.string().email().optional(),
});

const refundSaleSchema = z.object({
  storeId: z.string().min(1).optional(),
  /** When omitted, refund all remaining (unrefunded) units on the sale. */
  items: z
    .array(
      z.object({
        saleItemId: z.string().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1)
    .optional(),
  /** When false, write off inventory instead of restocking. Default true. */
  restock: z.boolean().optional(),
});

const listSalesQuerySchema = z.object({
  storeId: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
});

function parseOptionalDate(value: string | undefined, bound: "from" | "to"): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, `Invalid ${bound} date`);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && bound === "to") {
    date.setUTCHours(23, 59, 59, 999);
  }

  return date;
}

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Sales route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const salesRouter = Router();

salesRouter.use(authMiddleware);
salesRouter.use(requirePasswordChanged);

salesRouter.post(
  "/terminal/connection-token",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (_req, res) => {
    try {
      const token = await salesService.createTerminalConnectionToken();
      res.status(200).json(token);
    } catch (error) {
      handleError(res, error);
    }
  },
);

salesRouter.post(
  "/",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = createSaleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid sale payload", details: parsed.error.flatten() });
        return;
      }

      const {
        storeId: bodyStoreId,
        memberId,
        items,
        paymentMethod,
        cardLast4,
        idempotencyKey,
        offlineSync,
      } = parsed.data;
      const storeId = salesService.resolveStoreScope(req.user!, bodyStoreId);
      const result = await salesService.createSale(storeId, req.user!, {
        items,
        memberId,
        paymentMethod,
        cardLast4,
        idempotencyKey,
        offlineSync,
        ipAddress: clientIp(req),
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

salesRouter.get(
  "/",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = listSalesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid sales query", details: parsed.error.flatten() });
        return;
      }

      const storeId = salesService.resolveStoreScope(req.user!, parsed.data.storeId);
      const result = await salesService.listSales({
        storeId,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        from: parseOptionalDate(parsed.data.from, "from"),
        to: parseOptionalDate(parsed.data.to, "to"),
      });
      res.status(200).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

salesRouter.post(
  "/:id/confirm-payment",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const storeId = salesService.resolveStoreScope(
        req.user!,
        typeof req.query.storeId === "string" ? req.query.storeId : undefined,
      );
      const sale = await salesService.confirmSalePayment(req.params.id, storeId);
      res.status(200).json({ sale });
    } catch (error) {
      handleError(res, error);
    }
  },
);

salesRouter.post(
  "/:id/refund",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = refundSaleSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "Invalid refund payload", parsed.error.flatten());
      }

      const storeId = salesService.resolveStoreScope(
        req.user!,
        parsed.data.storeId ??
          (typeof req.query.storeId === "string" ? req.query.storeId : undefined),
      );
      const sale = await salesService.refundSale(req.params.id, storeId, {
        items: parsed.data.items,
        restock: parsed.data.restock,
        createdByUserId: req.user!.id,
        ipAddress: clientIp(req),
      });
      res.status(200).json({ sale });
    } catch (error) {
      handleError(res, error);
    }
  },
);

salesRouter.get(
  "/:id/receipt",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const storeId = salesService.resolveStoreScope(
        req.user!,
        typeof req.query.storeId === "string" ? req.query.storeId : undefined,
      );
      const html = await receiptService.buildReceiptHtml(req.params.id, storeId);
      res.status(200).type("html").send(html);
    } catch (error) {
      handleError(res, error);
    }
  },
);

salesRouter.post(
  "/:id/receipt/email",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = emailReceiptSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "Invalid email-receipt payload", parsed.error.flatten());
      }
      const storeId = salesService.resolveStoreScope(
        req.user!,
        parsed.data.storeId ??
          (typeof req.query.storeId === "string" ? req.query.storeId : undefined),
      );
      const result = await receiptService.emailReceipt(
        req.params.id,
        storeId,
        parsed.data.email,
      );
      res.status(200).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

salesRouter.get(
  "/:id",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const storeId = salesService.resolveStoreScope(
        req.user!,
        typeof req.query.storeId === "string" ? req.query.storeId : undefined,
      );
      const sale = await salesService.getSaleById(req.params.id, storeId);
      res.status(200).json({ sale });
    } catch (error) {
      handleError(res, error);
    }
  },
);
