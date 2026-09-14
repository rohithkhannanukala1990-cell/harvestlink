/**
 * JWT authentication middleware for Harvestlink.
 *
 * Verifies the Bearer token and attaches { id, storeId, role } to the request.
 * This gate protects every authenticated route so handlers can trust the caller's identity:
 * for example a CASHIER can only create sales for their own store (using req.user.storeId),
 * while settlement and cross-store reporting stay behind COOP_ADMIN role checks that use
 * the same attached user object.
 */
import type { Role } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { AuthUser } from "../types/auth.js";

type JwtPayload = {
  sub: string;
  storeId: string | null;
  role: Role;
};

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = header.slice("Bearer ".length).trim();

  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    if (!decoded.sub || !decoded.role) {
      res.status(401).json({ error: "Invalid token payload" });
      return;
    }

    const user: AuthUser = {
      id: decoded.sub,
      storeId: decoded.storeId ?? null,
      role: decoded.role,
    };

    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
