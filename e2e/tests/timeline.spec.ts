import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
/** Pixels per second of reel at the default zoom (filmstrip.tsx). */
const PPS = 56;

async function newReel(page: Page, files: string[]) {
  await page.goto("/");
  await page.getByTestId("new-reel-input").setInputFiles(files.map((name) => path.join(fixtures, name)));
  await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByTestId("clip")).toHaveCount(files.length, { timeout: 60_000 });
}

/** Drag from the middle of an element by dx pixels, in small steps like a hand. */
async function dragBy(page: Page, target: Locator, dx: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + (dx * i) / 12, y);
  await page.mouse.up();
}

const tool = (page: Page, name: string) => page.getByRole("navigation", { name: "Editing tools" }).getByRole("button", { name, exact: true });

test("text timing and clips are edited by dragging on the timeline", async ({ page }) => {
  await newReel(page, ["exterior.jpg", "walkthrough.mp4", "living-room.jpg"]);

  await tool(page, "Text").click();
  await page.getByLabel("Text to show").fill("Drag my edges");
  await page.getByRole("button", { name: "Add text" }).last().click();
  const bar = page.getByTestId("text-bar");
  await expect(bar).toHaveAttribute("aria-label", /0:00\.0 to 0:03\.0/);

  // Shorten the text from 3 s to 1.5 s by its end grip; one drag is one undo step.
  await dragBy(page, bar.locator(".grip-end"), -1.5 * PPS);
  await expect(bar).toHaveAttribute("aria-label", /0:00\.0 to 0:01\.5/);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(bar).toHaveAttribute("aria-label", /0:00\.0 to 0:03\.0/);
  await page.getByRole("button", { name: "Redo" }).click();

  // Move the whole text a second later.
  await dragBy(page, bar.locator(".bar-label"), PPS);
  await expect(bar).toHaveAttribute("aria-label", /0:01\.0 to 0:02\.5/);

  // Cut half a second from the start of the video clip with its start grip.
  const video = page.getByTestId("clip").nth(1);
  await video.click();
  await dragBy(page, video.locator(".grip-start"), 0.5 * PPS);
  await expect(video).toHaveAttribute("aria-label", /video, 0:01\.5/);

  // Drag the first photo after the video.
  const first = page.getByTestId("clip").first();
  await first.click();
  await dragBy(page, first, 3 * PPS);
  await expect(page.getByTestId("clip").first()).toHaveAttribute("aria-label", /video/);

  // Everything above was saved.
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-status", "saved", { timeout: 20_000 });
  await page.reload();
  await expect(page.getByTestId("clip").first()).toHaveAttribute("aria-label", /video, 0:01\.5/);
  await expect(page.getByTestId("text-bar")).toHaveAttribute("aria-label", /0:01\.0 to 0:02\.5/);
});

test("the timeline zooms and sheets drag closed by their grip", async ({ page }) => {
  await newReel(page, ["exterior.jpg"]);
  const width = async () => (await page.getByTestId("clip").first().boundingBox())!.width;
  const before = await width();
  await page.getByRole("button", { name: "Zoom in" }).click();
  expect(await width()).toBeGreaterThan(before * 1.4);

  await tool(page, "Add media").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(300); // the sheet slides up
  const grip = (await sheet.locator(".sheet-grip").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 4);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(grip.x + grip.width / 2, grip.y + 4 + i * 15);
  await page.mouse.up();
  await expect(sheet).toHaveCount(0);
});
