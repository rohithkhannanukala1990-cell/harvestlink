/**
 * Starts a Postgres for Vitest: prefers DATABASE_URL_TEST, else Testcontainers.
 * Runs prisma migrate deploy against that database before any test file loads.
 *
 * NOTE: Vitest globalSetup runs in a separate process — we `provide` the URL so
 * setupFiles can inject it before Prisma/env modules load.
 */
import { execSync } from "node:child_process";
import type { GlobalSetupContext } from "vitest/node";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

let container: StartedPostgreSqlContainer | undefined;

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-harvestlink-ci";
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "sk_test_harvestlink";
  process.env.STRIPE_WEBHOOK_SECRET =
    process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_harvestlink_webhook";
  process.env.STRIPE_CURRENCY = process.env.STRIPE_CURRENCY ?? "usd";
  process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

  let databaseUrl = process.env.DATABASE_URL_TEST?.trim();

  if (!databaseUrl) {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("harvestlink_test")
      .withUsername("harvestlink")
      .withPassword("harvestlink")
      .start();
    databaseUrl = container.getConnectionUri();
  }

  process.env.DATABASE_URL = databaseUrl;
  provide("DATABASE_URL", databaseUrl);

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
    cwd: process.cwd(),
  });

  return async () => {
    if (container) {
      await container.stop();
    }
  };
}
