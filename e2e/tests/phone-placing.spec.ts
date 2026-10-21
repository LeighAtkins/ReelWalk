import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

/**
 * The corner-placing screen at phone size, checked in pixels (ADR 0053).
 * The owner found the placing slips on a phone, by eye: handles too small to
 * grab, a loupe that magnified the wrong place, a play disc over the very spot
 * being placed. These assertions read screenshots, not the DOM: a handle is
 * as big as the pixels it paints, the loupe shows what its pixels show.
 *
 * Pixels are compared by drawing the screenshot with and without one element
 * (hidden by a stylesheet): what changes is exactly what that element paints.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

// A Pixel-7-sized phone at device scale 1, so a screenshot pixel is a CSS pixel.
test.use({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });

type Pixels = { width: number; height: number; data: number[] };
type Box = { x: number; y: number; width: number; height: number };

/** PNG to RGBA through a canvas on a blank page (no image library, and no CSP of the app's in the way). */
async function decode(browser: Browser, png: Buffer): Promise<Pixels> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async (b64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${b64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, data: Array.from(ctx.getImageData(0, 0, image.width, image.height).data) };
    }, png.toString("base64"));
  } finally {
    await page.close();
  }
}

async function shot(page: Page, browser: Browser, clip: Box): Promise<Pixels> {
  // Only what is on the screen: a region past its edge is what the phone cannot show (or be touched on).
  const screen = page.viewportSize()!;
  const x0 = Math.max(0, Math.round(clip.x)), y0 = Math.max(0, Math.round(clip.y));
  const x1 = Math.min(screen.width, Math.round(clip.x + clip.width)), y1 = Math.min(screen.height, Math.round(clip.y + clip.height));
  const rounded = { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
  return decode(browser, await page.screenshot({ clip: rounded, animations: "disabled", caret: "hide" }));
}

/** The same region drawn with `selector` hidden: the difference is what it paints there. */
async function without(page: Page, selector: string, take: () => Promise<Pixels>): Promise<Pixels> {
  const style = await page.addStyleTag({ content: `${selector} { visibility: hidden !important; }` });
  try {
    await page.waitForTimeout(100);
    return await take();
  } finally {
    await style.evaluate((node) => node.parentNode?.removeChild(node));
  }
}

/** Bounding box (in the region's pixels) of the pixels that differ by more than `threshold` in any channel. */
function changed(a: Pixels, b: Pixels, threshold = 40): { left: number; top: number; right: number; bottom: number; count: number } | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, count = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = (y * a.width + x) * 4;
    if (Math.max(Math.abs(a.data[p] - b.data[p]), Math.abs(a.data[p + 1] - b.data[p + 1]), Math.abs(a.data[p + 2] - b.data[p + 2])) <= threshold) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); count++;
  }
  return count ? { left, top, right, bottom, count } : null;
}

/** Mean colour difference between a disc of the loupe and the same disc of a stage crop scaled to the loupe's size (nearest pixel). */
function discDifference(loupe: Pixels, stage: Pixels, radius: number): number {
  const cx = loupe.width / 2, cy = loupe.height / 2;
  let total = 0, n = 0;
  for (let y = 0; y < loupe.height; y++) for (let x = 0; x < loupe.width; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    // Inside the disc, away from the loupe's cross-hair.
    if (dx * dx + dy * dy > radius * radius || Math.abs(dx) < 3 || Math.abs(dy) < 3) continue;
    const sx = Math.min(stage.width - 1, Math.floor((x / loupe.width) * stage.width)), sy = Math.min(stage.height - 1, Math.floor((y / loupe.height) * stage.height));
    const p = (y * loupe.width + x) * 4, q = (sy * stage.width + sx) * 4;
    total += (Math.abs(loupe.data[p] - stage.data[q]) + Math.abs(loupe.data[p + 1] - stage.data[q + 1]) + Math.abs(loupe.data[p + 2] - stage.data[q + 2])) / 3;
    n++;
  }
  return total / Math.max(1, n);
}

