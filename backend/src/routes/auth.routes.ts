/**
 * Authentication routes for Harvestlink.
 *
 * POST /auth/login — any existing user exchanges email/password for a JWT.
 * POST /auth/register — COOP_ADMIN only; creates staff (or another admin) for a store/role.
 *
 * Register is deliberately locked to COOP_ADMIN because only co-op leadership should
 * provision cashiers and store admins. A CASHIER must not create accounts, and a
 * STORE_ADMIN should not grant co-op-wide privileges. Login issues a token that later
 * middleware uses so cashiers stay limited to their store's sales while COOP_ADMINs
 * can reach settlement and cross-store operations.
 */
import { Role } from "@prisma/client";
import bcrypt from "bcrypt";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/requireRole.middleware.js";

const BCRYPT_ROUNDS = 12;
const TOKEN_EXPIRES_IN = "12h";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.nativeEnum(Role),
  /** Required for CASHIER and STORE_ADMIN; must be null/omitted for COOP_ADMIN. */
  storeId: z.string().min(1).nullable().optional(),
});

function signToken(user: { id: string; storeId: string | null; role: Role }): string {
  return jwt.sign(
    {
      storeId: user.storeId,
      role: user.role,
    },
    env.JWT_SECRET,
    {
      subject: user.id,
      expiresIn: TOKEN_EXPIRES_IN,
    },
  );
}

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login payload", details: parsed.error.flatten() });
    return;
  }

  const { email, password } = parsed.data;

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatches) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const token = signToken(user);

    res.status(200).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        storeId: user.storeId,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login failed", error);
    res.status(500).json({ error: "Unable to log in" });
  }
});

authRouter.post(
  "/register",
  authMiddleware,
  requireRole(Role.COOP_ADMIN),
  async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid register payload", details: parsed.error.flatten() });
      return;
    }

    const { email, password, role } = parsed.data;
    const storeId = parsed.data.storeId ?? null;

    if (role === Role.COOP_ADMIN && storeId !== null) {
      res.status(400).json({ error: "COOP_ADMIN users must not be tied to a store" });
      return;
    }

    if (role !== Role.COOP_ADMIN && !storeId) {
      res.status(400).json({ error: "storeId is required for CASHIER and STORE_ADMIN" });
      return;
    }

    try {
      if (storeId) {
        const store = await prisma.store.findUnique({ where: { id: storeId } });

        if (!store || !store.isActive) {
          res.status(400).json({ error: "Store not found or inactive" });
          return;
        }
      }

      const existing = await prisma.user.findUnique({ where: { email } });

      if (existing) {
        res.status(409).json({ error: "Email is already registered" });
        return;
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          role,
          storeId,
        },
        select: {
          id: true,
          email: true,
          storeId: true,
          role: true,
          createdAt: true,
        },
      });

      res.status(201).json({ user });
    } catch (error) {
      console.error("Register failed", error);
      res.status(500).json({ error: "Unable to register user" });
    }
  },
);
