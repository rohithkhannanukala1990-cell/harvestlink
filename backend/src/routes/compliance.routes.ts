/**
 * Documents, supplier certifications, shipment paperwork, expiring-cert feed.
 * Uploads via multer (memory). Downloads are authenticated — never public.
 */
import {
  CertificationType,
  Role,
  ShipmentDocType,
} from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { clientIp } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
} from "../lib/storage.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as compliance from "../services/compliance.service.js";
import * as documents from "../services/document.service.js";

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error("Compliance route error", error);
  res.status(500).json({ error: "Internal server error" });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only PDF, JPEG, and PNG documents are accepted"));
  },
});

const certSchema = z.object({
  supplierId: z.string().min(1),
  certType: z.nativeEnum(CertificationType),
  certNumber: z.string().optional(),
  issuedAt: z.coerce.date(),
  expiresAt: z.coerce.date().nullable().optional(),
  nextReviewDue: z.coerce.date().nullable().optional(),
  documentId: z.string().min(1).nullable().optional(),
  notes: z.string().optional(),
});

const shipmentDocSchema = z.object({
  docType: z.nativeEnum(ShipmentDocType),
  documentId: z.string().min(1),
  referenceNumber: z.string().nullable().optional(),
});

export const complianceRouter = Router();

complianceRouter.use(authMiddleware);
complianceRouter.use(requirePasswordChanged);
complianceRouter.use(requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN));

// ── Documents ──

complianceRouter.post("/documents", (req, res) => {
  upload.single("file")(req, res, (err) => {
    void (async () => {
      try {
        if (err) {
          handleError(res, err instanceof Error ? new AppError(400, err.message) : err);
          return;
        }
        if (!req.file) {
          res.status(400).json({ error: "file is required (multipart field name: file)" });
          return;
        }
        const doc = await documents.uploadDocument(req.user!, {
          buffer: req.file.buffer,
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          ipAddress: clientIp(req),
        });
        res.status(201).json(doc);
      } catch (error) {
        handleError(res, error);
      }
    })();
  });
});

complianceRouter.get("/documents/:id", async (req, res) => {
  try {
    const doc = await documents.getDocumentMeta(req.user!, req.params.id);
    res.json(doc);
  } catch (error) {
    handleError(res, error);
  }
});

complianceRouter.get("/documents/:id/download", async (req, res) => {
  try {
    const { document, body, mimeType, sizeBytes, fileName } =
      await documents.openDocumentDownload(req.user!, req.params.id);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(sizeBytes));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName.replace(/"/g, "")}"`,
    );
    res.setHeader("X-Document-Id", document.id);
    res.setHeader("X-Document-Sha256", document.sha256);
    body.pipe(res);
  } catch (error) {
    handleError(res, error);
  }
});

complianceRouter.delete(
  "/documents/:id",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      await documents.deleteDocument(req.user!, req.params.id, clientIp(req));
      res.status(204).send();
    } catch (error) {
      handleError(res, error);
    }
  },
);

// ── Certifications ──

complianceRouter.get(
  "/suppliers/:supplierId/certifications",
  async (req, res) => {
    try {
      const rows = await compliance.listSupplierCertifications(
        req.user!,
        req.params.supplierId,
      );
      res.json({ certifications: rows });
    } catch (error) {
      handleError(res, error);
    }
  },
);

complianceRouter.post(
  "/certifications",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = certSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
        return;
      }
      const row = await compliance.upsertSupplierCertification(req.user!, {
        ...parsed.data,
        ipAddress: clientIp(req),
      });
      res.status(201).json(row);
    } catch (error) {
      handleError(res, error);
    }
  },
);

complianceRouter.patch(
  "/certifications/:id",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = certSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
        return;
      }
      const row = await compliance.upsertSupplierCertification(
        req.user!,
        { ...parsed.data, ipAddress: clientIp(req) },
        req.params.id,
      );
      res.json(row);
    } catch (error) {
      handleError(res, error);
    }
  },
);

complianceRouter.get(
  "/expiring-certifications",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const days = req.query.days ? Number(req.query.days) : 30;
      const rows = await compliance.listExpiringCertifications(
        req.user!,
        Number.isFinite(days) && days > 0 ? days : 30,
      );
      res.json({ certifications: rows });
    } catch (error) {
      handleError(res, error);
    }
  },
);

// ── Shipment documents ──

complianceRouter.get("/shipments/:shipmentId/documents", async (req, res) => {
  try {
    const rows = await compliance.listShipmentDocuments(
      req.user!,
      req.params.shipmentId,
    );
    res.json({ documents: rows });
  } catch (error) {
    handleError(res, error);
  }
});

complianceRouter.post(
  "/shipments/:shipmentId/documents",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = shipmentDocSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
        return;
      }
      const row = await compliance.attachShipmentDocument(req.user!, {
        shipmentId: req.params.shipmentId,
        ...parsed.data,
        ipAddress: clientIp(req),
      });
      res.status(201).json(row);
    } catch (error) {
      handleError(res, error);
    }
  },
);
