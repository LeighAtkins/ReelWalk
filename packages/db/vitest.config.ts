import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The concurrency tests (outbox relays, duplicate Stripe deliveries, credit races) open more
    // simultaneous transactions than production's per-process pool of 5, and starve on busy runners.
    env: { DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? "20" },
    testTimeout: 15_000,
  },
});
