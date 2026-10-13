import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);

// Asking for a change in words (ADR 0020) against the rule-based stand-in
// (DEV_FAKE_AI): "warmer" sets the warm look on every clip, "calmer music"
// picks the calmest library song, and a request it cannot read leaves the
// sheet open with the note. No model is called.
test("a studio can ask for a change in words and undo it", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-reel-input").setInputFiles([fixture("exterior.jpg"), fixture("living-room.jpg")]);
  await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByTestId("clip")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 60_000 });

  const ask = page.getByRole("button", { name: "Ask", exact: true });
  test.skip((await ask.count()) === 0, "this stack has no model and no stand-in (OPENAI_API_KEY or DEV_FAKE_AI)");

  await ask.click();
  const sheet = page.getByRole("dialog", { name: "Ask for a change" });
  await sheet.getByTestId("ask-input").fill("warmer look on everything, calmer music");
  await sheet.getByTestId("ask-submit").click();
  // The answer is applied as one step and the model's note is shown.
  await expect(page.locator(".toast")).toContainText("warm look", { timeout: 30_000 });
  await expect(page.locator(".toast")).toContainText("music is now");
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(".bar-music")).toBeVisible();
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 60_000 });

  // One undo takes the whole change back.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".bar-music")).toHaveCount(0);

  // A request the stand-in cannot read keeps the sheet open and explains.
  await ask.click();
  await sheet.getByTestId("ask-input").fill("hello there");
  await sheet.getByTestId("ask-submit").click();
  await expect(sheet.getByTestId("ask-note")).toContainText("could not tell what to change", { timeout: 30_000 });

  // Both requests count against the month's allowance.
  await page.goto("/account");
  await expect(page.getByTestId("ai-usage")).toContainText(/^\d+ of \d+ this month$/);
});
