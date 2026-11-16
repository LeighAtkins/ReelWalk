import { defineConfig, devices } from "@playwright/test";

// Explicit opt-in: this suite creates local reels/media through real app actions.
// The ordinary suite and its Instagram setup remain unchanged.
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) {
  throw new Error("Mobile workspace E2E requires an explicit localhost E2E_BASE_URL and an isolated local database/storage stack.");
}
if (process.env.E2E_LOCAL_STACK_VERIFIED !== "1") {
  throw new Error("Verify the app uses only local test DB/storage/queue, has no provider credentials and AI is disabled; then set E2E_LOCAL_STACK_VERIFIED=1.");
}
if (!process.env.E2E_VIDEO_ASSET_ID) throw new Error("E2E_VIDEO_ASSET_ID must identify a verified demo-owned local walkthrough.mp4 fixture (540x960, 2 seconds).");

export default defineConfig({
  testDir: "./tests",
  testMatch: "mobile-workspace.spec.ts",
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL, ...devices["Pixel 7"], channel: process.env.E2E_BROWSER_CHANNEL, actionTimeout: 30_000, trace: "retain-on-failure", serviceWorkers: "block" },
  projects: [
    { name: "workspace-390", use: { viewport: { width: 390, height: 844 } } },
    { name: "workspace-360", use: { viewport: { width: 360, height: 740 } } },
  ],
});
