/**
 * Role-guard middleware factory for Harvestlink.
 *
 * Usage: requireRole("COOP_ADMIN") — rejects callers who lack one of the allowed roles.
 *
 * Why this exists:
 * - Only a COOP_ADMIN can register users, view settlement data across all stores, and
 *   record operator payouts from the co-op account.
 * - A STORE_ADMIN may manage inventory and staff for their own store, but not co-op-wide
 *   settlement.
 * - A CASHIER can only create sales for their own store and must not access admin or
 *   settlement endpoints.
 *
 * Always run after authMiddleware so req.user is present.
 */
import type { Role } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";

export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: "Insufficient role",
        required: allowedRoles,
        actual: req.user.role,
      });
      return;
    }

    next();
  };
}
