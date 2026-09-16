/**
 * Recall HTTP routes — COOP_ADMIN manages recalls; store staff can see active banners.
 * Recall records are never deleted.
 */
import { RecallSeverity, Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { clientIp } from "../lib/audit.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as recallService from "../services/recall.service.js";
import { resolveStoreScope } from "../lib/storeScope.js";

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Recall route error", error);
  res.status(500).json({ error: "Internal server error" });
}

const initiateSchema = z.object({
  lotIds: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  severity: z.nativeEnum(RecallSeverity),
  publicNotice: z.string().optional(),
});

export const recallRouter = Router();

recallRouter.use(authMiddleware);
recallRouter.use(requirePasswordChanged);

recallRouter.get(
  "/active-for-store",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const storeId = resolveStoreScope(
        req.user!,
        typeof req.query.storeId === "string" ? req.query.storeId : undefined,
      );
      const recalls = await recallService.listActiveRecallsForStore(req.user!, storeId);
      res.status(200).json({ recalls });
    } catch (error) {
      handleError(res, error);
    }
  },
);

recallRouter.get("/", requireRole(Role.COOP_ADMIN), async (req, res) => {
  try {
    const recalls = await recallService.listRecalls(req.user!);
    res.status(200).json({ recalls });
  } catch (error) {
    handleError(res, error);
  }
});

recallRouter.post("/", requireRole(Role.COOP_ADMIN), async (req, res) => {
  try {
    const parsed = initiateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid recall payload", details: parsed.error.flatten() });
      return;
    }
    const recall = await recallService.initiateRecall(req.user!, {
      ...parsed.data,
      ipAddress: clientIp(req),
    });
    res.status(201).json({ recall });
  } catch (error) {
    handleError(res, error);
  }
});

recallRouter.get(
  "/:id",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const recall = await recallService.getRecall(req.user!, req.params.id);
      res.status(200).json({ recall });
    } catch (error) {
      handleError(res, error);
    }
  },
);

recallRouter.get(
  "/:id/impact",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const impact = await recallService.previewRecallImpact(req.user!, req.params.id);
      res.status(200).json(impact);
    } catch (error) {
      handleError(res, error);
    }
  },
);

recallRouter.post("/:id/activate", requireRole(Role.COOP_ADMIN), async (req, res) => {
  try {
    const publicNotice =
      typeof req.body?.publicNotice === "string" ? req.body.publicNotice : undefined;
    const result = await recallService.activateRecall(req.user!, req.params.id, {
      publicNotice,
      ipAddress: clientIp(req),
    });
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

recallRouter.post("/:id/dispatch", requireRole(Role.COOP_ADMIN), async (req, res) => {
  try {
    const result = await recallService.dispatchRecallNotifications(req.user!, req.params.id, {
      ipAddress: clientIp(req),
    });
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

recallRouter.post("/:id/refunds", requireRole(Role.COOP_ADMIN), async (req, res) => {
  try {
    const result = await recallService.refundRecalledPurchases(req.user!, req.params.id, {
      ipAddress: clientIp(req),
    });
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

recallRouter.post("/:id/close", requireRole(Role.COOP_ADMIN), async (req, res) => {
  try {
    const report = await recallService.closeRecall(req.user!, req.params.id, {
      ipAddress: clientIp(req),
    });
    res.status(200).json({ report });
  } catch (error) {
    handleError(res, error);
  }
});

recallRouter.post("/:id/cancel", requireRole(Role.COOP_ADMIN), async (req, res) => {
  try {
    const recall = await recallService.cancelRecall(req.user!, req.params.id, {
      ipAddress: clientIp(req),
    });
    res.status(200).json({ recall });
  } catch (error) {
    handleError(res, error);
  }
});

const qtySchema = z.object({ quantity: z.number().int().positive() });

recallRouter.post(
  "/lots/:recallLotId/recovery",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = qtySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid quantity", details: parsed.error.flatten() });
        return;
      }
      const recallLot = await recallService.recordRecovery(
        req.user!,
        req.params.recallLotId,
        parsed.data.quantity,
        { ipAddress: clientIp(req) },
      );
      res.status(200).json({ recallLot });
    } catch (error) {
      handleError(res, error);
    }
  },
);

recallRouter.post(
  "/lots/:recallLotId/disposal",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = qtySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid quantity", details: parsed.error.flatten() });
        return;
      }
      const recallLot = await recallService.recordDisposal(
        req.user!,
        req.params.recallLotId,
        parsed.data.quantity,
        { ipAddress: clientIp(req) },
      );
      res.status(200).json({ recallLot });
    } catch (error) {
      handleError(res, error);
    }
  },
);
