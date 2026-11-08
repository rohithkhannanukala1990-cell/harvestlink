/**
 * Import compliance — supplier certifications and shipment paperwork.
 *
 * /// The document list reflects common US food-import practice (FDA prior notice, FSVP, CBP entry
 * /// summary). The co-op's customs broker should confirm which apply to each product.
 */
import {
  CertificationType,
  ImportShipmentStatus,
  Role,
  ShipmentDocType,
  SupplierType,
  type SupplierCertification,
} from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";

function assertCoopAdmin(actor: AuthUser): void {
  if (actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only COOP_ADMIN may manage compliance records");
  }
}

function assertAdmin(actor: AuthUser): void {
  if (actor.role !== Role.STORE_ADMIN && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Cashiers cannot access compliance records");
  }
}

export type ComplianceGap = {
  code: "MISSING_FSVP" | "FSVP_REVIEW_OVERDUE" | "MISSING_FDA_PRIOR_NOTICE";
  message: string;
  supplierId?: string;
  shipmentId?: string;
};

/**
 * Gaps that block receive unless acknowledgeComplianceGaps (COOP_ADMIN, audited).
 * FSVP applies when the PO supplier is FPO or EXPORTER; FDA prior notice applies to the shipment.
 */
export async function findReceiveComplianceGaps(input: {
  supplierId: string;
  supplierType: SupplierType;
  shipmentId: string;
  asOf?: Date;
}): Promise<ComplianceGap[]> {
  const asOf = input.asOf ?? new Date();
  const gaps: ComplianceGap[] = [];

  if (
    input.supplierType === SupplierType.FPO ||
    input.supplierType === SupplierType.EXPORTER
  ) {
    const fsvp = await prisma.supplierCertification.findFirst({
      where: {
        supplierId: input.supplierId,
        certType: CertificationType.FSVP_VERIFICATION,
      },
      orderBy: [{ nextReviewDue: "desc" }, { verifiedAt: "desc" }],
    });
    if (!fsvp) {
      gaps.push({
        code: "MISSING_FSVP",
        message: "Supplier has no FSVP_VERIFICATION on file",
        supplierId: input.supplierId,
        shipmentId: input.shipmentId,
      });
    } else if (fsvp.nextReviewDue && fsvp.nextReviewDue < asOf) {
      gaps.push({
        code: "FSVP_REVIEW_OVERDUE",
        message: `FSVP nextReviewDue ${fsvp.nextReviewDue.toISOString().slice(0, 10)} is past`,
        supplierId: input.supplierId,
        shipmentId: input.shipmentId,
      });
    }
  }

  const priorNotice = await prisma.shipmentDocument.findFirst({
    where: {
      shipmentId: input.shipmentId,
      docType: ShipmentDocType.FDA_PRIOR_NOTICE,
    },
    select: { id: true },
  });
  if (!priorNotice) {
    gaps.push({
      code: "MISSING_FDA_PRIOR_NOTICE",
      message: "Shipment has no FDA_PRIOR_NOTICE document attached",
      shipmentId: input.shipmentId,
    });
  }

  return gaps;
}

export type UpsertCertificationInput = {
  supplierId: string;
  certType: CertificationType;
  certNumber?: string;
  issuedAt: string | Date;
  expiresAt?: string | Date | null;
  nextReviewDue?: string | Date | null;
  documentId?: string | null;
  notes?: string;
  ipAddress?: string | null;
};

export async function upsertSupplierCertification(
  actor: AuthUser,
  input: UpsertCertificationInput,
  existingId?: string,
): Promise<SupplierCertification> {
  assertCoopAdmin(actor);
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw new AppError(404, "Supplier not found");

  if (input.documentId) {
    const doc = await prisma.document.findUnique({ where: { id: input.documentId } });
    if (!doc) throw new AppError(404, "Document not found");
  }

  const issuedAt = new Date(input.issuedAt);
  if (Number.isNaN(issuedAt.getTime())) throw new AppError(400, "issuedAt is invalid");
  const expiresAt =
    input.expiresAt === undefined || input.expiresAt === null
      ? null
      : new Date(input.expiresAt);
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new AppError(400, "expiresAt is invalid");
  }
  const nextReviewDue =
    input.nextReviewDue === undefined || input.nextReviewDue === null
      ? null
      : new Date(input.nextReviewDue);
  if (nextReviewDue && Number.isNaN(nextReviewDue.getTime())) {
    throw new AppError(400, "nextReviewDue is invalid");
  }

  const data = {
    supplierId: input.supplierId,
    certType: input.certType,
    certNumber: input.certNumber?.trim() ?? "",
    issuedAt,
    expiresAt,
    nextReviewDue,
    documentId: input.documentId ?? null,
    verifiedByUserId: actor.id,
    verifiedAt: new Date(),
    notes: input.notes?.trim() ?? "",
  };

  const row = existingId
    ? await prisma.supplierCertification.update({ where: { id: existingId }, data })
    : await prisma.supplierCertification.create({ data });

  await writeAuditLog({
    userId: actor.id,
    action: existingId ? "CERTIFICATION_UPDATE" : "CERTIFICATION_CREATE",
    entityType: "SupplierCertification",
    entityId: row.id,
    after: {
      supplierId: row.supplierId,
      certType: row.certType,
      certNumber: row.certNumber,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      nextReviewDue: row.nextReviewDue?.toISOString() ?? null,
    },
    ipAddress: input.ipAddress ?? null,
  });

  return row;
}

export async function listSupplierCertifications(actor: AuthUser, supplierId: string) {
  assertAdmin(actor);
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw new AppError(404, "Supplier not found");
  return prisma.supplierCertification.findMany({
    where: { supplierId },
    include: {
      document: {
        select: { id: true, fileName: true, mimeType: true, sizeBytes: true, sha256: true },
      },
      verifiedBy: { select: { id: true, email: true } },
    },
    orderBy: [{ certType: "asc" }, { verifiedAt: "desc" }],
  });
}

