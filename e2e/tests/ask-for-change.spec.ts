import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);

// Asking for a change in words (ADR 0020) against the rule-based stand-in
// (DEV_FAKE_AI): "longer" stretches the first clip by half and "warmer" sets
// the warm look on every clip; a request it cannot read leaves the sheet open
// with the note. No model is called, and no library songs are needed.
test("a studio can ask for a change in words and undo it", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-reel-input").setInputFiles([fixture("exterior.jpg"), fixture("living-room.jpg")]);
  await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByTestId("clip")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 60_000 });

  const ask = page.getByRole("button", { name: "Ask", exact: true });
  test.skip((await ask.count()) === 0, "this stack has no model and no stand-in (OPENAI_API_KEY or DEV_FAKE_AI)");

  await ask.click();
  // A reel nobody has cut yet is offered the briefs first, under a different title.
  const sheet = page.getByRole("dialog", { name: /Ask for a change|Cut it for me/ });
  const total = page.getByLabel("Playhead position");
  await expect(total).toContainText("/ 0:06.0");
  await sheet.getByTestId("ask-input").fill("make it longer and warmer");
  await sheet.getByTestId("ask-submit").click();
  // The answer is applied as one step and the model's note is shown.
  await expect(page.locator(".toast")).toContainText("warm look", { timeout: 30_000 });
  await expect(sheet).toHaveCount(0);
  await expect(total).toContainText("/ 0:07.5");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 60_000 });

  // One undo takes the whole change back.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(total).toContainText("/ 0:06.0");

  // A request the stand-in cannot read keeps the sheet open and explains.
  await ask.click();
  await sheet.getByTestId("ask-input").fill("hello there");
  await sheet.getByTestId("ask-submit").click();
  await expect(sheet.getByTestId("ask-note")).toContainText("could not tell what to change", { timeout: 30_000 });

  // A brief cuts the whole reel: the stand-in opens it with a headline.
  await sheet.getByRole("button", { name: /close/i }).click();
  await ask.click();
  await sheet.getByTestId("brief-just-listed").click();
  await expect(sheet.getByTestId("ask-input")).toHaveValue(/just-listed reel/);
  await sheet.getByTestId("ask-submit").click();
  await expect(page.locator(".toast")).toContainText("opens with a headline", { timeout: 30_000 });
  await expect(page.getByTestId("text-bar")).toContainText("Just listed");

  // All three requests count against the month's allowance.
  await page.goto("/account");
  await expect(page.getByTestId("ai-usage")).toContainText(/^\d+ of \d+ this month$/);
});
