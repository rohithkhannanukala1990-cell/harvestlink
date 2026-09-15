/**
 * Blocks authenticated API use until seeded / provisional users change their password.
 * Attach after authMiddleware on every router except POST /auth/change-password.
 */
import type { NextFunction, Request, Response } from "express";

export function requirePasswordChanged(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.mustChangePassword) {
    res.status(403).json({
      error: "Password change required before using the API",
      code: "PASSWORD_CHANGE_REQUIRED",
    });
    return;
  }
  next();
}
