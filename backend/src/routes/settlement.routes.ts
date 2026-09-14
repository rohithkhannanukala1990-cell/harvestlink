/**
 * Settlement / payout HTTP routes for Harvestlink.
 *
 * Restricted to STORE_ADMIN (own store) and COOP_ADMIN (any store). Cashiers cannot
 * record payouts — settlement moves co-op cash and must stay with store/co-op admins.
 *
 * GET /settlement/network-summary is registered before /:storeId/* so Express does not
 * treat "network-summary" as a storeId.
 *
 * Network rollup was deferred until single-store settlement was correct — otherwise a
 * scoping bug would silently mix two stores' accruals and be hard to notice.
 */
import { Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as settlementService from "../services/settlement.service.js";

const createPayoutSchema = z.object({
  amount: z.number().positive(),
  note: z.string().max(2000).nullable().optional(),
});

const listPayoutsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Settlement route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const settlementRouter = Router();

settlementRouter.use(authMiddleware);

settlementRouter.get(
  "/network-summary",
  requireRole(Role.COOP_ADMIN),
  async (_req, res) => {
    try {
      const summary = await settlementService.getNetworkSettlementSummary();
      res.status(200).json(summary);
    } catch (error) {
      handleError(res, error);
    }
  },
);

settlementRouter.get(
  "/:storeId/summary",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      settlementService.assertSettlementAccess(req.user!, req.params.storeId);
      const summary = await settlementService.getStoreSettlementSummary(req.params.storeId);
      res.status(200).json(summary);
    } catch (error) {
      handleError(res, error);
    }
  },
);

settlementRouter.post(
  "/:storeId/payouts",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      settlementService.assertSettlementAccess(req.user!, req.params.storeId);

      const parsed = createPayoutSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payout payload", details: parsed.error.flatten() });
        return;
      }

      const result = await settlementService.createPayout(
        req.params.storeId,
        req.user!,
        parsed.data,
      );
      res.status(201).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

settlementRouter.get(
  "/:storeId/payouts",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      settlementService.assertSettlementAccess(req.user!, req.params.storeId);

      const parsed = listPayoutsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payouts query", details: parsed.error.flatten() });
        return;
      }

      const result = await settlementService.listPayouts(
        req.params.storeId,
        parsed.data.page,
        parsed.data.pageSize,
      );
      res.status(200).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);
