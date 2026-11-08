/**
 * Loads and validates backend environment variables.
 * Fails fast at startup if required values are missing or invalid.
 */
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  PORT: z.coerce.number().int().positive().default(3001),
  /** Stripe secret key (sk_test_… / sk_live_…). Required to start Checkout or Terminal payments. */
  STRIPE_SECRET_KEY: z.string().optional().default(""),
  /** Webhook signing secret (whsec_…) for POST /webhooks/stripe. */
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(""),
  /** ISO currency for Stripe amounts (default usd). */
  STRIPE_CURRENCY: z.string().min(3).default("usd"),
  /** Frontend origin used for Checkout success/cancel URLs. */
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  /** Optional SMTP for receipt emails (when unset, emails are logged only). */
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  SMTP_FROM: z.string().optional().default(""),
  /** local = disk under STORAGE_LOCAL_DIR; s3 = S3-compatible bucket. */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  /** Directory for local document storage (dev). */
  STORAGE_LOCAL_DIR: z.string().default("./uploads"),
  S3_ENDPOINT: z.string().optional().default(""),
  S3_REGION: z.string().optional().default("us-east-1"),
  S3_BUCKET: z.string().optional().default(""),
  S3_ACCESS_KEY_ID: z.string().optional().default(""),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(""),
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = parsed.data;
