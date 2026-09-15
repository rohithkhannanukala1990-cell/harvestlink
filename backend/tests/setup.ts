/**
 * Per-worker Vitest setup: point Prisma at the test DB and install Stripe mocks
 * before application modules are imported by test files.
 */
import { beforeAll, beforeEach, inject, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-harvestlink-ci";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "sk_test_harvestlink";
process.env.STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_harvestlink_webhook";
process.env.STRIPE_CURRENCY = process.env.STRIPE_CURRENCY ?? "usd";
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

// Prefer injected Testcontainers / DATABASE_URL_TEST from globalSetup (never the .env app DB).
const injectedUrl = inject("DATABASE_URL");
if (typeof injectedUrl === "string" && injectedUrl.length > 0) {
  process.env.DATABASE_URL = injectedUrl;
} else if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

vi.mock("../src/lib/stripe.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/stripe.js")>("../src/lib/stripe.js");
  const { mockStripeModule } = await import("./helpers/stripeMock.js");
  return {
    ...actual,
    getStripe: () => mockStripeModule.getStripe(),
    constructStripeEvent: (rawBody: Buffer, signature: string) =>
      mockStripeModule.constructStripeEvent(rawBody, signature),
  };
});

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set — globalSetup must provide a test database");
  }
});

beforeEach(async () => {
  const { resetStripeMocks } = await import("./helpers/stripeMock.js");
  resetStripeMocks();
  const { truncateAll } = await import("./helpers/db.js");
  await truncateAll();
});
