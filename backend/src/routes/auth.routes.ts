/**
 * Authentication routes for Harvestlink.
 *
 * POST /auth/login — email/password → JWT (rate-limited + account lockout).
 * POST /auth/register — COOP_ADMIN only; creates staff with password policy.
 * POST /auth/change-password — authenticated; clears mustChangePassword after success.
 * PATCH /auth/users/:id — COOP_ADMIN role / store assignment changes.
 *
 * Register is locked to COOP_ADMIN because only co-op leadership should provision accounts.
 * Sensitive auth events are written to the append-only AuditLog.
 */
import { Role } from "@prisma/client";
import bcrypt from "bcrypt";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { AuditAction, clientIp, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { assertPasswordPolicy, PASSWORD_MIN_LENGTH } from "../lib/passwordPolicy.js";
import { prisma } from "../lib/prisma.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { loginLimiter } from "../middleware/rateLimit.middleware.js";
import { requirePasswordChanged } from "../middleware/requirePasswordChanged.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";

const BCRYPT_ROUNDS = 12;
const TOKEN_EXPIRES_IN = "12h";
/** Failed attempts before lockedUntil is set. */
const MAX_FAILED_LOGINS = 5;
/** Lockout window after too many failed logins. */
const LOCKOUT_MS = 15 * 60 * 1000;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH),
  role: z.nativeEnum(Role),
  /** Required for CASHIER and STORE_ADMIN; must be null/omitted for COOP_ADMIN. */
  storeId: z.string().min(1).nullable().optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH),
});

const updateUserSchema = z
  .object({
    role: z.nativeEnum(Role).optional(),
    storeId: z.string().min(1).nullable().optional(),
  })
  .refine((body) => body.role !== undefined || body.storeId !== undefined, {
    message: "At least one of role or storeId is required",
  });

function signToken(user: {
  id: string;
  storeId: string | null;
  role: Role;
  mustChangePassword: boolean;
}): string {
  return jwt.sign(
    {
      storeId: user.storeId,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    },
    env.JWT_SECRET,
    {
      subject: user.id,
      expiresIn: TOKEN_EXPIRES_IN,
    },
  );
}

function publicUser(user: {
  id: string;
  email: string;
  storeId: string | null;
  role: Role;
  mustChangePassword: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    storeId: user.storeId,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

export const authRouter = Router();

authRouter.post("/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  const ip = clientIp(req);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login payload", details: parsed.error.flatten() });
    return;
  }

  const { email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  try {
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user) {
      await writeAuditLog(
        {
          userId: null,
          storeId: null,
          action: AuditAction.LOGIN_FAILURE,
          entityType: "Session",
          entityId: null,
          after: { email: normalizedEmail, reason: "unknown_email" },
          ipAddress: ip,
        },
        { throwOnError: false },
      );
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await writeAuditLog(
        {
          userId: user.id,
          storeId: user.storeId,
          action: AuditAction.LOGIN_FAILURE,
          entityType: "Session",
          entityId: user.id,
          after: { email: normalizedEmail, reason: "account_locked" },
          ipAddress: ip,
        },
        { throwOnError: false },
      );
      res.status(423).json({
        error: "Account locked due to repeated failed logins",
        lockedUntil: user.lockedUntil.toISOString(),
      });
      return;
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatches) {
      const attempts = user.failedLoginAttempts + 1;
      const lock = attempts >= MAX_FAILED_LOGINS;
      const lockedUntil = lock ? new Date(Date.now() + LOCKOUT_MS) : user.lockedUntil;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil,
        },
      });

      await writeAuditLog(
        {
          userId: user.id,
          storeId: user.storeId,
          action: AuditAction.LOGIN_FAILURE,
          entityType: "Session",
          entityId: user.id,
          after: {
            email: normalizedEmail,
            reason: "bad_password",
            failedLoginAttempts: attempts,
            locked: lock,
          },
          ipAddress: ip,
        },
        { throwOnError: false },
      );

      if (lock) {
        res.status(423).json({
          error: "Account locked due to repeated failed logins",
          lockedUntil: lockedUntil!.toISOString(),
        });
        return;
      }

      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const unlocked = await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    await writeAuditLog(
      {
        userId: unlocked.id,
        storeId: unlocked.storeId,
        action: AuditAction.LOGIN_SUCCESS,
        entityType: "Session",
        entityId: unlocked.id,
        after: { email: unlocked.email, role: unlocked.role },
        ipAddress: ip,
      },
      { throwOnError: false },
    );

    const token = signToken(unlocked);

    res.status(200).json({
      token,
      user: publicUser(unlocked),
    });
  } catch (error) {
    console.error("Login failed", error);
    res.status(500).json({ error: "Unable to log in" });
  }
});

