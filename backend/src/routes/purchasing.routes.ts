/**
 * Purchasing HTTP routes — suppliers, POs, receiving, reorder suggestions.
 * CASHIER has no access. STORE_ADMIN is store-scoped; COOP_ADMIN is network-wide.
 */
import {
  FpoLegalForm,
  OrganicStatus,
  PurchaseOrderStatus,
  Role,
  SupplierType,
} from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { clientIp } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as purchasing from "../services/purchasing.service.js";

const supplierSchema = z.object({
  name: z.string().min(1),
  contactName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  paymentTerms: z.string().optional(),
  leadTimeDays: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().optional(),
  supplierType: z.nativeEnum(SupplierType).optional(),
  country: z.string().min(2).max(2).optional(),
});

const fpoProfileSchema = z.object({
  supplierId: z.string().min(1),
  legalForm: z.nativeEnum(FpoLegalForm).optional(),
  registrationNumber: z.string().optional(),
  state: z.string().optional(),
  district: z.string().optional(),
  block: z.string().nullable().optional(),
  memberFarmerCount: z.number().int().nonnegative(),
  memberFarmerCountAsOf: z.coerce.date().optional(),
  womenFarmerCount: z.number().int().nonnegative().nullable().optional(),
  primaryCrops: z.array(z.string()).optional(),
  exportsViaSupplierId: z.string().nullable().optional(),
  notes: z.string().optional(),
  onboardedAt: z.coerce.date().optional(),
});

const sourcingOriginSchema = z.object({
  fpoSupplierId: z.string().min(1).optional(),
  state: z.string().min(1),
  district: z.string().min(1),
  village: z.string().nullable().optional(),
  crop: z.string().min(1),
  variety: z.string().nullable().optional(),
  harvestSeason: z.string().nullable().optional(),
  harvestDate: z.coerce.date().nullable().optional(),
  contributingFarmerCount: z.number().int().nonnegative().nullable().optional(),
  organicStatus: z.nativeEnum(OrganicStatus).optional(),
});

const supplierProductSchema = z.object({
  supplierId: z.string().min(1),
  productId: z.string().min(1),
  supplierSku: z.string().optional(),
  caseSize: z.number().int().positive().optional(),
  caseCost: z.number().nonnegative(),
  unitCost: z.number().nonnegative(),
  minOrderQty: z.number().int().positive().optional(),
  isPreferred: z.boolean().optional(),
});

const poLineSchema = z.object({
  productId: z.string().min(1),
  orderedQty: z.number().int().positive(),
  unitCost: z.number().nonnegative().optional(),
  unitCostForeign: z.number().nonnegative().nullable().optional(),
});

const createPoSchema = z.object({
  supplierId: z.string().min(1),
  storeId: z.string().min(1).nullable().optional(),
  expectedDate: z.string().optional().nullable(),
  tax: z.number().nonnegative().optional(),
  shipping: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  fxRateToUsd: z.number().positive().optional(),
  lines: z.array(poLineSchema).min(1),
});

const updatePoSchema = z.object({
  expectedDate: z.string().optional().nullable(),
  tax: z.number().nonnegative().optional(),
  shipping: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  fxRateToUsd: z.number().positive().optional(),
  lines: z.array(poLineSchema).min(1).optional(),
});

const receiveSchema = z.object({
  invoiceNumber: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  acknowledgeNoLandedCost: z.boolean().optional(),
  acknowledgeComplianceGaps: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        poLineId: z.string().min(1),
        quantityReceived: z.number().int().nonnegative(),
        quantityRejected: z.number().int().nonnegative().optional(),
        rejectionReason: z.string().optional(),
        unitCostActual: z.number().nonnegative(),
        lotNumber: z.string().min(1).optional().nullable(),
        lotBarcode: z.string().min(1).max(200).optional().nullable(),
        expiryDate: z.coerce.date().optional().nullable(),
        harvestDate: z.coerce.date().optional().nullable(),
        countryOfOrigin: z.string().optional().nullable(),
        origin: sourcingOriginSchema.optional().nullable(),
        acknowledgeOverReceipt: z.boolean().optional(),
        closeShort: z.boolean().optional(),
        acknowledgeShortReceipt: z.boolean().optional(),
      }),
    )
    .min(1),
});

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Purchasing route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const purchasingRouter = Router();

purchasingRouter.use(authMiddleware);
purchasingRouter.use(requirePasswordChanged);
purchasingRouter.use(requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN));

// ── Suppliers ──

purchasingRouter.get("/suppliers", async (req, res) => {
  try {
    const activeOnly = req.query.active === "true";
    const suppliers = await purchasing.listSuppliers(activeOnly);
    res.status(200).json({ suppliers });
  } catch (error) {
    handleError(res, error);
  }
});

purchasingRouter.get("/suppliers/:id", async (req, res) => {
  try {
    const supplier = await purchasing.getSupplier(req.params.id!);
    res.status(200).json({ supplier });
  } catch (error) {
    handleError(res, error);
  }
});

purchasingRouter.post("/suppliers", async (req, res) => {
  try {
    const parsed = supplierSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid supplier", details: parsed.error.flatten() });
      return;
    }
    const supplier = await purchasing.createSupplier(req.user!, parsed.data);
    res.status(201).json({ supplier });
  } catch (error) {
    handleError(res, error);
  }
});

