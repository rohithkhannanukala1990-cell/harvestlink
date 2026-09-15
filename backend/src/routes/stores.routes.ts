/**
 * Store settings HTTP routes.
 *
 * GET /stores lists stores with basic stats (today's sales, stock alerts, currently owed).
 * COOP_ADMIN sees the full network; store staff see only their assigned store.
 *
 * Multi-store Network Overview was deferred until single-store POS/inventory/settlement
 * worked — scoping bugs are much easier to catch with one store.
 *
 * GET /settlement/network-summary (Phase 6) remains the rollup totals endpoint.
 * PATCH updates name/address (store/co-op admin) and operatorPercent (COOP_ADMIN only).
 */
import { Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { clientIp } from "../lib/audit.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as storesService from "../services/stores.service.js";

const updateStoreSchema = z
  .object({
    name: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    operatorPercent: z.number().min(0).max(100).optional(),
    taxRate: z.number().min(0).max(100).optional(),
    refundPolicy: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Stores route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const storesRouter = Router();

storesRouter.use(authMiddleware);
storesRouter.use(requirePasswordChanged);

storesRouter.get("/", requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN), async (req, res) => {
  try {
    const stores = await storesService.listStores(req.user!);
    res.status(200).json({ stores });
  } catch (error) {
    handleError(res, error);
  }
});

storesRouter.get(
  "/:id",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      storesService.assertStoreAccess(req.user!, req.params.id);
      const store = await storesService.getStore(req.params.id);
      res.status(200).json({ store });
    } catch (error) {
      handleError(res, error);
    }
  },
);

storesRouter.patch(
  "/:id",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      storesService.assertStoreAccess(req.user!, req.params.id);
      const parsed = updateStoreSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid store update", details: parsed.error.flatten() });
        return;
      }
      const store = await storesService.updateStore(req.params.id, req.user!, {
        ...parsed.data,
        ipAddress: clientIp(req),
      });
      res.status(200).json({ store });
    } catch (error) {
      handleError(res, error);
    }
  },
);
