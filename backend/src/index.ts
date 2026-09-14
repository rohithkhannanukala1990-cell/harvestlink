/**
 * Express application entry point for the Harvestlink backend API.
 * Mounts auth, inventory, sales (Stripe Checkout + Terminal), membership, settlement,
 * and the Stripe webhook (raw body) used to finalize PAID sales / stock.
 *
 * Stripe card funds → co-op Stripe account. Operator payables → internal /settlement ledger.
 */
import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { authRouter } from "./routes/auth.routes.js";
import { inventoryRouter } from "./routes/inventory.routes.js";
import { membershipRouter } from "./routes/membership.routes.js";
import { salesRouter } from "./routes/sales.routes.js";
import { settlementRouter } from "./routes/settlement.routes.js";
import { storesRouter } from "./routes/stores.routes.js";
import { stripeWebhookHandler } from "./routes/stripe.webhook.js";

const app = express();

app.use(cors());

// Stripe signature verification requires the exact raw bytes — mount before json().
app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req, res) => {
    void stripeWebhookHandler(req, res);
  },
);

app.use(express.json());

/** Liveness probe used by local tooling and future deploy health checks. */
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/auth", authRouter);
app.use("/products", inventoryRouter);
app.use("/sales", salesRouter);
app.use("/members", membershipRouter);
app.use("/settlement", settlementRouter);
app.use("/stores", storesRouter);

app.listen(env.PORT, () => {
  console.log(`Harvestlink API listening on http://localhost:${env.PORT}`);
});
