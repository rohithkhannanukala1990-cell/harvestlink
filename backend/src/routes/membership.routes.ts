/**
 * Membership HTTP routes — co-op owners (equity), not subscription tiers.
 *
 * Capital contribution endpoints live here intentionally so equity money never
 * enters /sales or /settlement. POS lookup checks status=ACTIVE (no expiry).
 */
import {
  DividendAllocationMethod,
  MemberStatus,
  Role,
} from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { clientIp } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";
import * as membershipService from "../services/membership.service.js";

const createMemberSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  mailingAddress: z.string().optional(),
  membershipClassId: z.string().min(1),
  taxIdLast4: z.string().min(4).max(11).optional(),
  householdPrimaryMemberId: z.string().nullable().optional(),
  activate: z.boolean().optional(),
});

const updateMemberSchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    mailingAddress: z.string().optional(),
    membershipClassId: z.string().min(1).optional(),
    taxIdLast4: z.string().min(4).max(11).nullable().optional(),
    householdPrimaryMemberId: z.string().nullable().optional(),
    isEligibleToVote: z.boolean().optional(),
    status: z.nativeEnum(MemberStatus).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

const listQuerySchema = z.object({
  q: z.string().optional(),
  status: z.nativeEnum(MemberStatus).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

const historyQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

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
membershipRouter.use(requirePasswordChanged);

// ── Classes ──

membershipRouter.get(
  "/classes",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const classes = await membershipService.listMembershipClasses(req.query.active === "true");
      res.status(200).json({ classes });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/classes",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = z
        .object({
          name: z.string().min(1),
          contributionAmount: z.number().positive(),
          dividendWeight: z.number().positive().optional(),
          description: z.string().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid class", details: parsed.error.flatten() });
        return;
      }
      const membershipClass = await membershipService.createMembershipClass(
        req.user!,
        parsed.data,
      );
      res.status(201).json({ membershipClass });
    } catch (error) {
      handleError(res, error);
    }
  },
);

// ── Members list / create ──

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
      const result = await membershipService.listMembers(parsed.data);
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
      const member = await membershipService.createMember(req.user!, parsed.data);
      res.status(201).json({ member });
    } catch (error) {
      handleError(res, error);
    }
  },
);

// ── Equity / board / ballots (static paths before :id) ──

membershipRouter.post(
  "/contributions",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = z
        .object({
          memberId: z.string().min(1),
          amount: z.number().positive(),
          markPaid: z.boolean().optional(),
          stripePaymentIntentId: z.string().nullable().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid contribution", details: parsed.error.flatten() });
        return;
      }
      const contribution = await membershipService.recordCapitalContribution(req.user!, {
        ...parsed.data,
        ipAddress: clientIp(req),
      });
      res.status(201).json({ contribution });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/contributions/:id/mark-paid",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const contribution = await membershipService.markContributionPaid(
        req.user!,
        req.params.id!,
        clientIp(req),
      );
      res.status(200).json({ contribution });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/contributions/:id/refund",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const contribution = await membershipService.refundCapitalContribution(
        req.user!,
        req.params.id!,
        clientIp(req),
      );
      res.status(200).json({ contribution });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/board-resolutions",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = z
        .object({
          title: z.string().min(1),
          description: z.string().optional(),
          minutesUrl: z.string().url().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid resolution", details: parsed.error.flatten() });
        return;
      }
      const resolution = await membershipService.createBoardResolution(req.user!, parsed.data);
      res.status(201).json({ resolution });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/board-resolutions/:id/pass",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const resolution = await membershipService.passBoardResolution(req.user!, req.params.id!);
      res.status(200).json({ resolution });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/dividends",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = z
        .object({
          boardResolutionId: z.string().min(1),
          fiscalYear: z.number().int(),
          totalPoolAmount: z.number().positive(),
          allocationMethod: z.nativeEnum(DividendAllocationMethod),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid dividend", details: parsed.error.flatten() });
        return;
      }
      const dividend = await membershipService.declareDividend(req.user!, parsed.data);
      res.status(201).json({ dividend });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/dividends/:id/allocate",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const dividend = await membershipService.allocateDividend(req.user!, req.params.id!);
      res.status(200).json({ dividend });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/ballots",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = z
        .object({
          title: z.string().min(1),
          description: z.string().optional(),
          options: z.array(z.string().min(1)).min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid ballot", details: parsed.error.flatten() });
        return;
      }
      const ballot = await membershipService.createBallot(req.user!, parsed.data);
      res.status(201).json({ ballot });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/ballots/:ballotId/vote",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const parsed = z
        .object({
          memberId: z.string().min(1),
          ballotOptionId: z.string().min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid vote", details: parsed.error.flatten() });
        return;
      }
      const vote = await membershipService.castVote({
        ballotId: req.params.ballotId!,
        ...parsed.data,
      });
      res.status(201).json({ vote });
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
        req.params.id!,
        parsed.data.page,
        parsed.data.pageSize,
      );
      res.status(200).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/:id/approve",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const member = await membershipService.approveMember(
        req.user!,
        req.params.id!,
        clientIp(req),
      );
      res.status(200).json({ member });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/:id/withdraw-request",
  requireRole(Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const member = await membershipService.requestWithdrawal(
        req.user!,
        req.params.id!,
        clientIp(req),
      );
      res.status(200).json({ member });
    } catch (error) {
      handleError(res, error);
    }
  },
);

membershipRouter.post(
  "/:id/withdraw-finalize",
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const member = await membershipService.finalizeWithdrawal(
        req.user!,
        req.params.id!,
        clientIp(req),
      );
      res.status(200).json({ member });
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
      const member = await membershipService.updateMember(req.user!, req.params.id!, parsed.data);
      res.status(200).json({ member });
    } catch (error) {
      handleError(res, error);
    }
  },
);

/**
 * POS card lookup — registered last among :param routes.
 * Memberships NEVER expire; cashiers should treat non-ACTIVE as ineligible at sale time.
 */
membershipRouter.get(
  "/:memberNumber",
  requireRole(Role.CASHIER, Role.STORE_ADMIN, Role.COOP_ADMIN),
  async (req, res) => {
    try {
      const member = await membershipService.getMemberByNumber(req.params.memberNumber!);
      res.status(200).json({ member });
    } catch (error) {
      handleError(res, error);
    }
  },
);
