import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);

// Editing to an Instagram sound (ADR 0019) against the pretend Instagram
// (DEV_FAKE_INSTAGRAM): its library is canned (searchFakeInstagramAudio in
// @reelwalk/core) and every sound's preview is the same click track at
// 120 bpm, served by /api/dev/instagram/sound. Nothing reaches Instagram.
test("a studio can edit to an Instagram sound, snap to its beat, and export with it pre-selected", async ({ page }) => {
  const connect = await page.request.post("/api/dev/instagram");
  test.skip(connect.status() === 404, "this stack has no pretend Instagram (DEV_FAKE_INSTAGRAM)");
  expect(connect.ok()).toBe(true);
  const { fake } = (await connect.json()) as { username: string; fake: boolean };
  test.skip(!fake, "a real Instagram account is connected; its library is not canned");

  try {
    await page.goto("/");
    await page.getByTestId("new-reel-input").setInputFiles([fixture("exterior.jpg"), fixture("living-room.jpg")]);
    await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByTestId("clip")).toHaveCount(2, { timeout: 60_000 });
    const total = page.getByLabel("Playhead position");
    await expect(total).toContainText("/ 0:06.0");

    // Instagram's music sits next to your own songs in the Music sheet.
    await page.getByRole("button", { name: "Music", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Music" });
    await expect(sheet.getByTestId("music-source-songs")).toHaveAttribute("aria-pressed", "true");
    await sheet.getByTestId("music-source-instagram").click();
    await expect(sheet.getByTestId("sound-results")).toHaveAttribute("data-state", "ready");
    await expect(sheet.getByTestId("sound-option")).toHaveCount(3);
    // Each sound can be heard on its own first.
    await expect(sheet.getByTestId("sound-preview").first()).toBeEnabled();

    // Picking one puts the private copy under the reel.
    await sheet.locator('[data-testid="sound-option"][data-audio-id="fake-music-1"]').click();
    const current = sheet.getByTestId("music-current");
    await expect(current).toHaveAttribute("data-instagram", "true", { timeout: 30_000 });
    await expect(current).toContainText("Open House Morning");
    await expect(current).toContainText("ReelWalk Test Band");
    // Instagram plays it from its start, so there is no start control.
    await expect(sheet.getByTestId("music-start-locked")).toHaveText("Instagram plays this sound from its start.");
    await expect(sheet.getByText("Start the song at")).toHaveCount(0);
    await expect(sheet.getByText("Volume in this preview")).toBeVisible();

    // Its tempo was found in the browser, so cuts can snap to it.
    const snap = sheet.getByTestId("snap-to-beat");
    await expect(snap).toContainText("120 bpm", { timeout: 30_000 });
    await snap.click();
    await expect(total).not.toContainText("/ 0:06.0");
    await expect(page.locator(".bar-music")).toContainText("Open House Morning");
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 20_000 });

    // The export sheet says the file itself leaves the sound out.
    await page.getByTestId("export-button").click();
    await expect(page.getByTestId("export-instagram-sound")).toContainText("Open House Morning · ReelWalk Test Band");
    await page.getByTestId("confirm-export").click();
    await expect(page).toHaveURL(/\/export$/);
    await expect(page.getByTestId("export")).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 4 * 60_000 });

    // The reel's sound is chosen for Post now and Schedule, and can still be changed.
    await expect(page.getByTestId("sound-control")).toHaveAttribute("data-audio-id", "fake-music-1");
    await expect(page.getByTestId("sound-chosen")).toHaveText("Open House Morning · ReelWalk Test Band");
    await expect(page.getByTestId("reel-sound-note")).toContainText("Open House Morning");

    // Play with sound plays the export with the sound, from the private copy.
    const playWithSound = page.getByTestId("play-with-sound");
    await expect(playWithSound).toHaveAttribute("data-state", "idle");
    await page.getByTestId("play-with-sound-button").click();
    await expect(page.getByTestId("play-with-sound-audio")).toHaveAttribute("src", /instagram-audio\/fake-music-1\.wav/, { timeout: 30_000 });
    await expect(playWithSound).toHaveAttribute("data-state", /playing|paused/);
    await page.getByTestId("play-with-sound-stop").click();
    await expect(playWithSound).toHaveAttribute("data-state", "idle");

    // Any sound picked here can be played with too.
    await page.getByTestId("sound-open").click();
    const picker = page.getByRole("dialog", { name: "Instagram sound" });
    await picker.getByTestId("sound-tab-trending").click();
    await picker.locator('[data-testid="sound-option"][data-audio-id="fake-sound-1"]').click();
    await picker.getByTestId("sound-confirm").click();
    await expect(page.getByTestId("sound-control")).toHaveAttribute("data-audio-id", "fake-sound-1");
    await page.getByTestId("play-with-sound-button").click();
    await expect(page.getByTestId("play-with-sound-audio")).toHaveAttribute("src", /instagram-audio\/fake-sound-1\.wav/, { timeout: 30_000 });
  } finally {
    if (fake) await page.request.delete("/api/dev/instagram");
  }
});
