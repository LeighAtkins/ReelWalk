import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);

test("an owner can offer a finished reel for featuring, see it listed, and withdraw it", async ({ page, browser }) => {
  // A one-photo reel is the quickest export there is.
  await page.goto("/");
  await page.getByTestId("new-reel-input").setInputFiles([fixture("exterior.jpg")]);
  await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByTestId("clip")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 20_000 });
  await page.getByTestId("export-button").click();
  await page.getByTestId("confirm-export").click();
  await expect(page).toHaveURL(/\/export$/);
  await expect(page.getByTestId("export")).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 4 * 60_000 });
  const exportUrl = page.url();

  // Off by default, and the wording says it can be withdrawn.
  const consent = page.getByTestId("feature-consent");
  await expect(consent).toHaveAttribute("data-consent", "off");
  await expect(consent).toContainText("withdraw this any time");
  await expect(page.getByTestId("feature-consent-box")).not.toBeChecked();

  // Tick it, with a handle typed the way people type them.
  await page.getByTestId("feature-consent-box").check();
  await page.getByTestId("feature-handle").fill("@Rivera.Homes");
  await page.getByTestId("save-featured").click();
  await expect(page.getByTestId("feature-saved")).toContainText("We may feature this reel");
  await page.goto(exportUrl);
  await expect(page.getByTestId("feature-consent")).toHaveAttribute("data-consent", "on");
  await expect(page.getByTestId("feature-consent-box")).toBeChecked();
  await expect(page.getByTestId("feature-handle")).toHaveValue("rivera.homes");

  // The seed makes the demo user an admin on the local stack, so the reel is listed with its file.
  await page.goto("/admin/featured");
  const row = page.getByTestId("featured-row").filter({ hasText: "@rivera.homes" }).first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("link", { name: "Download MP4" })).toBeVisible();

  // The owner's own share page carries the same box; a guest sees none.
  await page.goto(exportUrl);
  await page.getByTestId("share-link").click();
  const shareUrl = (await page.getByTestId("share-link-url").getAttribute("href"))!;
  await page.goto(shareUrl);
  await expect(page.getByTestId("feature-consent")).toHaveAttribute("data-consent", "on");
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const guestPage = await guest.newPage();
  await guestPage.goto(shareUrl);
  await expect(guestPage.getByTestId("shared-video")).toBeVisible();
  await expect(guestPage.getByTestId("feature-consent")).toHaveCount(0);
  await guest.close();

  // Withdrawing from the share page.
  await page.getByTestId("feature-consent-box").uncheck();
  await page.getByTestId("save-featured").click();
  await expect(page.getByTestId("feature-saved")).toContainText("We will not feature this reel");
  await expect(page.getByTestId("feature-consent")).toHaveAttribute("data-consent", "off");
});

test("the admin list is not there for other studios", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Pat Admin-Not");
  await page.getByLabel("Email").fill(`not-admin-${Date.now()}@example.com`);
  await page.getByLabel(/^Password/).fill("walk-the-reel-3");
  await page.getByRole("button", { name: "Create studio" }).click();
  await expect(page).toHaveURL(/\/\?welcome=1$/);
  const response = await page.goto("/admin/featured");
  expect(response?.status()).toBe(404);
  await context.close();
});
