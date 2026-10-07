/**
 * Physical stock count routes.
 *
 * Blind counting: GET /:id and POST /:id/lines/:lineId/count never return expected quantities or
 * variances. Only GET /:id/review (STORE_ADMIN / COOP_ADMIN, COMPLETED counts) and the approval
 * response carry them.
 */
import { Role, ShrinkageReason, StockCountStatus, StockCountType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { clientIp } from "../lib/audit.js";
import { resolveStoreScope } from "../lib/storeScope.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as stockCountService from "../services/stockCount.service.js";

const createCountSchema = z.object({
  storeId: z.string().optional(),
  type: z.nativeEnum(StockCountType),
  productIds: z.array(z.string()).max(2000).optional(),
  lotIds: z.array(z.string()).max(2000).optional(),
  scheduledFor: z.coerce.date().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const submitLineSchema = z.object({
  countedQuantity: z.number().int().nonnegative(),
});

const approveSchema = z.object({
  reasons: z.record(z.string(), z.nativeEnum(ShrinkageReason)).optional(),
  overrideBlockedLots: z.boolean().optional(),
  overrideReason: z.string().max(2000).nullable().optional(),
});

const cancelSchema = z.object({
  reason: z.string().min(1).max(2000),
});

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Stock count route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const stockCountRouter = Router();

stockCountRouter.use(authMiddleware);
stockCountRouter.use(requirePasswordChanged);

stockCountRouter.get("/", async (req, res) => {
  try {
    const storeId = resolveStoreScope(
      req.user!,
      typeof req.query.storeId === "string" ? req.query.storeId : undefined,
    );
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const status =
      statusRaw && Object.values(StockCountStatus).includes(statusRaw as StockCountStatus)
        ? (statusRaw as StockCountStatus)
        : undefined;
    res.status(200).json({ counts: await stockCountService.listCounts(req.user!, storeId, status) });
  } catch (error) {
    handleError(res, error);
  }
});

stockCountRouter.post("/", requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN), async (req, res) => {
  try {
    const parsed = createCountSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid stock count payload", details: parsed.error.flatten() });
      return;
    }
    const storeId = resolveStoreScope(req.user!, parsed.data.storeId);
    const count = await stockCountService.createCount(req.user!, storeId, parsed.data.type, {
      productIds: parsed.data.productIds,
      lotIds: parsed.data.lotIds,
      scheduledFor: parsed.data.scheduledFor ?? null,
      notes: parsed.data.notes ?? null,
      ipAddress: clientIp(req),
    });
    res.status(201).json(count);
  } catch (error) {
    handleError(res, error);
  }
});

stockCountRouter.get("/:id", async (req, res) => {
  try {
    res.status(200).json(await stockCountService.getCountForCounter(req.user!, req.params.id));
  } catch (error) {
    handleError(res, error);
  }
});

stockCountRouter.post(
  "/:id/start",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      res
        .status(200)
        .json(await stockCountService.startCount(req.user!, req.params.id, clientIp(req)));
    } catch (error) {
      handleError(res, error);
    }
  },
);

stockCountRouter.post("/:id/lines/:lineId/count", async (req, res) => {
  try {
    const parsed = submitLineSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid count payload", details: parsed.error.flatten() });
      return;
    }
    const result = await stockCountService.submitCountLine(
      req.user!,
      req.params.id,
      req.params.lineId,
      parsed.data.countedQuantity,
      clientIp(req),
    );
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

stockCountRouter.post("/:id/complete", async (req, res) => {
  try {
    res
      .status(200)
      .json(await stockCountService.completeCount(req.user!, req.params.id, clientIp(req)));
  } catch (error) {
    handleError(res, error);
  }
});

stockCountRouter.get(
  "/:id/review",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      res.status(200).json(await stockCountService.getCountForReview(req.user!, req.params.id));
    } catch (error) {
      handleError(res, error);
    }
  },
);

stockCountRouter.post(
  "/:id/approve",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = approveSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid approval payload", details: parsed.error.flatten() });
        return;
      }
      const review = await stockCountService.approveCount(req.user!, req.params.id, {
        ...parsed.data,
        ipAddress: clientIp(req),
      });
      res.status(200).json(review);
    } catch (error) {
      handleError(res, error);
    }
  },
);

stockCountRouter.post(
  "/:id/cancel",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = cancelSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "A cancellation reason is required", details: parsed.error.flatten() });
        return;
      }
      res
        .status(200)
        .json(
          await stockCountService.cancelCount(req.user!, req.params.id, parsed.data.reason, clientIp(req)),
        );
    } catch (error) {
      handleError(res, error);
    }
  },
);
