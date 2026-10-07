/**
 * Production smoke test: creates a throwaway studio on a live deployment,
 * uploads two fixtures, exports the reel through the real queue and worker,
 * and opens the share link as a guest. No demo account needed.
 *
 *   SMOKE_BASE_URL=https://reelwalking.com apps/worker/node_modules/.bin/tsx e2e/smoke.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "@playwright/test";

const base = process.env.SMOKE_BASE_URL ?? "https://reelwalking.com";
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const email = `smoke-${Date.now()}@example.com`;
const password = "smoke-test-pass-1";

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: base });
const page = await context.newPage();
const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

try {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Smoke Test");
  await page.getByLabel(/Studio or business name/).fill("Smoke Studio");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Create studio" }).click();
  await page.waitForURL(/\/\?welcome=1$/, { timeout: 30_000 });
  log(`signed up as ${email}`);

  await page.getByTestId("new-reel-input").setInputFiles(["exterior.jpg", "walkthrough.mp4"].map((f) => path.join(fixtures, f)));
  await page.waitForURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
  await page.getByTestId("clip").nth(1).waitFor({ timeout: 120_000 });
  await page.getByTestId("save-state").filter({ has: page.locator('[data-status="saved"]') }).or(page.locator('[data-testid="save-state"][data-status="saved"]')).first().waitFor({ timeout: 60_000 });
  log("uploaded 2 clips straight to S3 and saved");

  await page.getByTestId("export-button").click();
  await page.getByTestId("confirm-export").click();
  await page.waitForURL(/\/export$/, { timeout: 30_000 });
  log("export queued; waiting for the worker");
  await page.locator('[data-testid="export"][data-status="SUCCEEDED"]').waitFor({ timeout: 10 * 60_000 });
  log("render SUCCEEDED");

  const src = await page.getByTestId("export-video").getAttribute("src");
  const video = await page.request.get(src!);
  log(`video ${video.status()} ${video.headers()["content-type"]} ${(await video.body()).byteLength} bytes from ${new URL(src!).host}`);

  await page.getByTestId("share-link").click();
  const shareUrl = await page.getByTestId("share-link-url").getAttribute("href");
  const guest = await browser.newContext({ ...devices["Pixel 7"] });
  const guestPage = await guest.newPage();
  await guestPage.goto(shareUrl!);
  await guestPage.getByTestId("shared-video").waitFor({ timeout: 30_000 });
  log(`share link works for a guest: ${shareUrl}`);
  await guest.close();

  await page.goto("/account");
  log("account page: " + (await page.locator(".card h2").allTextContents()).join(", "));
  console.log("SMOKE OK");
} catch (error) {
  console.error("SMOKE FAILED", error);
  await page.screenshot({ path: "e2e/test-results/smoke-failed.png", fullPage: true }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
}
