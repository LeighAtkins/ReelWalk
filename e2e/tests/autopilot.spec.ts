import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);

// "Make it for me" (ADR 0021): pick shots on the home screen, choose a style,
// add a price, press one button, and the reel is cut, scored, titled and
// rendered with no other tap. Against the stand-in model (DEV_FAKE_AI) or the
// rule cut, whichever the stack has; both must end in a finished render.
test("make it for me: shots in, a rendered reel out", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("autopilot-input").setInputFiles([fixture("living-room.jpg"), fixture("walkthrough.mp4"), fixture("exterior.jpg")]);
  await expect(page).toHaveURL(/\/reels\/[^/?]+\?auto=1$/, { timeout: 30_000 });

  // The sheet is open while the shots upload.
  const sheet = page.getByRole("dialog", { name: "Make it for me" });
  await sheet.getByTestId("autopilot-style-open-house").click();
  await sheet.getByPlaceholder("$1,250,000").fill("$899,000");
  await sheet.getByPlaceholder("Saturday 1–3 pm").fill("Sunday 2–4 pm");
  await sheet.getByTestId("autopilot-go").click();
  await expect(sheet.getByTestId("autopilot-steps")).toBeVisible();

  // No other tap: it lands on the export screen and renders.
  await expect(page).toHaveURL(/\/export$/, { timeout: 120_000 });
  await expect(page.getByTestId("export")).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 4 * 60_000 });

  // The reel it made has music and a title (which words depends on the model or the rule cut).
  await page.goto(page.url().replace(/\/export$/, ""));
  await expect(page.getByTestId("clip").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".bar-music")).toBeVisible();
  await expect(page.getByTestId("text-bar").first()).toBeVisible();
});
