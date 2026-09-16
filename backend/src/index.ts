/**
 * Express application entry point for the Harvestlink backend API.
 * Creates the app, binds the port, and starts background reconciliation jobs.
 */
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { startExpireLotsJob } from "./jobs/expireLots.js";
import { startExpirePendingSalesJob } from "./jobs/expirePendingSales.js";
import { startReconcileRefundingSalesJob } from "./jobs/reconcileRefundingSales.js";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`Harvestlink API listening on http://localhost:${env.PORT}`);
  startExpirePendingSalesJob();
  startReconcileRefundingSalesJob();
  startExpireLotsJob();
});