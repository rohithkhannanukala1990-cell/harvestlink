/**
 * Reporting routes — daily close (Z-report), drawer variance and shrinkage for store operators.
 */
import { Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as reportsService from "../services/reports.service.js";
import * as shrinkageService from "../services/shrinkage.service.js";
import { resolveStoreScope } from "../lib/storeScope.js";

const dailyCloseQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  storeId: z.string().min(1).optional(),
});

const drawerVarianceQuery = z.object({
  storeId: z.string().min(1).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  threshold: z.coerce.number().nonnegative().optional(),
  tolerance: z.coerce.number().nonnegative().optional(),
  minStreak: z.coerce.number().int().min(2).optional(),
});

const shrinkageQuery = z.object({
  storeId: z.string().min(1).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Reports route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const reportsRouter = Router();

reportsRouter.use(authMiddleware);
reportsRouter.use(requirePasswordChanged);

reportsRouter.get(
  "/daily-close",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = dailyCloseQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid daily-close query", details: parsed.error.flatten() });
        return;
      }
      const storeId = resolveStoreScope(req.user!, parsed.data.storeId);
      const report = await reportsService.getDailyCloseReport(
        storeId,
        parsed.data.date,
        req.user!,
      );
      res.status(200).json(report);
    } catch (error) {
      handleError(res, error);
    }
  },
);

reportsRouter.get(
  "/drawer-variance",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = drawerVarianceQuery.safeParse(req.query);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "Invalid drawer-variance query", details: parsed.error.flatten() });
        return;
      }
      const report = await reportsService.getDrawerVarianceReport(req.user!, parsed.data);
      res.status(200).json(report);
    } catch (error) {
      handleError(res, error);
    }
  },
);

reportsRouter.get(
  "/shrinkage",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = shrinkageQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid shrinkage query", details: parsed.error.flatten() });
        return;
      }
      res.status(200).json(await shrinkageService.getShrinkageReport(req.user!, parsed.data));
    } catch (error) {
      handleError(res, error);
    }
  },
);
