import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);

// One entry (ADR 0021, 0024, 0064): pick shots on the home screen and the
// reel goes straight from the upload to a finished first cut (music, titles,
// a hook) with no form; the editor opens on it. "Make it premium" restyles the
// whole reel in one undoable step, the pace is a reel-wide setting, then
// Export. Against the stand-in model (DEV_FAKE_AI) or the rule cut,
// whichever the stack has; both must end in a finished render.
test("one tap: shots in, a finished first cut in the editor, then a rendered reel", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("autopilot-input").setInputFiles([fixture("living-room.jpg"), fixture("walkthrough.mp4"), fixture("exterior.jpg")]);
  await expect(page).toHaveURL(/\/reels\/[^/?]+/, { timeout: 30_000 });

  // No form: the panel only shows the steps while the shots upload and the cut is made.
  await expect(page.getByTestId("autopilot-steps")).toBeVisible();
  await expect(page.getByTestId("autopilot-go")).toHaveCount(0);

  // The editor opens on the finished cut, titled, with the toolbar for the whole reel.
  // (The toolbar is drawn behind the panel all along, so wait for the panel to go first.)
  const tools = page.getByRole("navigation", { name: "Editing tools" });
  await expect(page.getByTestId("autopilot-steps")).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tools.getByRole("button", { name: "Make it premium" })).toBeVisible();
  await expect(page.getByTestId("clip").first()).toBeVisible();
  await expect(page.getByTestId("text-bar").first()).toBeVisible();
  // Reopening the address opens the reel, not another cut.
  await expect(page).toHaveURL(/\/reels\/[^/?]+$/);
  // Only the rule cut ran: the model's polish waits for a tap, and says what it costs (ADR 0064).
  if ((await page.getByTestId("ask-box").count()) > 0) await expect(page.getByTestId("polish-ai")).toContainText(/Polish with AI \(uses 1 of \d+ left\)/);
  await expect(page.getByTestId("polishing")).toHaveCount(0);

  // One finish sets music, type, pace and look together; one Undo takes it all back.
  const total = page.getByLabel("Playhead position");
  const before = await total.innerText();
  const premium = tools.getByRole("button", { name: "Make it premium" });
  await premium.click();
  await expect(premium).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(total).not.toHaveText(before);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(premium).toHaveAttribute("aria-pressed", "false");
  await expect(total).toHaveText(before);

  // The pace is a reel-wide setting, in the Reel sheet.
  await tools.getByRole("button", { name: "Reel", exact: true }).click();
  await page.getByRole("dialog", { name: "This reel" }).getByRole("button", { name: "Pace", exact: true }).click();
  await page.getByTestId("pace-slower").click();
  await page.getByRole("dialog", { name: "Timing" }).getByRole("button", { name: "Close" }).click();
  await expect(total).not.toHaveText(before);

  // The style and the facts are still there to cut it again with: bare numbers get $ and sq ft.
  await tools.getByRole("button", { name: "Reel", exact: true }).click();
  await page.getByTestId("remake").click();
  const panel = page.getByRole("dialog", { name: "Make it for me" });
  await panel.getByTestId("autopilot-style-open-house").click();
  await panel.getByPlaceholder("$1,250,000").fill("899000");
  await panel.getByPlaceholder("2,400 sq ft").fill("1800");
  await expect(panel.getByText("Shows as $899,000 · 1,800 sq ft")).toBeVisible();
  await panel.getByPlaceholder("Saturday 1–3 pm").fill("Sunday 2–4 pm");
  await panel.getByTestId("autopilot-go").click();
  await expect(panel).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByTestId("text-bar").filter({ hasText: "Open house" }).first()).toBeVisible();

  // Export when it is right.
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 60_000 });
  await page.getByTestId("export-button").click();
  await page.getByTestId("confirm-export").click();
  await expect(page).toHaveURL(/\/export$/, { timeout: 60_000 });
  await expect(page.getByTestId("export")).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 4 * 60_000 });

  // Back in the editor, the reel's title is on the timeline.
  await page.goto(page.url().replace(/\/export$/, ""));
  await expect(page.getByTestId("clip").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("text-bar").first()).toBeVisible();
});