authRouter.post("/change-password", authMiddleware, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid change-password payload",
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    assertPasswordPolicy(parsed.data.newPassword);

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const matches = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
    if (!matches) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    if (parsed.data.currentPassword === parsed.data.newPassword) {
      res.status(400).json({ error: "New password must differ from the current password" });
      return;
    }

    const passwordHash = await bcrypt.hash(parsed.data.newPassword, BCRYPT_ROUNDS);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    // Never log password material — only that a reset occurred.
    await writeAuditLog({
      userId: updated.id,
      storeId: updated.storeId,
      action: AuditAction.PASSWORD_CHANGE,
      entityType: "User",
      entityId: updated.id,
      before: { mustChangePassword: user.mustChangePassword },
      after: { mustChangePassword: false },
      ipAddress: clientIp(req),
    });

    const token = signToken(updated);
    res.status(200).json({
      token,
      user: publicUser(updated),
    });
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.status).json({ error: error.message, details: error.details });
      return;
    }
    console.error("Change password failed", error);
    res.status(500).json({ error: "Unable to change password" });
  }
});

authRouter.post(
  "/register",
  authMiddleware,
  requirePasswordChanged,
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid register payload", details: parsed.error.flatten() });
      return;
    }

    const { email, password, role } = parsed.data;
    const storeId = parsed.data.storeId ?? null;
    const normalizedEmail = email.toLowerCase().trim();

    try {
      assertPasswordPolicy(password);

      if (role === Role.COOP_ADMIN && storeId !== null) {
        res.status(400).json({ error: "COOP_ADMIN users must not be tied to a store" });
        return;
      }

      if (role !== Role.COOP_ADMIN && !storeId) {
        res.status(400).json({ error: "storeId is required for CASHIER and STORE_ADMIN" });
        return;
      }

      if (storeId) {
        const store = await prisma.store.findUnique({ where: { id: storeId } });

        if (!store || !store.isActive) {
          res.status(400).json({ error: "Store not found or inactive" });
          return;
        }
      }

      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });

      if (existing) {
        res.status(409).json({ error: "Email is already registered" });
        return;
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          role,
          storeId,
          mustChangePassword: false,
        },
        select: {
          id: true,
          email: true,
          storeId: true,
          role: true,
          mustChangePassword: true,
          createdAt: true,
        },
      });

      await writeAuditLog({
        userId: req.user!.id,
        storeId: user.storeId,
        action: AuditAction.USER_CREATE,
        entityType: "User",
        entityId: user.id,
        after: {
          email: user.email,
          role: user.role,
          storeId: user.storeId,
        },
        ipAddress: clientIp(req),
      });

      res.status(201).json({ user });
    } catch (error) {
      if (error instanceof AppError) {
        res.status(error.status).json({ error: error.message, details: error.details });
        return;
      }
      console.error("Register failed", error);
      res.status(500).json({ error: "Unable to register user" });
    }
  },
);

/**
 * COOP_ADMIN role / store reassignment. Audited as USER_ROLE_CHANGE.
 * Password is never changed here — use /change-password.
 */
authRouter.patch(
  "/users/:id",
  authMiddleware,
  requirePasswordChanged,
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid user update", details: parsed.error.flatten() });
      return;
    }

    try {
      const target = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!target) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const nextRole = parsed.data.role ?? target.role;
      const nextStoreId =
        parsed.data.storeId !== undefined ? parsed.data.storeId : target.storeId;

      if (nextRole === Role.COOP_ADMIN && nextStoreId !== null) {
        res.status(400).json({ error: "COOP_ADMIN users must not be tied to a store" });
        return;
      }
      if (nextRole !== Role.COOP_ADMIN && !nextStoreId) {
        res.status(400).json({ error: "storeId is required for CASHIER and STORE_ADMIN" });
        return;
      }
      if (nextStoreId) {
        const store = await prisma.store.findUnique({ where: { id: nextStoreId } });
        if (!store || !store.isActive) {
          res.status(400).json({ error: "Store not found or inactive" });
          return;
        }
      }

      const updated = await prisma.user.update({
        where: { id: target.id },
        data: {
          role: nextRole,
          storeId: nextStoreId,
        },
        select: {
          id: true,
          email: true,
          storeId: true,
          role: true,
          mustChangePassword: true,
          createdAt: true,
        },
      });

      await writeAuditLog({
        userId: req.user!.id,
        storeId: updated.storeId,
        action: AuditAction.USER_ROLE_CHANGE,
        entityType: "User",
        entityId: updated.id,
        before: { role: target.role, storeId: target.storeId, email: target.email },
        after: { role: updated.role, storeId: updated.storeId, email: updated.email },
        ipAddress: clientIp(req),
      });

      res.status(200).json({ user: updated });
    } catch (error) {
      console.error("User update failed", error);
      res.status(500).json({ error: "Unable to update user" });
    }
  },
);
