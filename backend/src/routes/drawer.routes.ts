/**
 * Cash drawer HTTP routes: open, close, current.
 */
import { Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { clientIp } from "../lib/audit.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as drawerService from "../services/drawer.service.js";
import { resolveStoreScope } from "../lib/storeScope.js";

const openSchema = z.object({
  storeId: z.string().min(1).optional(),
  openingFloat: z.number().nonnegative(),
});

const closeSchema = z.object({
  storeId: z.string().min(1).optional(),
  countedCash: z.number().nonnegative(),
});

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Drawer route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const drawerRouter = Router();

drawerRouter.use(authMiddleware);
drawerRouter.use(requirePasswordChanged);

drawerRouter.get(
  "/current",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const storeId = resolveStoreScope(
        req.user!,
        typeof req.query.storeId === "string" ? req.query.storeId : undefined,
      );
      const drawer = await drawerService.getCurrentDrawer(storeId);
      res.status(200).json({ drawer });
    } catch (error) {
      handleError(res, error);
    }
  },
);

drawerRouter.post(
  "/open",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = openSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid open payload", details: parsed.error.flatten() });
        return;
      }
      const storeId = resolveStoreScope(req.user!, parsed.data.storeId);
      const drawer = await drawerService.openDrawer(
        storeId,
        req.user!,
        parsed.data.openingFloat,
        clientIp(req),
      );
      res.status(201).json({ drawer });
    } catch (error) {
      handleError(res, error);
    }
  },
);

drawerRouter.post(
  "/close",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = closeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid close payload", details: parsed.error.flatten() });
        return;
      }
      const storeId = resolveStoreScope(req.user!, parsed.data.storeId);
      const drawer = await drawerService.closeDrawer(
        storeId,
        req.user!,
        parsed.data.countedCash,
        clientIp(req),
      );
      res.status(200).json({ drawer });
    } catch (error) {
      handleError(res, error);
    }
  },
);
