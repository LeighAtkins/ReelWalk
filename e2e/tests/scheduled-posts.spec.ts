import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);

// Instagram itself is never called: the local stack has no Meta app, so the
// studio is connected to a pretend account (/api/dev/instagram, which exists
// only with DEV_FAKE_INSTAGRAM=true), and the post is scheduled for tomorrow
// and cancelled long before the publisher would pick it up.
test("a studio can schedule an export for Instagram, see it listed, and cancel it", async ({ page }) => {
  const connect = await page.request.post("/api/dev/instagram");
  test.skip(connect.status() === 404, "this stack has no pretend Instagram (DEV_FAKE_INSTAGRAM)");
  expect(connect.ok()).toBe(true);
  const { username, fake } = (await connect.json()) as { username: string; fake: boolean };

  try {
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

    // Schedule sits next to the post-now button, and offers tomorrow morning.
    await expect(page.getByTestId("post-to-instagram")).toContainText(`@${username}`);
    await page.getByTestId("schedule-open").click();
    const when = page.getByTestId("schedule-time");
    await expect(when).toHaveValue(/^\d{4}-\d{2}-\d{2}T09:00$/);

    // Tomorrow at 10:30 local time.
    const tomorrow = await page.evaluate(() => {
      const date = new Date();
      date.setDate(date.getDate() + 1);
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:30`;
    });
    await when.fill(tomorrow);
    await page.getByTestId("schedule-submit").click();
    const confirmed = page.getByTestId("schedule-confirmed");
    await expect(confirmed).toContainText(`on @${username}`);
    await expect(confirmed).toContainText("10:30");
    const postId = (await confirmed.getAttribute("data-post-id"))!;

    // Listed under Coming up, in the viewer's time.
    await confirmed.getByRole("link", { name: "See scheduled posts" }).click();
    await expect(page).toHaveURL(/\/scheduled$/);
    const row = page.locator(`[data-testid="scheduled-row"][data-id="${postId}"]`);
    await expect(row).toHaveAttribute("data-status", "SCHEDULED");
    await expect(row.getByTestId("scheduled-status")).toHaveText("Scheduled");
    await expect(row).toContainText("10:30");
    await expect(page.getByTestId("scheduled-upcoming").locator(`[data-id="${postId}"]`)).toBeVisible();

    // Cancelled, it moves to Earlier and can no longer be cancelled.
    await row.getByTestId("scheduled-cancel").click();
    await expect(page.getByRole("status").filter({ hasText: "Nothing will be posted" })).toBeVisible();
    const after = page.getByTestId("scheduled-past").locator(`[data-id="${postId}"]`);
    await expect(after).toHaveAttribute("data-status", "CANCELLED");
    await expect(after.getByTestId("scheduled-cancel")).toHaveCount(0);

    // The account page links to the list.
    await page.goto("/account");
    await page.getByTestId("scheduled-link").click();
    await expect(page).toHaveURL(/\/scheduled$/);
  } finally {
    if (fake) await page.request.delete("/api/dev/instagram");
  }
});

// The Instagram sound picker (ADR 0018) against the pretend library: the
// tracks are canned (searchFakeInstagramAudio in @reelwalk/core) and nothing
// reaches Instagram.
test("a studio can pick an Instagram sound, schedule with it, then change and remove it", async ({ page }) => {
  const connect = await page.request.post("/api/dev/instagram");
  test.skip(connect.status() === 404, "this stack has no pretend Instagram (DEV_FAKE_INSTAGRAM)");
  expect(connect.ok()).toBe(true);
  const { fake } = (await connect.json()) as { username: string; fake: boolean };
  test.skip(!fake, "a real Instagram account is connected; its library is not canned");
  try {
    await page.goto("/");
    await page.getByTestId("new-reel-input").setInputFiles([fixture("exterior.jpg")]);
    await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByTestId("clip")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 20_000 });
    await page.getByTestId("export-button").click();
    await page.getByTestId("confirm-export").click();
    await expect(page).toHaveURL(/\/export$/);
    await expect(page.getByTestId("export")).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 4 * 60_000 });

    // The picker opens on Music, showing what is trending.
    await page.getByTestId("sound-open").click();
    const sheet = page.getByRole("dialog", { name: "Instagram sound" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("sound-tab-music")).toHaveAttribute("aria-pressed", "true");
    await expect(sheet.getByTestId("sound-results")).toHaveAttribute("data-state", "ready");
    await expect(sheet.getByTestId("sound-option")).toHaveCount(3);
    await expect(sheet.getByTestId("sound-confirm")).toBeDisabled();

    // Search narrows it; pick one and keep the reel's own music under it.
    await sheet.getByTestId("sound-search").fill("kitchen");
    await expect(sheet.getByTestId("sound-option")).toHaveCount(1);
    const kitchen = sheet.locator('[data-testid="sound-option"][data-audio-id="fake-music-2"]');
    await expect(kitchen).toContainText("Sunlit Kitchen");
    await expect(kitchen).toContainText("The Floor Plans");
    await expect(kitchen).toContainText("1:15");
    await kitchen.click();
    await expect(kitchen).toHaveAttribute("aria-pressed", "true");
    await expect(sheet.getByTestId("sound-keep-reel")).not.toBeChecked();
    await sheet.getByTestId("sound-keep-reel").check();
    await sheet.getByTestId("sound-confirm").click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("sound-chosen")).toHaveText("Sunlit Kitchen · The Floor Plans");

    // Clearing and picking again works before scheduling too.
    await page.getByTestId("sound-clear").click();
    await expect(page.getByTestId("sound-chosen")).toHaveText("Add Instagram sound");
    await page.getByTestId("sound-open").click();
    await sheet.getByTestId("sound-search").fill("kitchen");
    await sheet.locator('[data-testid="sound-option"][data-audio-id="fake-music-2"]').click();
    await sheet.getByTestId("sound-confirm").click();

    // Scheduled with the sound.
    await page.getByTestId("schedule-open").click();
    await expect(page.getByTestId("schedule-form")).toContainText("Sunlit Kitchen");
    await page.getByTestId("schedule-submit").click();
    const confirmed = page.getByTestId("schedule-confirmed");
    await expect(confirmed).toContainText("Sunlit Kitchen · The Floor Plans");
    const postId = (await confirmed.getAttribute("data-post-id"))!;

    // /scheduled shows it on the row.
    await page.goto("/scheduled");
    const row = page.locator(`[data-testid="scheduled-row"][data-id="${postId}"]`);
    await expect(row).toHaveAttribute("data-status", "SCHEDULED");
    await expect(row.getByTestId("sound-control")).toHaveAttribute("data-audio-id", "fake-music-2");
    await expect(row.getByTestId("sound-chosen")).toHaveText("Sunlit Kitchen · The Floor Plans");

    // Change it to a trending sound; it sticks after a reload.
    await row.getByTestId("sound-open").click();
    await expect(sheet).toBeVisible();
    // The re-picked sound above was saved without "keep my music", and the sheet reopens that way.
    await expect(sheet.getByTestId("sound-keep-reel")).not.toBeChecked();
    await sheet.getByTestId("sound-tab-trending").click();
    await expect(sheet.getByTestId("sound-tab-trending")).toHaveAttribute("aria-pressed", "true");
    await sheet.locator('[data-testid="sound-option"][data-audio-id="fake-sound-2"]').click();
    await sheet.getByTestId("sound-confirm").click();
    await expect(row.getByTestId("sound-chosen")).toHaveText("Just listed (remix) · @agent.demo");
    await expect(row.getByTestId("scheduled-sound")).not.toHaveAttribute("data-pending", /.*/);
    await page.reload();
    await expect(row.getByTestId("sound-control")).toHaveAttribute("data-audio-id", "fake-sound-2");

    // Remove it; it stays removed.
    await row.getByTestId("sound-clear").click();
    await expect(row.getByTestId("sound-chosen")).toHaveText("Sound");
    await expect(row.getByTestId("scheduled-sound")).not.toHaveAttribute("data-pending", /.*/);
    await page.reload();
    await expect(row.getByTestId("sound-control")).toHaveAttribute("data-audio-id", "");
    await expect(row.getByTestId("sound-clear")).toHaveCount(0);

    await row.getByTestId("scheduled-cancel").click();
    await expect(page.getByRole("status").filter({ hasText: "Nothing will be posted" })).toBeVisible();
  } finally {
    if (fake) await page.request.delete("/api/dev/instagram");
  }
});