purchasingRouter.patch("/suppliers/:id", async (req, res) => {
  try {
    const parsed = supplierSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid supplier update", details: parsed.error.flatten() });
      return;
    }
    const supplier = await purchasing.updateSupplier(req.user!, req.params.id!, parsed.data);
    res.status(200).json({ supplier });
  } catch (error) {
    handleError(res, error);
  }
});

purchasingRouter.post("/supplier-products", async (req, res) => {
  try {
    const parsed = supplierProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid supplier product", details: parsed.error.flatten() });
      return;
    }
    const link = await purchasing.upsertSupplierProduct(req.user!, parsed.data);
    res.status(200).json({ supplierProduct: link });
  } catch (error) {
    handleError(res, error);
  }
});

// ── FPO profiles + sourcing summary (COOP_ADMIN) ──

purchasingRouter.get(
  "/sourcing-summary",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const summary = await purchasing.getSourcingSummary(req.user!);
      res.status(200).json({ summary });
    } catch (error) {
      handleError(res, error);
    }
  },
);

purchasingRouter.get(
  "/suppliers/:id/fpo-profile",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const profile = await purchasing.getFpoProfile(req.user!, req.params.id!);
      res.status(200).json({ profile });
    } catch (error) {
      handleError(res, error);
    }
  },
);

purchasingRouter.put(
  "/suppliers/:id/fpo-profile",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = fpoProfileSchema.safeParse({ ...req.body, supplierId: req.params.id });
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid FPO profile", details: parsed.error.flatten() });
        return;
      }
      const profile = await purchasing.upsertFpoProfile(req.user!, parsed.data);
      res.status(200).json({ profile });
    } catch (error) {
      handleError(res, error);
    }
  },
);

// ── Purchase orders ──

purchasingRouter.get("/purchase-orders", async (req, res) => {
  try {
    const status =
      typeof req.query.status === "string" && req.query.status in PurchaseOrderStatus
        ? (req.query.status as PurchaseOrderStatus)
        : undefined;
    const storeId =
      req.query.storeId === "null"
        ? null
        : typeof req.query.storeId === "string"
          ? req.query.storeId
          : undefined;
    const orders = await purchasing.listPurchaseOrders(req.user!, {
      storeId,
      status,
      includeCoop: req.query.includeCoop === "true",
    });
    res.status(200).json({ purchaseOrders: orders });
  } catch (error) {
    handleError(res, error);
  }
});

purchasingRouter.get("/purchase-orders/:id", async (req, res) => {
  try {
    const purchaseOrder = await purchasing.getPurchaseOrder(req.user!, req.params.id!);
    res.status(200).json({ purchaseOrder });
  } catch (error) {
    handleError(res, error);
  }
});

purchasingRouter.post("/purchase-orders", async (req, res) => {
  try {
    const parsed = createPoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid purchase order", details: parsed.error.flatten() });
      return;
    }
    const purchaseOrder = await purchasing.createPurchaseOrder(req.user!, {
      ...parsed.data,
      ipAddress: clientIp(req),
    });
    res.status(201).json({ purchaseOrder });
  } catch (error) {
    handleError(res, error);
  }
});

purchasingRouter.patch("/purchase-orders/:id", async (req, res) => {
  try {
    const parsed = updatePoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid PO update", details: parsed.error.flatten() });
      return;
    }
    const purchaseOrder = await purchasing.updatePurchaseOrder(
      req.user!,
      req.params.id!,
      { ...parsed.data, ipAddress: clientIp(req) },
    );
    res.status(200).json({ purchaseOrder });
  } catch (error) {
    handleError(res, error);
  }
});

purchasingRouter.post("/purchase-orders/:id/submit", async (req, res) => {
  try {
    const purchaseOrder = await purchasing.submitPurchaseOrder(
      req.user!,
      req.params.id!,
      clientIp(req),
    );
    res.status(200).json({ purchaseOrder });
  } catch (error) {
    handleError(res, error);
  }
});

purchasingRouter.post("/purchase-orders/:id/cancel", async (req, res) => {
  try {
    const purchaseOrder = await purchasing.cancelPurchaseOrder(
      req.user!,
      req.params.id!,
      clientIp(req),
    );
    res.status(200).json({ purchaseOrder });
  } catch (error) {
    handleError(res, error);
  }
});

purchasingRouter.post("/purchase-orders/:id/receive", async (req, res) => {
  try {
    const parsed = receiveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid receipt", details: parsed.error.flatten() });
      return;
    }
    const result = await purchasing.receiveGoods(req.user!, req.params.id!, {
      ...parsed.data,
      ipAddress: clientIp(req),
    });
    res.status(201).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

purchasingRouter.get("/reorder-suggestions", async (req, res) => {
  try {
    const storeId =
      typeof req.query.storeId === "string"
        ? req.query.storeId
        : req.user!.storeId;
    if (!storeId) {
      res.status(400).json({ error: "storeId is required for reorder suggestions" });
      return;
    }
    const suggestions = await purchasing.suggestReorderDrafts(req.user!, storeId);
    res.status(200).json({ suggestions });
  } catch (error) {
    handleError(res, error);
  }
});
