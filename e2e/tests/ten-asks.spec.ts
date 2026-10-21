import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);

// The ten asks (ADR 0023) through the editor and through the rule-based
// stand-in (DEV_FAKE_AI): a sticker, text over the last shot, a logo picked
// in its sheet and then moved by asking, a closer crop, the typewriter, the
// facts strip and a written caption. Each is one undoable edit, saved by the
// autosave, and the export at the end renders them all.
test("the ten asks: sticker, ending text, logo, zoom, typing, strip, caption, export", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-reel-input").setInputFiles([fixture("exterior.jpg"), fixture("walkthrough.mp4"), fixture("living-room.jpg")]);
  await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByTestId("clip")).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 60_000 });

  const ask = page.getByRole("button", { name: "Ask", exact: true });
  test.skip((await ask.count()) === 0, "this stack has no model and no stand-in (OPENAI_API_KEY or DEV_FAKE_AI)");
  const sheet = page.getByRole("dialog", { name: /Ask for a change|Cut it for me/ });
  // The answer comes from a background job the editor polls (ADR 0021). Wait
  // for that job's answer and check it, rather than for a toast: the toast
  // only appears when something was applied, so a refusal ("upload your logo
  // first", the cause of every first-attempt failure before ADR 0054) used to
  // show up as a 30 s timeout on the previous ask's toast.
  const askFor = async (request: string, note: RegExp) => {
    await ask.click();
    await sheet.getByTestId("ask-input").fill(request);
    const answered = page.waitForResponse(
      async (response) => {
        if (!response.url().includes("/api/ai-jobs/")) return false;
        const job = (await response.json().catch(() => null)) as { status?: string } | null;
        return job?.status === "DONE" || job?.status === "FAILED";
      },
      { timeout: 30_000 },
    );
    await sheet.getByTestId("ask-submit").click();
    const job = (await (await answered).json()) as { status: string; error?: string; result?: { note: string; applied: string[] } };
    expect(job.status, job.error).toBe("DONE");
    expect(job.result?.note).toMatch(note);
    expect(job.result?.applied.length, job.result?.note).toBeGreaterThan(0);
    // Applied, the editor closes the sheet and shows the note.
    await expect(sheet).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText(note);
  };

  // A status sticker, in capitals, over the first shot.
  await askFor("put a sold sticker on it", /sold sticker/);
  await expect(page.getByTestId("text-bar").filter({ hasText: "SOLD" })).toHaveCount(1);

  // A line over the last shot.
  await askFor('add "DM for a tour" at the end', /over the last shot/);
  await expect(page.getByTestId("text-bar").filter({ hasText: "DM for a tour" })).toHaveCount(1);

  // The logo: uploaded in its sheet, then moved by asking.
  await page.getByRole("button", { name: "Logo", exact: true }).click();
  const logoSheet = page.getByRole("dialog", { name: "Logo" });
  await logoSheet.getByTestId("logo-input").setInputFiles(fixture("logo.png"));
  await expect(logoSheet.getByRole("button", { name: "Remove the logo" })).toBeVisible({ timeout: 60_000 });
  await logoSheet.getByRole("button", { name: /close/i }).click();
  await askFor("move the logo to the bottom left", /logo is in the corner/);

  // A closer crop of the kitchen, then the title typing in, then the facts strip.
  await askFor("zoom in a bit", /cropped closer/);
  await askFor("make the title type in letter by letter", /arrives with a type/);
  await page.getByRole("button", { name: "Details", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Property details" });
  await details.getByPlaceholder("¥48,000,000").fill("$899,000");
  await details.getByRole("button", { name: "Strip, whole reel" }).click();
  await details.getByRole("button", { name: /close/i }).click();

  // The caption, written for you.
  await page.getByRole("button", { name: "Caption", exact: true }).click();
  const caption = page.getByRole("dialog", { name: "Post caption" });
  await caption.getByTestId("caption-write").click();
  await expect(caption.locator("textarea")).toHaveValue(/#realestate/, { timeout: 30_000 });
  await caption.getByRole("button", { name: /close/i }).click();
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 60_000 });

  // The new look is there in the Look sheet; the cover is set from the toolbar.
  await page.getByTestId("clip").nth(1).click();
  await page.getByRole("button", { name: "Cover", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("cover Instagram shows");
  await page.getByRole("button", { name: "Look", exact: true }).click();
  await page.getByRole("dialog", { name: "Look" }).getByRole("button", { name: "Golden hour" }).click();
  await page.getByRole("dialog", { name: "Look" }).getByRole("button", { name: /close/i }).click();

  // Everything renders.
  await page.getByTestId("export-button").click();
  await page.getByTestId("confirm-export").click();
  await expect(page).toHaveURL(/\/export$/, { timeout: 60_000 });
  await expect(page.getByTestId("export")).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 4 * 60_000 });
});
