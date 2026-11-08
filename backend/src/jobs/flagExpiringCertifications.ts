/**
 * Daily job: flag supplier certifications expiring / reviews due within 30 days.
 *
 * Writes one CERT_EXPIRING or CERT_REVIEW_DUE audit row per certification per UTC day
 * so NetworkOverview (and the audit trail) surface upcoming compliance work.
 * Follows the same pattern as flagUndepositedCash.ts.
 */
import cron from "node-cron";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { listExpiringCertificationsInternal } from "../services/compliance.service.js";

let started = false;

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function runFlagExpiringCertificationsOnce(now = new Date()): Promise<{
  flaggedIds: string[];
  alreadyFlaggedToday: string[];
}> {
  const rows = await listExpiringCertificationsInternal(30, now);
  const flaggedIds: string[] = [];
  const alreadyFlaggedToday: string[] = [];

  for (const row of rows) {
    const action =
      row.reason === "EXPIRING" ? AuditAction.CERT_EXPIRING : AuditAction.CERT_REVIEW_DUE;
    try {
      const existing = await prisma.auditLog.findFirst({
        where: {
          action,
          entityType: "SupplierCertification",
          entityId: row.id,
          createdAt: { gte: utcDayStart(now) },
        },
        select: { id: true },
      });
      if (existing) {
        alreadyFlaggedToday.push(row.id);
        continue;
      }

      await writeAuditLog({
        userId: null,
        action,
        entityType: "SupplierCertification",
        entityId: row.id,
        after: {
          supplierId: row.supplierId,
          supplierName: row.supplierName,
          certType: row.certType,
          certNumber: row.certNumber,
          expiresAt: row.expiresAt,
          nextReviewDue: row.nextReviewDue,
          daysUntil: row.daysUntil,
          reason: row.reason,
        },
      });

      flaggedIds.push(row.id);
      console.log(
        JSON.stringify({
          type: action,
          certificationId: row.id,
          supplierId: row.supplierId,
          supplierName: row.supplierName,
          certType: row.certType,
          daysUntil: row.daysUntil,
          at: new Date().toISOString(),
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "CERT_FLAG_ERROR",
          certificationId: row.id,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        }),
      );
    }
  }

  return { flaggedIds, alreadyFlaggedToday };
}

/**
 * Starts the daily expiring-certifications cron. Safe to call once from index.ts.
 */
export function startFlagExpiringCertificationsJob(): void {
  if (started) {
    return;
  }
  started = true;

  // Daily at 06:40 — after undeposited-cash flag, before cycle counts.
  cron.schedule("40 6 * * *", () => {
    void runFlagExpiringCertificationsOnce().then(({ flaggedIds }) => {
      if (flaggedIds.length) {
        console.log(`flagExpiringCertifications: flagged=${flaggedIds.length}`);
      }
    });
  });

  console.log("Scheduled flagExpiringCertifications job (daily at 06:40)");
}
