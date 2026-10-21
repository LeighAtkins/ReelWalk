import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";

/**
 * Inspect (ADR 0057) on the suite's Pixel 7 (412×915, touch through the
 * DevTools touch input). The owner checks AI takes and title edges by
 * magnifying the frame; this reads the zoomed canvas's own pixels and
 * compares them with the source video decoded independently in the page, so
 * "8× shows real detail" is a measurement, not a screenshot by eye.
 *
 * landscape-pan.mp4 is 1280×720, a textured wall panning left 60 px/s: under
 * Fill the frame shows 405 of its 1280 px across.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
type XY = [number, number];
type Box = { x: number; y: number; width: number; height: number };

/** Two fingers from `from` to `to`, moved together in ten steps. */
async function pinch(cdp: CDPSession, from: [XY, XY], to: [XY, XY]) {
  const points = (t: number) => [0, 1].map((k) => ({ id: k, x: from[k][0] + (to[k][0] - from[k][0]) * t, y: from[k][1] + (to[k][1] - from[k][1]) * t }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(0) });
  for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(i / 10) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function doubleTap(cdp: CDPSession, at: XY) {
  for (let i = 0; i < 2; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 0, x: at[0], y: at[1] }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
}

const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Every control is at least 44×44 and clear of the frame: nothing of Inspect's sits on the picture. */
async function expectControlsClear(page: Page, frame: Box) {
  const controls: Locator = page.locator("[data-testid=inspect-bar] button, [data-testid=inspect-tools] button, [data-testid=inspect-scrub]");
  const count = await controls.count();
  expect(count).toBeGreaterThanOrEqual(8);
  const view = page.viewportSize()!;
  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    const box = (await control.boundingBox())!;
    const name = (await control.getAttribute("data-testid")) ?? `control ${i}`;
    expect(box.width, `${name} is thumb-sized`).toBeGreaterThanOrEqual(44);
    expect(box.height, `${name} is thumb-sized`).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
    expect(intersects(box, frame), `${name} is off the picture`).toBe(false);
  }
}

/**
 * Patches of the inspect canvas against the same source pixels of the video,
 * decoded here at its own size and seeked to the time the canvas says it
 * shows. `shift` moves the source patches by that many source px, so the
 * check can tell a right mapping from a nearly right one.
 */
async function canvasAgainstSource(page: Page, shift: number) {
  return page.getByTestId("inspect-canvas").evaluate(async (el, shift) => {
    const c = el as HTMLCanvasElement;
    const [sx, sy, sw, sh] = c.dataset.sourceRect!.split(",").map(Number);
    const video = document.createElement("video");
    video.crossOrigin = "anonymous"; video.muted = true; video.preload = "auto"; video.playsInline = true;
    await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("video")); video.src = c.dataset.src!; });
    await new Promise<void>((resolve) => { video.onseeked = () => resolve(); video.currentTime = Number(c.dataset.seekMs) / 1000; });
    const raw = document.createElement("canvas");
    raw.width = video.videoWidth; raw.height = video.videoHeight;
    const rctx = raw.getContext("2d")!;
    rctx.drawImage(video, 0, 0);
    const shown = c.getContext("2d")!;
    const mean = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number) => {
      const d = ctx.getImageData(Math.round(x - r), Math.round(y - r), Math.max(1, Math.round(2 * r)), Math.max(1, Math.round(2 * r))).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
      return sum.map((v) => v / (d.length / 4));
    };
    const perSource = c.width / sw;
    let total = 0, n = 0;
    for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) {
      const x = (c.width * i) / 6, y = (c.height * j) / 6;
      const a = mean(shown, x, y, 1.5 * perSource);
      const b = mean(rctx, sx + x / perSource + shift, sy + (y / c.height) * sh, 1.5);
      total += (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3; n++;
    }
    return { diff: total / n, source: [raw.width, raw.height], perSource };
  }, shift);
}

// The list reporter prints a failure's message only when the whole suite ends; say it now, with a screenshot.
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  console.log(`inspect failed: ${info.error?.message ?? info.status}`);
  await page.screenshot({ path: "test-results/inspect-failure.png" }).catch(() => undefined);
});

