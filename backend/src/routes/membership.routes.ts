/**
 * Membership HTTP routes for Harvestlink.
 *
 * Members are co-op-wide. GET /members/:memberNumber is the POS hot path — cashiers
 * look up a card during live checkout, so that handler only does an indexed findUnique
 * via the service (see schema index on Member.memberNumber).
 *
 * Route order matters: /:id/purchase-history is registered before /:memberNumber so
 * Express does not treat "purchase-history" as a member number segment incorrectly.
 */
import { MemberTier, Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as membershipService from "../services/membership.service.js";

const createMemberSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  tier: z.nativeEnum(MemberTier).optional(),
  expiresAt: z.string().min(1).optional(),
});

const updateMemberSchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    tier: z.nativeEnum(MemberTier).optional(),
    expiresAt: z.string().min(1).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

const listQuerySchema = z.object({
  q: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

const historyQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

function parseExpiresAt(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, "Invalid expiresAt");
  }
  return date;
}

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  console.error("Membership route error", error);
  res.status(500).json({ error: "Internal server error" });
}

export const membershipRouter = Router();

membershipRouter.use(authMiddleware);

membershipRouter.get(
  "/",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid members query", details: parsed.error.flatten() });
        return;
      }

      const result = await membershipService.listMembers({
        q: parsed.data.q,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      });
      res.status(200).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = createMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid member payload", details: parsed.error.flatten() });
        return;
      }

      const member = await membershipService.createMember({
        name: parsed.data.name,
        email: parsed.data.email,
        tier: parsed.data.tier,
        expiresAt: parseExpiresAt(parsed.data.expiresAt),
      });
      res.status(201).json({ member });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.get(
  "/:id/purchase-history",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = historyQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid history query", details: parsed.error.flatten() });
        return;
      }

      const result = await membershipService.getPurchaseHistory(
        req.params.id,
        parsed.data.page,
        parsed.data.pageSize,
      );
      res.status(200).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.patch(
  "/:id",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = updateMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid member update", details: parsed.error.flatten() });
        return;
      }

      const member = await membershipService.updateMember(req.params.id, {
        name: parsed.data.name,
        email: parsed.data.email,
        tier: parsed.data.tier,
        expiresAt: parseExpiresAt(parsed.data.expiresAt),
      });
      res.status(200).json({ member });
    } catch (error) {
      handleError(res, error);
    }
  },
);

/**
 * POS card lookup — registered after purchase-history so path specificity stays correct.
 * Intentionally available to cashiers: checkout must resolve memberNumber in real time.
 */
membershipRouter.get(
  "/:memberNumber",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const member = await membershipService.getMemberByNumber(req.params.memberNumber);
      res.status(200).json({ member });
    } catch (error) {
      handleError(res, error);
    }
  },
);
