/**
 * Inventory HTTP routes for Harvestlink.
 *
 * Thin layer: parse/validate the request, enforce auth/roles, call inventory.service.
 * Cashiers and store admins only see their JWT store; COOP_ADMIN must pass ?storeId=
 * to view or manage any store's catalog. Create/edit/delete/stock are STORE_ADMIN or
 * COOP_ADMIN only — cashiers may list products for POS but not change the catalog.
 */
import { Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as inventoryService from "../services/inventory.service.js";

const createProductSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  price: z.number().nonnegative(),
  cost: z.number().nonnegative(),
  stock: z.number().int().nonnegative(),
  reorderAt: z.number().int().nonnegative(),
  storeId: z.string().min(1).optional(),
});

const updateProductSchema = z
  .object({
    sku: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    price: z.number().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
    reorderAt: z.number().int().nonnegative().optional(),
    storeId: z.string().min(1).optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== "storeId" && body[key as keyof typeof body] !== undefined), {
    message: "At least one product field is required",
  });

const adjustStockSchema = z.object({
  newStock: z.number().int().nonnegative(),
  reason: z.string().min(1),
  storeId: z.string().min(1).optional(),
});

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Inventory route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const inventoryRouter = Router();

inventoryRouter.use(authMiddleware);

inventoryRouter.get("/", async (req, res) => {
  try {
    const storeId = inventoryService.resolveStoreScope(
      req.user!,
      typeof req.query.storeId === "string" ? req.query.storeId : undefined,
    );
    const products = await inventoryService.listProducts(storeId);
    res.status(200).json({ products });
  } catch (error) {
    handleError(res, error);
  }
});

inventoryRouter.post("/", requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN), async (req, res) => {
  try {
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid product payload", details: parsed.error.flatten() });
      return;
    }

    const { storeId: bodyStoreId, ...input } = parsed.data;
    const storeId = inventoryService.resolveStoreScope(req.user!, bodyStoreId);
    const product = await inventoryService.createProduct(storeId, input);
    res.status(201).json({ product });
  } catch (error) {
    handleError(res, error);
  }
});

inventoryRouter.patch("/:id", requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN), async (req, res) => {
  try {
    const parsed = updateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid product update", details: parsed.error.flatten() });
      return;
    }

    const { storeId: bodyStoreId, ...input } = parsed.data;
    const storeId = inventoryService.resolveStoreScope(
      req.user!,
      bodyStoreId ?? (typeof req.query.storeId === "string" ? req.query.storeId : undefined),
    );
    const product = await inventoryService.updateProduct(req.params.id, storeId, input);
    res.status(200).json({ product });
  } catch (error) {
    handleError(res, error);
  }
});

inventoryRouter.delete("/:id", requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN), async (req, res) => {
  try {
    const storeId = inventoryService.resolveStoreScope(
      req.user!,
      typeof req.query.storeId === "string" ? req.query.storeId : undefined,
    );
    await inventoryService.deleteProduct(req.params.id, storeId);
    res.status(204).send();
  } catch (error) {
    handleError(res, error);
  }
});

inventoryRouter.patch(
  "/:id/stock",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = adjustStockSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid stock adjustment", details: parsed.error.flatten() });
        return;
      }

      const { storeId: bodyStoreId, ...input } = parsed.data;
      const storeId = inventoryService.resolveStoreScope(
        req.user!,
        bodyStoreId ?? (typeof req.query.storeId === "string" ? req.query.storeId : undefined),
      );
      const result = await inventoryService.adjustStock(req.params.id, storeId, req.user!, input);
      res.status(200).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);
