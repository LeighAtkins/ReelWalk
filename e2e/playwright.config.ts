import { defineConfig, devices } from "@playwright/test";

// Runs against an already running stack: docker compose (default) or the
// kind cluster with E2E_BASE_URL=http://localhost:8081.
export default defineConfig({
  testDir: "./tests",
  // Real renders are slow, and the retry test waits out three failed attempts.
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // Two browsers at a time. With five, requests from the Windows host into
  // Docker Desktop stalled in exact 10 s steps (even straight to MinIO, so not
  // the app); Linux CI is not affected. Override with E2E_WORKERS.
  workers: Number(process.env.E2E_WORKERS ?? 2),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    trace: "retain-on-failure",
  },
  // The editor is built for phones, so the suite runs on a phone-sized viewport.
  projects: [{ name: "mobile", use: { ...devices["Pixel 7"] } }],
});
