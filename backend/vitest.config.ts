/**
 * Vitest configuration for Harvestlink backend money-path tests.
 * Single fork so the Testcontainers / DATABASE_URL_TEST Prisma client is shared.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    globalSetup: ["./tests/globalSetup.ts"],
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