export type AttachShipmentDocumentInput = {
  shipmentId: string;
  docType: ShipmentDocType;
  documentId: string;
  referenceNumber?: string | null;
  ipAddress?: string | null;
};

export async function attachShipmentDocument(
  actor: AuthUser,
  input: AttachShipmentDocumentInput,
) {
  assertCoopAdmin(actor);
  const shipment = await prisma.importShipment.findUnique({ where: { id: input.shipmentId } });
  if (!shipment) throw new AppError(404, "Shipment not found");
  if (shipment.status === ImportShipmentStatus.CANCELLED) {
    throw new AppError(409, "Cannot attach documents to a cancelled shipment");
  }
  const doc = await prisma.document.findUnique({ where: { id: input.documentId } });
  if (!doc) throw new AppError(404, "Document not found");

  const row = await prisma.shipmentDocument.create({
    data: {
      shipmentId: input.shipmentId,
      docType: input.docType,
      documentId: input.documentId,
      referenceNumber: input.referenceNumber?.trim() || null,
      uploadedByUserId: actor.id,
    },
    include: {
      document: {
        select: { id: true, fileName: true, mimeType: true, sizeBytes: true, sha256: true },
      },
    },
  });

  await writeAuditLog({
    userId: actor.id,
    storeId: shipment.destinationStoreId,
    action: AuditAction.SHIPMENT_DOCUMENT_ATTACH,
    entityType: "ShipmentDocument",
    entityId: row.id,
    after: {
      shipmentId: input.shipmentId,
      docType: input.docType,
      documentId: input.documentId,
      referenceNumber: row.referenceNumber,
    },
    ipAddress: input.ipAddress ?? null,
  });

  return row;
}

export async function listShipmentDocuments(actor: AuthUser, shipmentId: string) {
  assertAdmin(actor);
  const shipment = await prisma.importShipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new AppError(404, "Shipment not found");
  return prisma.shipmentDocument.findMany({
    where: { shipmentId },
    include: {
      document: {
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          sha256: true,
          createdAt: true,
        },
      },
      uploadedBy: { select: { id: true, email: true } },
    },
    orderBy: { uploadedAt: "desc" },
  });
}

const RECEIVED_OR_LATER: ImportShipmentStatus[] = [
  ImportShipmentStatus.RECEIVED,
  ImportShipmentStatus.COSTED,
  ImportShipmentStatus.CLOSED,
];

/** True when this document is attached to a shipment that has been received (or later). */
export async function isDocumentLockedByReceivedShipment(
  documentId: string,
): Promise<boolean> {
  const hit = await prisma.shipmentDocument.findFirst({
    where: {
      documentId,
      shipment: { status: { in: RECEIVED_OR_LATER } },
    },
    select: { id: true },
  });
  return Boolean(hit);
}

export type ExpiringCertificationRow = {
  id: string;
  supplierId: string;
  supplierName: string;
  certType: CertificationType;
  certNumber: string;
  expiresAt: string | null;
  nextReviewDue: string | null;
  reason: "EXPIRING" | "REVIEW_DUE";
  daysUntil: number;
};

/**
 * Certifications expiring within `withinDays` or with nextReviewDue within `withinDays`.
 * Surfaced on NetworkOverview.
 */
export async function listExpiringCertifications(
  actor: AuthUser,
  withinDays = 30,
  asOf = new Date(),
): Promise<ExpiringCertificationRow[]> {
  assertCoopAdmin(actor);
  return listExpiringCertificationsInternal(withinDays, asOf);
}

export async function listExpiringCertificationsInternal(
  withinDays = 30,
  asOf = new Date(),
): Promise<ExpiringCertificationRow[]> {
  const horizon = new Date(asOf.getTime() + withinDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.supplierCertification.findMany({
    where: {
      OR: [
        { expiresAt: { gte: asOf, lte: horizon } },
        { nextReviewDue: { gte: asOf, lte: horizon } },
        { expiresAt: { lt: asOf } },
        { nextReviewDue: { lt: asOf } },
      ],
    },
    include: { supplier: { select: { id: true, name: true } } },
    orderBy: [{ expiresAt: "asc" }, { nextReviewDue: "asc" }],
  });

  const out: ExpiringCertificationRow[] = [];
  for (const row of rows) {
    const dayMs = 24 * 60 * 60 * 1000;
    if (row.expiresAt) {
      const daysUntil = Math.ceil((row.expiresAt.getTime() - asOf.getTime()) / dayMs);
      if (daysUntil <= withinDays) {
        out.push({
          id: row.id,
          supplierId: row.supplier.id,
          supplierName: row.supplier.name,
          certType: row.certType,
          certNumber: row.certNumber,
          expiresAt: row.expiresAt.toISOString(),
          nextReviewDue: row.nextReviewDue?.toISOString() ?? null,
          reason: "EXPIRING",
          daysUntil,
        });
      }
    }
    if (row.nextReviewDue) {
      const daysUntil = Math.ceil((row.nextReviewDue.getTime() - asOf.getTime()) / dayMs);
      if (daysUntil <= withinDays) {
        out.push({
          id: row.id,
          supplierId: row.supplier.id,
          supplierName: row.supplier.name,
          certType: row.certType,
          certNumber: row.certNumber,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          nextReviewDue: row.nextReviewDue.toISOString(),
          reason: "REVIEW_DUE",
          daysUntil,
        });
      }
    }
  }

  out.sort((a, b) => a.daysUntil - b.daysUntil || a.supplierName.localeCompare(b.supplierName));
  return out;
}
