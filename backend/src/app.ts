/**
 * Express application factory for Harvestlink.
 * Used by the server entrypoint and by Vitest (without binding a port or starting cron).
 */
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { authRouter } from "./routes/auth.routes.js";
import { auditRouter } from "./routes/audit.routes.js";
import { drawerRouter } from "./routes/drawer.routes.js";
import { inventoryRouter } from "./routes/inventory.routes.js";
import { lotsRouter } from "./routes/lots.routes.js";
import { membershipRouter } from "./routes/membership.routes.js";
import { reportsRouter } from "./routes/reports.routes.js";
import { purchasingRouter } from "./routes/purchasing.routes.js";
import { recallRouter } from "./routes/recall.routes.js";
import { salesRouter } from "./routes/sales.routes.js";
import { settlementRouter } from "./routes/settlement.routes.js";
import { storesRouter } from "./routes/stores.routes.js";
import { stripeWebhookHandler } from "./routes/stripe.webhook.js";
import { traceabilityRouter } from "./routes/traceability.routes.js";
import { globalApiLimiter } from "./middleware/rateLimit.middleware.js";

export function createApp(): Express {
  const app = express();

  app.use(helmet());

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        // localhost and 127.0.0.1 are different origins to the browser.
        const allowed = new Set([
          env.FRONTEND_URL,
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          "http://localhost:4173",
          "http://127.0.0.1:4173",
        ]);
        if (allowed.has(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    }),
  );

  // Stripe signature verification requires the exact raw bytes — mount BEFORE json().
  app.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json" }),
    (req, res) => {
      void stripeWebhookHandler(req, res);
    },
  );

  app.use(express.json());
  app.use(globalApiLimiter);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/auth", authRouter);
  app.use("/audit", auditRouter);
  app.use("/products", inventoryRouter);
  app.use("/inventory", inventoryRouter);
  app.use("/lots", lotsRouter);
  app.use("/sales", salesRouter);
  app.use("/members", membershipRouter);
  app.use("/settlement", settlementRouter);
  app.use("/stores", storesRouter);
  app.use("/drawer", drawerRouter);
  app.use("/reports", reportsRouter);
  app.use("/purchasing", purchasingRouter);
  app.use("/traceability", traceabilityRouter);
  app.use("/recalls", recallRouter);

  return app;
}
