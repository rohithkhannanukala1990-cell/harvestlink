/**
 * Network CatalogItem CRUD — COOP_ADMIN write; STORE_ADMIN / COOP_ADMIN read.
 */
import { Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { clientIp } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as catalogService from "../services/catalog.service.js";

const createSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  taxExempt: z.boolean().optional(),
  isActive: z.boolean().optional(),
  unitsPerCase: z.number().int().min(1),
  casesPerPallet: z.number().int().min(1).nullable().optional(),
  caseWeightKg: z.number().nonnegative().nullable().optional(),
  caseGtin: z.string().min(1).nullable().optional(),
  maxShelfPrice: z.number().nonnegative(),
});

const updateSchema = createSchema.partial().refine(
  (body) => Object.values(body).some((v) => v !== undefined),
  { message: "At least one field is required" },
);

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Catalog route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const catalogRouter = Router();

catalogRouter.use(authMiddleware);
catalogRouter.use(requirePasswordChanged);

catalogRouter.get("/", requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN), async (req, res) => {
  try {
    const items = await catalogService.listCatalogItems(req.user!);
    res.status(200).json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

catalogRouter.get(
  "/disagreements",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const disagreements = await catalogService.getCatalogDisagreements(req.user!);
      res.status(200).json({ disagreements });
    } catch (error) {
      handleError(res, error);
    }
  },
);

catalogRouter.get("/:id", requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN), async (req, res) => {
  try {
    const item = await catalogService.getCatalogItem(req.user!, req.params.id);
    res.status(200).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

catalogRouter.post("/", requireRole(Role.COOP_ADMIN), async (req, res) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid catalog item", details: parsed.error.flatten() });
      return;
    }
    const item = await catalogService.createCatalogItem(req.user!, parsed.data);
    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

catalogRouter.patch("/:id", requireRole(Role.COOP_ADMIN), async (req, res) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid catalog update", details: parsed.error.flatten() });
      return;
    }
    const item = await catalogService.updateCatalogItem(
      req.user!,
      req.params.id,
      parsed.data,
      clientIp(req),
    );
    res.status(200).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

catalogRouter.delete("/:id", requireRole(Role.COOP_ADMIN), async (req, res) => {
  try {
    const item = await catalogService.deactivateCatalogItem(req.user!, req.params.id);
    res.status(200).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});