async function centreOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function openPlacing(page: Page) {
  await page.goto("/");
  await page.getByTestId("new-reel-input").setInputFiles([path.join(fixtures, "walkthrough.mp4")]);
  await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByTestId("clip")).toHaveCount(1, { timeout: 60_000 });
  // A one-letter title: it sits in the middle of its surface, leaving the corners' surroundings bare footage.
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByLabel("Text to show").fill("I");
  await page.getByRole("button", { name: "Add text" }).last().click();
  await page.getByRole("navigation", { name: "Editing tools" }).getByRole("button", { name: "Pin", exact: true }).click();
  await page.getByTestId("surface-corners").click();
  await expect(page.locator(".stage.is-placing")).toBeVisible();
  await expect(page.getByTestId("surface-corner")).toHaveCount(4);
  // The picture is up: a decoded frame in the stage's video.
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLVideoElement>("[data-testid=preview] video")).some((v) => v.readyState >= 2 && v.videoWidth > 0), undefined, { timeout: 30_000 });
  await page.waitForTimeout(500);
}

// Found by this spec's first CI run (2026-10-21): in placing mode the stage was about 418 px wide from x = 30
// on a 412 px screen, so the right-hand corners sat 6 px from the edge and painted 30 px of their 44. Fixed in
// PR #196 (ADR 0047): the placing frame fits the screen at 9:16 with a 44 px gutter each side.
test("corner placing at phone size: the stage and every corner handle fit the screen, thumb-sized", async ({ page, browser }) => {
  await openPlacing(page);
  const stage = (await page.getByTestId("preview").boundingBox())!;
  const screen = page.viewportSize()!;
  test.info().annotations.push({ type: "stage", description: `placing stage ${Math.round(stage.x)}..${Math.round(stage.x + stage.width)} × ${Math.round(stage.y)}..${Math.round(stage.y + stage.height)} on a ${screen.width}×${screen.height} screen` });
  expect.soft(stage.x >= 0 && stage.x + stage.width <= screen.width && stage.y >= 0 && stage.y + stage.height <= screen.height, "the placing stage runs off the screen").toBe(true);

  // Every corner handle paints at least 44 × 44 px (a fingertip) on the screen: a handle cut by the screen's
  // edge paints, and can be touched, only where it is on screen.
  for (const [i, corner] of (await page.getByTestId("surface-corner").all()).entries()) {
    const c = await centreOf(corner);
    const region = { x: c.x - 40, y: c.y - 40, width: 80, height: 80 };
    const shown = await shot(page, browser, region);
    const hidden = await without(page, ".surface-corner", () => shot(page, browser, region));
    const painted = changed(shown, hidden);
    expect.soft(painted, `corner ${i + 1} paints nothing`).not.toBeNull();
    if (!painted) continue;
    const size = { width: painted.right - painted.left + 1, height: painted.bottom - painted.top + 1 };
    test.info().annotations.push({ type: "corner", description: `corner ${i + 1} at ${Math.round(c.x)},${Math.round(c.y)} paints ${size.width}×${size.height} px` });
    expect.soft(size.width, `corner ${i + 1} is ${size.width} px wide`).toBeGreaterThanOrEqual(44);
    expect.soft(size.height, `corner ${i + 1} is ${size.height} px tall`).toBeGreaterThanOrEqual(44);
  }
});

