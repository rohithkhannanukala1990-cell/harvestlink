/**
 * Append-only audit trail for Harvestlink financial / security events.
 *
 * WHY APPEND-ONLY (no update / delete API):
 * Financial systems must answer "who changed this, and when?" without the trail itself
 * being rewritten. Updates or deletes would let an attacker (or buggy admin tool) erase
 * evidence of operatorPercent changes, payouts, refunds, or failed logins. Application
 * code therefore only INSERTs. There are intentionally no PATCH/DELETE /audit endpoints.
 * DB roles for the app user should also lack UPDATE/DELETE on AuditLog in production.
 */
import { Prisma } from "@prisma/client";
import type { Request } from "express";
import { AppError } from "./errors.js";
import { prisma } from "./prisma.js";

export const AuditAction = {
  STORE_OPERATOR_PERCENT_CHANGE: "STORE_OPERATOR_PERCENT_CHANGE",
  STOCK_ADJUSTMENT: "STOCK_ADJUSTMENT",
  PAYOUT_CREATE: "PAYOUT_CREATE",
  SALE_REFUND: "SALE_REFUND",
  SALE_MANUAL_DISCOUNT: "SALE_MANUAL_DISCOUNT",
  CASH_DRAWER_OPEN: "CASH_DRAWER_OPEN",
  CASH_DRAWER_CLOSE: "CASH_DRAWER_CLOSE",
  PO_SUBMIT: "PO_SUBMIT",
  PO_RECEIVE: "PO_RECEIVE",
  PO_CANCEL: "PO_CANCEL",
  PRODUCT_COST_CHANGE: "PRODUCT_COST_CHANGE",
  MEMBER_APPROVE: "MEMBER_APPROVE",
  MEMBER_WITHDRAW_REQUEST: "MEMBER_WITHDRAW_REQUEST",
  MEMBER_WITHDRAW_FINALIZE: "MEMBER_WITHDRAW_FINALIZE",
  CAPITAL_CONTRIBUTION: "CAPITAL_CONTRIBUTION",
  CAPITAL_REFUND: "CAPITAL_REFUND",
  USER_CREATE: "USER_CREATE",
  USER_ROLE_CHANGE: "USER_ROLE_CHANGE",
  PASSWORD_CHANGE: "PASSWORD_CHANGE",
  LOGIN_SUCCESS: "LOGIN_SUCCESS",
  LOGIN_FAILURE: "LOGIN_FAILURE",
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export type WriteAuditInput = {
  userId?: string | null;
  storeId?: string | null;
  action: AuditActionName | string;
  entityType: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  ipAddress?: string | null;
};

type DbClient = Prisma.TransactionClient | typeof prisma;

/** Best-effort client IP for audit rows (honors X-Forwarded-For when present). */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() || null;
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(",")[0]?.trim() || null;
  }
  return req.ip ?? req.socket.remoteAddress ?? null;
}

/**
 * Inserts one audit row. Never updates or deletes existing rows.
 * Failures are logged and rethrown when `throwOnError` is true (default for money paths);
 * login failure logging uses throwOnError=false so auth UX is not blocked by audit outages.
 */
export async function writeAuditLog(
  input: WriteAuditInput,
  options?: { tx?: DbClient; throwOnError?: boolean },
): Promise<void> {
  const db = options?.tx ?? prisma;
  const throwOnError = options?.throwOnError !== false;

  try {
    await db.auditLog.create({
      data: {
        userId: input.userId ?? null,
        storeId: input.storeId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        ...(input.before !== undefined && input.before !== null
          ? { before: input.before }
          : input.before === null
            ? { before: Prisma.JsonNull }
            : {}),
        ...(input.after !== undefined && input.after !== null
          ? { after: input.after }
          : input.after === null
            ? { after: Prisma.JsonNull }
            : {}),
        ipAddress: input.ipAddress ?? null,
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "AUDIT_WRITE_FAILED",
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      }),
    );
    if (throwOnError) {
      throw error;
    }
  }
}

export type ListAuditFilters = {
  storeId?: string;
  userId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
};

export async function listAuditLogs(filters: ListAuditFilters) {
  const where: Prisma.AuditLogWhereInput = {};

  if (filters.storeId) {
    where.storeId = filters.storeId;
  }
  if (filters.userId) {
    where.userId = filters.userId;
  }
  if (filters.action) {
    where.action = filters.action;
  }
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) {
      where.createdAt.gte = filters.from;
    }
    if (filters.to) {
      where.createdAt.lte = filters.to;
    }
  }

  const skip = (filters.page - 1) * filters.pageSize;

  const [total, logs] = await prisma.$transaction([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: filters.pageSize,
    }),
  ]);

  return {
    logs,
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / filters.pageSize),
  };
}

/** Reject any attempt to mutate audit rows through application code. */
export function assertAuditAppendOnly(): never {
  throw new AppError(
    405,
    "Audit log is append-only; updates and deletes are not permitted",
  );
}
