/**
 * Import shipment HTTP routes — COOP_ADMIN only.
 */
import {
  CostAllocationBasis,
  ImportShipmentStatus,
  Incoterm,
  Role,
  ShipmentCostStatus,
  ShipmentCostType,
  ShipmentMode,
} from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { clientIp } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as landedCost from "../services/landedCost.service.js";
import * as shipment from "../services/shipment.service.js";
// true-up lives on landedCost; shipment routes expose preview + confirm.

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Shipment route error", error);
  res.status(500).json({ error: "Internal server error" });
}

const createSchema = z.object({
  mode: z.nativeEnum(ShipmentMode),
  incoterm: z.nativeEnum(Incoterm),
  originPort: z.string().optional(),
  destinationPort: z.string().optional(),
  carrier: z.string().optional(),
  vesselVoyage: z.string().optional(),
  containerNumber: z.string().nullable().optional(),
  billOfLadingNumber: z.string().nullable().optional(),
  customsEntryNumber: z.string().nullable().optional(),
  etd: z.coerce.date().nullable().optional(),
  eta: z.coerce.date().nullable().optional(),
  destinationStoreId: z.string().min(1).optional(),
  allowNonWarehouseDestination: z.boolean().optional(),
});

const lineSchema = z.object({
  poLineId: z.string().min(1),
  quantity: z.number().int().positive(),
  grossWeightKg: z.number().nonnegative().nullable().optional(),
  volumeCbm: z.number().nonnegative().nullable().optional(),
  htsCode: z.string().nullable().optional(),
  dutyRatePercent: z.number().nonnegative().nullable().optional(),
  customsValueUsd: z.number().nonnegative().nullable().optional(),
  dutyAmountUsd: z.number().nonnegative().nullable().optional(),
});

const costSchema = z.object({
  costType: z.nativeEnum(ShipmentCostType),
  vendorName: z.string().optional(),
  invoiceNumber: z.string().nullable().optional(),
  currency: z.string().length(3).optional(),
  amountForeign: z.number().nonnegative(),
  fxRateToUsd: z.number().positive().optional(),
  allocationBasis: z.nativeEnum(CostAllocationBasis).optional(),
  status: z.nativeEnum(ShipmentCostStatus).optional(),
  paidAt: z.coerce.date().nullable().optional(),
  paidAmountUsd: z.number().nonnegative().nullable().optional(),
  paymentReference: z.string().nullable().optional(),
});

const supersedeSchema = z.object({
  amountForeign: z.number().nonnegative(),
  fxRateToUsd: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  vendorName: z.string().optional(),
  invoiceNumber: z.string().nullable().optional(),
  allocationBasis: z.nativeEnum(CostAllocationBasis).optional(),
  paidAt: z.coerce.date().nullable().optional(),
  paidAmountUsd: z.number().nonnegative().nullable().optional(),
  paymentReference: z.string().nullable().optional(),
  confirmTrueUp: z.boolean().optional(),
});

const transitionSchema = z.object({
  status: z.nativeEnum(ImportShipmentStatus),
  holdReason: z.string().nullable().optional(),
  actualDeparture: z.coerce.date().nullable().optional(),
  actualArrival: z.coerce.date().nullable().optional(),
  clearedAt: z.coerce.date().nullable().optional(),
  deliveredAt: z.coerce.date().nullable().optional(),
  eta: z.coerce.date().nullable().optional(),
  message: z.string().optional(),
});

const paymentSchema = z.object({
  poId: z.string().min(1),
  paidAmountUsd: z.number().positive(),
  paidAt: z.coerce.date().optional(),
  paymentReference: z.string().nullable().optional(),
  confirmTrueUp: z.boolean().optional(),
});

export const shipmentRouter = Router();

shipmentRouter.use(authMiddleware);
shipmentRouter.use(requirePasswordChanged);
shipmentRouter.use(requireRole(Role.COOP_ADMIN));

shipmentRouter.get("/", async (req, res) => {
  try {
    const status = req.query.status
      ? z.nativeEnum(ImportShipmentStatus).parse(req.query.status)
      : undefined;
    const onTheWater =
      req.query.onTheWater === "1" || req.query.onTheWater === "true";
    const result = await shipment.listShipments(req.user!, {
      status,
      onTheWater: onTheWater || undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

shipmentRouter.post("/", async (req, res) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const row = await shipment.createShipment(req.user!, {
      ...parsed.data,
      ipAddress: clientIp(req),
    });
    res.status(201).json(row);
  } catch (error) {
    handleError(res, error);
  }
});

shipmentRouter.post("/supplier-payments", async (req, res) => {
  try {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const po = await shipment.recordSupplierPayment(req.user!, {
      ...parsed.data,
      ipAddress: clientIp(req),
    });
    res.json(po);
  } catch (error) {
    handleError(res, error);
  }
});

shipmentRouter.get("/:id/allocation-preview", async (req, res) => {
  try {
    const preview = await landedCost.previewAllocation(req.user!, req.params.id);
    res.json(preview);
  } catch (error) {
    handleError(res, error);
  }
});

shipmentRouter.get("/:id/true-up-preview", async (req, res) => {
  try {
    const preview = await landedCost.previewTrueUp(req.user!, req.params.id);
    res.json(preview);
  } catch (error) {
    handleError(res, error);
  }
});

shipmentRouter.post("/:id/true-up", async (req, res) => {
  try {
    const result = await landedCost.trueUpShipment(
      req.user!,
      req.params.id,
      clientIp(req),
    );
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

shipmentRouter.get("/:id", async (req, res) => {
  try {
    const row = await shipment.getShipment(req.user!, req.params.id);
    res.json(row);
  } catch (error) {
    handleError(res, error);
  }
});

shipmentRouter.post("/:id/purchase-orders", async (req, res) => {
  try {
    const poId = z.string().min(1).parse(req.body?.poId);
    const row = await shipment.attachPurchaseOrder(
      req.user!,
      req.params.id,
      poId,
      clientIp(req),
    );
    res.json(row);
  } catch (error) {
    handleError(res, error);
  }
});

shipmentRouter.put("/:id/lines", async (req, res) => {
  try {
    const parsed = z.object({ lines: z.array(lineSchema).min(1) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const row = await shipment.upsertShipmentLines(
      req.user!,
      req.params.id,
      parsed.data.lines,
      clientIp(req),
    );
    res.json(row);
  } catch (error) {
    handleError(res, error);
  }
});

shipmentRouter.post("/:id/costs", async (req, res) => {
  try {
    const parsed = costSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const row = await shipment.addCost(req.user!, req.params.id, {
      ...parsed.data,
      ipAddress: clientIp(req),
    });
    res.status(201).json(row);
  } catch (error) {
    handleError(res, error);
  }
});

shipmentRouter.post("/:id/costs/:costId/supersede", async (req, res) => {
  try {
    const parsed = supersedeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const row = await shipment.supersedeCost(
      req.user!,
      req.params.id,
      req.params.costId,
      { ...parsed.data, ipAddress: clientIp(req) },
    );
    res.status(201).json(row);
  } catch (error) {
    handleError(res, error);
  }
});

shipmentRouter.post("/:id/status", async (req, res) => {
  try {
    const parsed = transitionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const row = await shipment.transitionStatus(req.user!, req.params.id, {
      ...parsed.data,
      ipAddress: clientIp(req),
    });
    res.json(row);
  } catch (error) {
    handleError(res, error);
  }
});
