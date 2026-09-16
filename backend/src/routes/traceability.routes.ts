/**
 * Traceability HTTP routes — one step forward / one step back / lot genealogy.
 * Restricted to COOP_ADMIN and STORE_ADMIN (own store only).
 */
import { Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as traceability from "../services/traceability.service.js";

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Traceability route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const traceabilityRouter = Router();

traceabilityRouter.use(authMiddleware);
traceabilityRouter.use(requirePasswordChanged);
traceabilityRouter.use(requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN));

traceabilityRouter.get("/lots/:lotId/forward", async (req, res) => {
  try {
    const result = await traceability.traceForward(req.user!, req.params.lotId);
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

traceabilityRouter.get("/lots/:lotId/genealogy", async (req, res) => {
  try {
    const result = await traceability.getLotGenealogy(req.user!, req.params.lotId);
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

const backwardQuery = z
  .object({
    saleId: z.string().min(1).optional(),
    saleItemId: z.string().min(1).optional(),
  })
  .refine((q) => Boolean(q.saleId) !== Boolean(q.saleItemId), {
    message: "Provide exactly one of saleId or saleItemId",
  });

traceabilityRouter.get("/backward", async (req, res) => {
  try {
    const parsed = backwardQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid backward query", details: parsed.error.flatten() });
      return;
    }
    const result = await traceability.traceBackward(req.user!, parsed.data);
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

traceabilityRouter.get("/sales/:saleId/backward", async (req, res) => {
  try {
    const result = await traceability.traceBackward(req.user!, { saleId: req.params.saleId });
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

traceabilityRouter.get("/sale-items/:saleItemId/backward", async (req, res) => {
  try {
    const result = await traceability.traceBackward(req.user!, {
      saleItemId: req.params.saleItemId,
    });
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
});
