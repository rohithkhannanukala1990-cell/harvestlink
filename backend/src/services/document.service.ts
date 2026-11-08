/**
 * Document upload / download / delete — wraps lib/storage and the Document model.
 * Downloads are never public; callers must authorize via routes.
 */
import { Role, type Document } from "@prisma/client";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import {
  deleteObject,
  getObject,
  putObject,
  type AllowedDocumentMimeType,
} from "../lib/storage.js";
import { isDocumentLockedByReceivedShipment } from "./compliance.service.js";
import type { AuthUser } from "../types/auth.js";

function assertAdmin(actor: AuthUser): void {
  if (actor.role !== Role.STORE_ADMIN && actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Cashiers cannot manage documents");
  }
}

function assertCoopAdmin(actor: AuthUser): void {
  if (actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only COOP_ADMIN may delete documents");
  }
}

export async function uploadDocument(
  actor: AuthUser,
  input: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    ipAddress?: string | null;
  },
): Promise<Document> {
  assertAdmin(actor);
  const stored = await putObject({
    buffer: input.buffer,
    fileName: input.fileName,
    mimeType: input.mimeType,
  });

  const doc = await prisma.document.create({
    data: {
      storageKey: stored.storageKey,
      fileName: input.fileName.trim() || "document",
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      uploadedByUserId: actor.id,
    },
  });

  await writeAuditLog({
    userId: actor.id,
    action: AuditAction.DOCUMENT_UPLOAD,
    entityType: "Document",
    entityId: doc.id,
    after: {
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      sha256: doc.sha256,
    },
    ipAddress: input.ipAddress ?? null,
  });

  return doc;
}

export async function getDocumentMeta(actor: AuthUser, id: string): Promise<Document> {
  assertAdmin(actor);
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) throw new AppError(404, "Document not found");
  return doc;
}

/**
 * Open a download stream. Role already checked by route (STORE_ADMIN / COOP_ADMIN).
 * Meta mimeType/size come from the DB row (authoritative); storage body is streamed.
 */
export async function openDocumentDownload(actor: AuthUser, id: string) {
  assertAdmin(actor);
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) throw new AppError(404, "Document not found");
  const object = await getObject(doc.storageKey);
  return {
    document: doc,
    body: object.body,
    mimeType: doc.mimeType as AllowedDocumentMimeType,
    sizeBytes: doc.sizeBytes,
    fileName: doc.fileName,
  };
}

/**
 * Delete a document and its storage object.
 * Forbidden once attached to a received (or later) shipment.
 */
export async function deleteDocument(
  actor: AuthUser,
  id: string,
  ipAddress?: string | null,
): Promise<void> {
  assertCoopAdmin(actor);
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) throw new AppError(404, "Document not found");

  if (await isDocumentLockedByReceivedShipment(id)) {
    throw new AppError(
      409,
      "Document is attached to a received shipment and cannot be deleted",
      { documentId: id },
    );
  }

  // Detach from certifications / non-received shipment docs first if needed —
  // ShipmentDocument has onDelete Restrict, so remove unlockable links.
  await prisma.$transaction(async (tx) => {
    await tx.supplierCertification.updateMany({
      where: { documentId: id },
      data: { documentId: null },
    });
    await tx.shipmentDocument.deleteMany({ where: { documentId: id } });
    await tx.document.delete({ where: { id } });
  });

  await deleteObject(doc.storageKey);

  await writeAuditLog({
    userId: actor.id,
    action: AuditAction.DOCUMENT_DELETE,
    entityType: "Document",
    entityId: id,
    before: {
      fileName: doc.fileName,
      sha256: doc.sha256,
      storageKey: doc.storageKey,
    },
    ipAddress: ipAddress ?? null,
  });
}