test("corner placing at phone size: a true loupe and a clear centre", async ({ page, browser }) => {
  await openPlacing(page);
  const stage = (await page.getByTestId("preview").boundingBox())!;

  // While a corner is dragged, the loupe shows the footage under the finger, not somewhere else.
  const first = page.getByTestId("surface-corner").first();
  const from = await centreOf(first);
  const to = { x: stage.x + stage.width * 0.3, y: stage.y + stage.height * 0.5 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  await page.waitForTimeout(400);
  const loupe = page.locator("canvas.loupe");
  await expect(loupe).toBeVisible();
  const lb = (await loupe.boundingBox())!;
  // The canvas inside its 2 px border.
  const loupePixels = await shot(page, browser, { x: lb.x + 2, y: lb.y + 2, width: lb.width - 4, height: lb.height - 4 });
  // The stage under the finger with every overlay hidden: what the loupe should magnify (150 px at 2.5×: 60 px).
  const span = (lb.width - 4) / 2.5;
  const crops = new Map<string, Pixels>();
  await without(page, ".loupe, .surface-corner, .surface-outline, .surface-bar-edge, .corners-bar, .placing-strip", async () => {
    for (const [name, dx, dy] of [["finger", 0, 0], ["left", -span / 2, 0], ["right", span / 2, 0], ["up", 0, -span / 2], ["down", 0, span / 2]] as const) {
      crops.set(name, await shot(page, browser, { x: to.x + dx - span / 2, y: to.y + dy - span / 2, width: span, height: span }));
    }
    return crops.get("finger")!;
  });
  await page.mouse.up();
  const radius = (lb.width - 4) / 2 - 6;
  const scores = Object.fromEntries([...crops].map(([name, crop]) => [name, discDifference(loupePixels, crop, radius)]));
  test.info().annotations.push({ type: "loupe", description: `mean difference, loupe vs stage crop: ${JSON.stringify(Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Number(v.toFixed(1))])))}` });
  // The loupe matches the footage under the finger (the threshold allows the video's scaling and compression)…
  expect(scores.finger, "the loupe does not show the stage under the finger").toBeLessThan(28);
  // …better than it matches the footage half a loupe to either side (the fixture's colour bars run up and down, so only sideways is a fair test).
  expect(scores.finger).toBeLessThan(Math.min(scores.left, scores.right) - 8);

  // Nothing covers the middle of the stage while placing: the play disc (or anything else) stays out of it.
  const middle = { x: stage.x + stage.width * 0.3, y: stage.y + stage.height * 0.35, width: stage.width * 0.4, height: stage.height * 0.3 };
  const placingMiddle = await shot(page, browser, middle);
  const placingBare = await without(page, ".play-badge, .stage-tap, .theater-close", () => shot(page, browser, middle));
  expect(changed(placingMiddle, placingBare), "a play control is drawn over the stage centre while placing").toBeNull();

  // And in the editor, paused: the play badge stays out of the centre.
  await page.getByTestId("corners-done").click();
  await expect(page.locator(".stage.is-placing")).toHaveCount(0);
  // A settled, paused stage: a decoded frame and a paused player, so the badge's state is not a race.
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLVideoElement>("[data-testid=preview] video")).some((v) => v.readyState >= 2 && v.paused), undefined, { timeout: 30_000 });
  await expect(page.getByTestId("preview").getByRole("button", { name: "Play" })).toBeVisible();
  await page.waitForTimeout(300);
  const editorStage = (await page.getByTestId("preview").boundingBox())!;
  const whole = { x: editorStage.x, y: editorStage.y, width: editorStage.width, height: editorStage.height };
  const withBadge = await shot(page, browser, whole);
  const noBadge = await without(page, ".play-badge", () => shot(page, browser, whole));
  const badge = changed(withBadge, noBadge);
  // The badge sits in the stage's bottom-left corner, where the Pin sheet (still open after placing) can cover it
  // on main's CI; that is not a defect. What matters is that, where it is drawn, it is not over the centre.
  test.info().annotations.push({ type: "play", description: badge ? `play badge paints ${badge.left}–${badge.right} × ${badge.top}–${badge.bottom} of a ${Math.round(editorStage.width)}×${Math.round(editorStage.height)} stage` : "play badge not visible on the paused stage (covered by the open sheet or not drawn)" });
  if (badge) {
    const centre = { x: editorStage.width / 2, y: editorStage.height / 2 };
    const clear = Math.min(editorStage.width, editorStage.height) * 0.2;
    const overlapsCentre = badge.right >= centre.x - clear && badge.left <= centre.x + clear && badge.bottom >= centre.y - clear && badge.top <= centre.y + clear;
    expect(overlapsCentre, "the play badge covers the stage centre").toBe(false);
  }
});