test("Inspect on a phone: pinch to 4×, step a frame, the canvas shows the source's own pixels, controls off the picture", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  await page.goto("/");
  await page.getByTestId("new-reel-input").setInputFiles(path.join(fixtures, "landscape-pan.mp4"));
  await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 60_000 });
  await expect(page.getByTestId("clip")).toHaveCount(1, { timeout: 120_000 });
  await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());

  // The magnifier sits in the preview's control row.
  const entry = page.getByTestId("inspect-button");
  const entryBox = (await entry.boundingBox())!;
  expect(entryBox.width).toBeGreaterThanOrEqual(44);
  await entry.click();
  await expect(page.getByTestId("inspect-bar")).toBeVisible();
  await expect(page.getByTestId("inspect-zoom")).toHaveText("1×");
  // Half a second in, so there is a frame on either side.
  await page.getByTestId("inspect-scrub").fill("1500");
  await expect(page.getByTestId("inspect-bar")).toHaveAttribute("data-now", "1500.000");

  const frame = (await page.getByTestId("inspect-surface").boundingBox())!;
  console.log(`inspect frame x ${frame.x.toFixed(1)}–${(frame.x + frame.width).toFixed(1)}, y ${frame.y.toFixed(1)}–${(frame.y + frame.height).toFixed(1)} of 412×915`);
  expect(frame.width / frame.height).toBeCloseTo(9 / 16, 2);
  await expectControlsClear(page, frame);
  await page.screenshot({ path: "test-results/inspect-final-1x.png" });

  // Footage only: the clip's source frame at its own size.
  await page.getByTestId("inspect-footage").click();
  const canvas = page.getByTestId("inspect-canvas");
  await expect(canvas).toHaveAttribute("data-source-size", "1280,720", { timeout: 30_000 });
  // The original, asked for on opening: a presigned S3 link that expires in 15 minutes, not a library-wide CDN URL.
  await expect(canvas).toHaveAttribute("data-original", "true");
  expect(await canvas.getAttribute("data-src")).toMatch(/X-Amz-Expires=900/);
  await expect(canvas).toHaveAttribute("data-reel-ms", "1500.000", { timeout: 30_000 });
  const wholeWidth = Number((await canvas.getAttribute("data-source-rect"))!.split(",")[2]);
  console.log(`1×: ${wholeWidth.toFixed(1)} source px across`);
  expect(wholeWidth).toBeCloseTo(405, 0);

  // Pinch to 4× over the textured wall, up and left of the panel.
  const cdp = await page.context().newCDPSession(page);
  const mid: XY = [Math.round(frame.x + frame.width * 0.3), Math.round(frame.y + frame.height * 0.12)];
  await pinch(cdp, [[mid[0] - 25, mid[1]], [mid[0] + 25, mid[1]]], [[mid[0] - 100, mid[1]], [mid[0] + 100, mid[1]]]);
  await expect(page.getByTestId("inspect-zoom")).toHaveText("4×");
  const zoomedWidth = Number((await canvas.getAttribute("data-source-rect"))!.split(",")[2]);
  console.log(`4×: ${zoomedWidth.toFixed(1)} source px across`);
  expect(zoomedWidth).toBeCloseTo(405 / 4, 0);
  const view = await page.getByTestId("inspect-surface").getAttribute("data-view");

  // One frame on: the playhead moves a frame, the zoom and the region stay.
  await page.getByTestId("inspect-next").click();
  await expect(page.getByTestId("inspect-bar")).toHaveAttribute("data-now", "1533.333");
  await expect(canvas).toHaveAttribute("data-reel-ms", "1533.333", { timeout: 30_000 });
  expect(await page.getByTestId("inspect-surface").getAttribute("data-view")).toBe(view);
  await expect(page.getByTestId("inspect-zoom")).toHaveText("4×");

  // The canvas's pixels are the source's: against the video decoded here, and clearly worse 12 source px aside.
  const right = await canvasAgainstSource(page, 0);
  const aside = await canvasAgainstSource(page, 12);
  console.log(`canvas vs source ${right.diff.toFixed(1)}, vs source 12 px aside ${aside.diff.toFixed(1)} (0-255); ${right.perSource.toFixed(2)} canvas px per source px; source ${right.source.join("×")}`);
  expect(right.source).toEqual([1280, 720]);
  // At 4× each source pixel covers several canvas pixels: real resolution, not an enlarged 1080-wide frame.
  expect(right.perSource).toBeGreaterThan(4);
  expect(right.diff).toBeLessThan(12);
  expect(aside.diff).toBeGreaterThan(right.diff * 2 + 6);
  await page.screenshot({ path: "test-results/inspect-footage-4x.png" });

  // Above 4× the source pixels show as blocks by default.
  await pinch(cdp, [[mid[0] - 50, mid[1]], [mid[0] + 50, mid[1]]], [[mid[0] - 100, mid[1]], [mid[0] + 100, mid[1]]]);
  await expect(page.getByTestId("inspect-zoom")).toHaveText("8×");
  await expect(page.getByTestId("inspect-smoothing")).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "test-results/inspect-footage-8x.png" });

  // Copy frame: a PNG of the zoomed view, named with the reel time.
  const download = page.waitForEvent("download");
  await page.getByTestId("inspect-copy").click();
  const file = await download;
  console.log(`copied: ${file.suggestedFilename()}`);
  expect(file.suggestedFilename()).toMatch(/^reelwalk-inspect-0m01\.533s-8x-footage\.png$/);
  await file.saveAs("test-results/inspect-copy.png");

  // Final: the Player itself under the same zoom; the controls still clear of the picture.
  await page.getByTestId("inspect-final").click();
  await expect(canvas).toHaveCount(0);
  const transform = await page.locator(".player").evaluate((el) => getComputedStyle(el).transform);
  expect(transform.startsWith("matrix(8, 0, 0, 8,")).toBe(true);
  await expectControlsClear(page, frame);
  await page.screenshot({ path: "test-results/inspect-final-8x.png" });

  // Double-tap: back to the whole frame, and again to 3× at the tap.
  await doubleTap(cdp, mid);
  await expect(page.getByTestId("inspect-zoom")).toHaveText("1×");
  await doubleTap(cdp, mid);
  await expect(page.getByTestId("inspect-zoom")).toHaveText("3×");

  await page.getByTestId("inspect-done").click();
  await expect(page.getByTestId("inspect-bar")).toHaveCount(0);
  expect(await page.locator(".player").evaluate((el) => getComputedStyle(el).transform)).toBe("none");
});
