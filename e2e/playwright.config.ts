import { defineConfig } from "@playwright/test";

// Runs against an already running stack: docker compose (default) or the
// kind cluster with E2E_BASE_URL=http://localhost:8081.
export default defineConfig({
  testDir: "./tests",
  // Real renders are slow, and the retry test waits out three failed attempts.
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
