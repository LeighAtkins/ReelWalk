import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixture = (name: string) => path.join(fixtures, name);

/** Starts a reel the way a user does: tap New reel and pick files. Returns the reel URL. */
async function newReel(page: Page, files: string[]): Promise<string> {
  await page.goto("/");
  await page.getByTestId("new-reel-input").setInputFiles(files.map(fixture));
  await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
  return page.url();
}

async function waitForSaved(page: Page) {
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 20_000 });
}

const total = (page: Page) => page.getByLabel("Playhead position");

test("make a reel from photos and a video, edit it, and export it for Instagram", async ({ page }) => {
  const url = await newReel(page, ["exterior.jpg", "walkthrough.mp4", "living-room.jpg"]);

  // Clips arrive in the order they were picked: 3 s photo, 2 s video, 3 s photo.
  await expect(page.getByTestId("clip")).toHaveCount(3, { timeout: 60_000 });
  await expect(total(page)).toContainText("/ 0:08.0");
  await waitForSaved(page);

  // Text on top of the reel.
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByLabel("Text to show").fill("Just listed 新築");
  await page.getByRole("button", { name: "Headline" }).click();
  await page.getByRole("button", { name: "Add text" }).last().click();
  await expect(page.getByTestId("text-bar")).toContainText("Just listed 新築");
  await page.getByRole("button", { name: "Done" }).click();

  // Double the video's speed: 2 s becomes 1 s.
  await page.getByTestId("clip").nth(1).click();
  await page.getByRole("button", { name: "Speed" }).click();
  await page.getByRole("button", { name: "2×" }).click();
  await page.keyboard.press("Escape");
  await expect(total(page)).toContainText("/ 0:07.0");

  // Undo and redo the speed change.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(total(page)).toContainText("/ 0:08.0");
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(total(page)).toContainText("/ 0:07.0");
  await waitForSaved(page);

  // Everything was saved: a reload shows the same edit.
  await page.goto(url);
  await expect(page.getByTestId("clip")).toHaveCount(3);
  await expect(page.getByTestId("text-bar")).toContainText("Just listed");
  await expect(total(page)).toContainText("/ 0:07.0");

  // Export and wait for the render.
  await page.getByTestId("export-button").click();
  await page.getByTestId("confirm-export").click();
  await expect(page).toHaveURL(/\/export$/);
  await expect(page.getByTestId("export")).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 4 * 60_000 });

  const video = page.getByTestId("export-video");
  const response = await page.request.get((await video.getAttribute("src"))!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("video/mp4");
  expect((await response.body()).byteLength).toBeGreaterThan(50_000);
  await expect(page.getByRole("button", { name: "Share to Instagram" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download" })).toBeVisible();

  // The export is listed, and the reel shows on the home screen.
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Close editor" }).click();
  await expect(page.locator(`a[href="${new URL(url).pathname}"]`)).toContainText("Done");
});

test("Instagram's limits are checked before export", async ({ page }) => {
  await newReel(page, ["exterior.jpg"]);
  await expect(page.getByTestId("clip")).toHaveCount(1, { timeout: 60_000 });

  // A 2 second reel is too short for Instagram.
  await page.getByTestId("clip").first().click();
  await page.getByRole("button", { name: "Length" }).click();
  await page.getByLabel("On screen for").fill("2000");
  await page.keyboard.press("Escape");
  await expect(total(page)).toContainText("/ 0:02.0");
  await waitForSaved(page);

  await page.getByTestId("export-button").click();
  await expect(page.getByRole("heading", { name: "Not ready to export" })).toBeVisible();
  await expect(page.getByText("Reels must be at least 3s")).toBeVisible();
  await expect(page.getByTestId("confirm-export")).toBeDisabled();
  await page.keyboard.press("Escape");

  // Captions over 30 hashtags are flagged as you type.
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Caption" }).click();
  await page.getByRole("textbox", { name: "Post caption" }).fill(Array.from({ length: 31 }, (_, i) => `#home${i}`).join(" "));
  await expect(page.getByText("31/30 hashtags")).toHaveAttribute("data-over", "true");
});

test("a second tab cannot silently overwrite the first", async ({ page, context }) => {
  const url = await newReel(page, ["exterior.jpg", "living-room.jpg"]);
  await expect(page.getByTestId("clip")).toHaveCount(2, { timeout: 60_000 });
  await waitForSaved(page);

  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByTestId("clip")).toHaveCount(2);

  // First tab saves an edit...
  await page.getByTestId("clip").first().click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("clip")).toHaveCount(1);
  await waitForSaved(page);

  // ...so the second tab, still on the old version, is refused instead of overwriting it.
  await other.getByTestId("clip").first().click();
  await other.getByRole("button", { name: "Duplicate" }).click();
  await expect(other.getByTestId("conflict-banner")).toContainText("changed in another tab");
  await other.getByRole("button", { name: "Reload" }).click();
  await expect(other.getByTestId("clip")).toHaveCount(1);
});

test("a video that cannot be rendered fails after its retries and can be retried", async ({ page }) => {
  // Passes the upload checks (it is an .mp4) but cannot be decoded.
  await newReel(page, ["corrupt.mp4"]);
  await expect(page.getByTestId("clip")).toHaveCount(1, { timeout: 60_000 });
  await waitForSaved(page);

  await page.getByTestId("export-button").click();
  await page.getByTestId("confirm-export").click();
  await expect(page.getByTestId("export")).toHaveAttribute("data-status", "FAILED", { timeout: 4 * 60_000 });

  await page.getByRole("button", { name: "Retry export" }).click();
  await expect(page.getByTestId("export")).toHaveAttribute("data-status", /QUEUED|RUNNING/);
});

test("files Instagram cannot use are refused with a reason", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-reel-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByRole("status").filter({ hasText: "not a supported" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("clip")).toHaveCount(0);
});
