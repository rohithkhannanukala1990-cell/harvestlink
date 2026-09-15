/**
 * Append-only audit log HTTP API.
 *
 * GET /audit — COOP_ADMIN only; filter by storeId, userId, action, from, to.
 *
 * There are intentionally NO update or delete routes. Financial audit trails must remain
 * immutable so "who changed this, and when?" cannot be rewritten after the fact.
 */
import { Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { AuditAction, listAuditLogs } from "../lib/audit.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";

const listQuerySchema = z.object({
  storeId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});

function parseOptionalDate(value: string | undefined, bound: "from" | "to"): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, `Invalid ${bound} date`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && bound === "to") {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Audit route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const auditRouter = Router();

auditRouter.use(authMiddleware);
auditRouter.use(requirePasswordChanged);

auditRouter.get("/", requireRole(Role.COOP_ADMIN), async (req, res) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid audit query", details: parsed.error.flatten() });
      return;
    }

    const result = await listAuditLogs({
      storeId: parsed.data.storeId,
      userId: parsed.data.userId,
      action: parsed.data.action,
      from: parseOptionalDate(parsed.data.from, "from"),
      to: parseOptionalDate(parsed.data.to, "to"),
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });

    res.status(200).json({
      ...result,
      actions: Object.values(AuditAction),
    });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * Append-only: refuse mutations. Rewriting audit history would defeat financial accountability.
 */
auditRouter.patch("*", (_req, res) => {
  res.status(405).json({
    error: "Audit log is append-only; updates and deletes are not permitted",
  });
});
auditRouter.put("*", (_req, res) => {
  res.status(405).json({
    error: "Audit log is append-only; updates and deletes are not permitted",
  });
});
auditRouter.delete("*", (_req, res) => {
  res.status(405).json({
    error: "Audit log is append-only; updates and deletes are not permitted",
  });
});
