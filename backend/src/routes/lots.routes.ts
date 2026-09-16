/**
 * Lot list / quarantine routes — inventory ops + Lots page.
 */
import { LotStatus, Role } from "@prisma/client";
import { Router } from "express";
import { AppError } from "../lib/errors.js";
import { clientIp } from "../lib/audit.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as inventoryService from "../services/inventory.service.js";

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Lots route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const lotsRouter = Router();

lotsRouter.use(authMiddleware);
lotsRouter.use(requirePasswordChanged);

lotsRouter.get("/", async (req, res) => {
  try {
    const storeId = inventoryService.resolveStoreScope(
      req.user!,
      typeof req.query.storeId === "string" ? req.query.storeId : undefined,
    );
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const status =
      statusRaw && Object.values(LotStatus).includes(statusRaw as LotStatus)
        ? (statusRaw as LotStatus)
        : undefined;
    const expiryWithinDays =
      typeof req.query.expiryWithinDays === "string"
        ? Number(req.query.expiryWithinDays)
        : undefined;

    let expiryBefore: Date | undefined;
    if (expiryWithinDays != null && Number.isFinite(expiryWithinDays)) {
      const days = Math.trunc(expiryWithinDays);
      expiryBefore = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }

    const lots = await inventoryService.listLots({
      storeId,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      status,
      expiryBefore,
      productId: typeof req.query.productId === "string" ? req.query.productId : undefined,
    });
    res.status(200).json({ lots });
  } catch (error) {
    handleError(res, error);
  }
});

lotsRouter.post(
  "/:id/quarantine",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const storeId = inventoryService.resolveStoreScope(
        req.user!,
        typeof req.body?.storeId === "string"
          ? req.body.storeId
          : typeof req.query.storeId === "string"
            ? req.query.storeId
            : undefined,
      );
      const reason =
        typeof req.body?.reason === "string" ? req.body.reason : "";
      const lot = await inventoryService.quarantineLot(
        req.user!,
        storeId,
        req.params.id,
        reason,
        clientIp(req),
      );
      res.status(200).json({ lot });
    } catch (error) {
      handleError(res, error);
    }
  },
);
