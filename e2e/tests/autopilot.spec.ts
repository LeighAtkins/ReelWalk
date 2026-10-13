import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);

// "Make it for me" (ADR 0021, 0022): pick shots on the home screen, choose a
// style, add the facts, press one button, and the reel is cut, scored and
// titled into a draft that opens in the review. A quick change there, then
// Export. Against the stand-in model (DEV_FAKE_AI) or the rule cut, whichever
// the stack has; both must end in a finished render.
test("make it for me: shots in, a draft to review, then a rendered reel", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("autopilot-input").setInputFiles([fixture("living-room.jpg"), fixture("walkthrough.mp4"), fixture("exterior.jpg")]);
  await expect(page).toHaveURL(/\/reels\/[^/?]+\?auto=1$/, { timeout: 30_000 });

  // The panel is open while the shots upload; bare numbers get $ and sq ft.
  const panel = page.getByRole("dialog", { name: "Make it for me" });
  await panel.getByTestId("autopilot-style-open-house").click();
  await panel.getByPlaceholder("$1,250,000").fill("899000");
  await panel.getByPlaceholder("2,400 sq ft").fill("1800");
  await expect(panel.getByText("Shows as $899,000 · 1,800 sq ft")).toBeVisible();
  await panel.getByPlaceholder("Saturday 1–3 pm").fill("Sunday 2–4 pm");
  await panel.getByTestId("autopilot-go").click();

  // No export yet: the draft opens in the review, with the quick changes under it and no timeline.
  const bar = page.getByTestId("review-bar");
  await expect(bar).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("text-bar")).toHaveCount(0);
  const summary = bar.locator(".review-summary");
  const before = await summary.innerText();
  await bar.getByTestId("review-timing").click();
  await page.getByTestId("pace-slower").click();
  await page.getByRole("dialog", { name: "Timing" }).getByRole("button", { name: "Close" }).click();
  await expect(summary).not.toHaveText(before);

  // Export when it is right.
  await page.getByTestId("export-button").click();
  await page.getByTestId("confirm-export").click();
  await expect(page).toHaveURL(/\/export$/, { timeout: 60_000 });
  await expect(page.getByTestId("export")).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 4 * 60_000 });

  // The full editor is still there, with the reel's title on the timeline.
  await page.goto(page.url().replace(/\/export$/, ""));
  await expect(page.getByTestId("clip").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("text-bar").first()).toBeVisible();
});
