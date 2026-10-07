/**
 * Barcode routes — one scanning layer for counting, receiving and lot lookup.
 *
 * GET /lookup is open to every store role (counters are usually cashiers) and carries no
 * quantities. Registering or removing codes is STORE_ADMIN / COOP_ADMIN.
 */
import { BarcodeKind, Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { clientIp } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { resolveStoreScope } from "../lib/storeScope.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as barcodeService from "../services/barcode.service.js";

const lookupQuery = z.object({
  code: z.string().min(1).max(200),
  storeId: z.string().min(1).optional(),
});

const addBarcodeSchema = z.object({
  code: z.string().min(1).max(200),
  kind: z.nativeEnum(BarcodeKind).optional(),
  label: z.string().max(120).nullable().optional(),
  storeId: z.string().min(1).optional(),
});

const lotBarcodeSchema = z.object({
  barcode: z.string().max(200).nullable(),
  storeId: z.string().min(1).optional(),
});

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Barcode route error", error);
  res.status(500).json({ error: "Internal server error" });
}

function queryStoreId(req: import("express").Request): string | undefined {
  return typeof req.query.storeId === "string" ? req.query.storeId : undefined;
}

export const barcodeRouter = Router();

barcodeRouter.use(authMiddleware);
barcodeRouter.use(requirePasswordChanged);

barcodeRouter.get("/lookup", async (req, res) => {
  try {
    const parsed = lookupQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid barcode lookup", details: parsed.error.flatten() });
      return;
    }
    const storeId = resolveStoreScope(req.user!, parsed.data.storeId);
    res.status(200).json(await barcodeService.lookupBarcode(storeId, parsed.data.code));
  } catch (error) {
    handleError(res, error);
  }
});

barcodeRouter.get("/products/:productId", async (req, res) => {
  try {
    const storeId = resolveStoreScope(req.user!, queryStoreId(req));
    res
      .status(200)
      .json({ barcodes: await barcodeService.listProductBarcodes(storeId, req.params.productId) });
  } catch (error) {
    handleError(res, error);
  }
});

barcodeRouter.post(
  "/products/:productId",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = addBarcodeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid barcode", details: parsed.error.flatten() });
        return;
      }
      const storeId = resolveStoreScope(req.user!, parsed.data.storeId ?? queryStoreId(req));
      const barcode = await barcodeService.addProductBarcode(req.user!, storeId, req.params.productId, {
        code: parsed.data.code,
        kind: parsed.data.kind,
        label: parsed.data.label ?? null,
        ipAddress: clientIp(req),
      });
      res.status(201).json({ barcode });
    } catch (error) {
      handleError(res, error);
    }
  },
);

barcodeRouter.delete("/:barcodeId", requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN), async (req, res) => {
  try {
    const storeId = resolveStoreScope(req.user!, queryStoreId(req));
    await barcodeService.removeProductBarcode(req.user!, storeId, req.params.barcodeId, clientIp(req));
    res.status(204).send();
  } catch (error) {
    handleError(res, error);
  }
});

barcodeRouter.put("/lots/:lotId", requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN), async (req, res) => {
  try {
    const parsed = lotBarcodeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid lot barcode", details: parsed.error.flatten() });
      return;
    }
    const storeId = resolveStoreScope(req.user!, parsed.data.storeId ?? queryStoreId(req));
    const lot = await barcodeService.setLotBarcode(
      req.user!,
      storeId,
      req.params.lotId,
      parsed.data.barcode,
      clientIp(req),
    );
    res.status(200).json({ lot });
  } catch (error) {
    handleError(res, error);
  }
});
