/**
 * HTTP rate limiters for Harvestlink.
 * Login is tightly capped per IP+email; the rest of the API gets a looser per-IP budget.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/** Loose global API budget (per IP). Applied after JSON parsing; webhook is mounted earlier. */
export const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests; try again later" },
});

/**
 * Strict login limiter: 5 attempts / 15 minutes per IP + email.
 * Requires express.json() so req.body.email is available.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts; try again in 15 minutes" },
  keyGenerator: (req) => {
    const email =
      typeof req.body?.email === "string" ? req.body.email.toLowerCase().trim() : "unknown";
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    return `${ipKeyGenerator(ip)}:${email}`;
  },
});
