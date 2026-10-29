import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);

// Notes on a version (ADR 0095) against the stand-in (DEV_FAKE_AI): a note on
// the export screen edits the reel with the connector's tools and exports the
// next version; the thread shows both versions with their opening frames and
// checks, and "Go back to v1" makes v1's cut the reel's cut again. No model is
// called and no credits are spent.
test("a note on a version makes the next version, and the owner can go back", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-reel-input").setInputFiles([fixture("exterior.jpg"), fixture("living-room.jpg")]);
  await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByTestId("clip")).toHaveCount(2, { timeout: 60_000 });

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByLabel("Text to show").fill("Picture this");
  await page.getByRole("button", { name: "Add text" }).last().click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 20_000 });

  await page.getByTestId("export-button").click();
  await page.getByTestId("confirm-export").click();
  await expect(page).toHaveURL(/\/export$/);
  await expect(page.getByTestId("export")).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 4 * 60_000 });

  const thread = page.getByTestId("reel-thread");
  test.skip((await page.getByTestId("note-box").count()) === 0, "this stack has no Claude and no stand-in (DEV_FAKE_AI)");
  await expect(thread.getByTestId("thread-version")).toHaveCount(1);
  await expect(thread.getByTestId("thread-version").first()).toHaveAttribute("data-current", "true");

  await page.getByTestId("note-input").fill("make the titles bigger");
  await page.getByTestId("note-send").click();

  // The new version arrives in the thread with the note and its answer, rendered, with its strip and checks.
  const v2 = thread.locator('[data-testid="thread-version"][data-label="v2"]');
  await expect(v2).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 4 * 60_000 });
  await expect(v2.getByTestId("thread-note")).toContainText("make the titles bigger");
  await expect(v2.getByTestId("thread-note")).toHaveAttribute("data-status", "exported");
  await expect(v2).toHaveAttribute("data-current", "true");
  await expect(v2.getByTestId("thread-strip").locator("img")).toHaveCount(8);
  await expect(page.getByTestId("export")).toHaveAttribute("data-status", "SUCCEEDED");

  // Back to v1: its cut is the reel's cut again, and the screen shows v1. Nothing renders.
  const v1 = thread.locator('[data-testid="thread-version"][data-label="v1"]');
  await v1.getByTestId("back-to-version").click();
  await expect(page).toHaveURL(/\?v=/);
  await expect(v1).toHaveAttribute("data-current", "true");
  await expect(v2).toHaveAttribute("data-current", "false");
  await expect(thread.getByTestId("thread-version")).toHaveCount(2);

  // A note the stand-in cannot read changes nothing and says so, with no new version.
  await page.getByTestId("note-input").fill("hello there");
  await page.getByTestId("note-send").click();
  await expect(thread.locator('[data-testid="thread-note"][data-status="no-change"]')).toContainText("could not tell", { timeout: 60_000 });
  await expect(thread.getByTestId("thread-version")).toHaveCount(2);
});
