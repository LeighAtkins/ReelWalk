import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type CDPSession, type Page } from "@playwright/test";

/**
 * ADR 0047: placement on landscape footage, at phone size with touch (the
 * suite's Pixel 7 is 412×915). Every check reads pixels: the loupe against
 * the stage around the finger, and the rendered title against the handles
 * on a later, tracked frame.
 *
 * landscape-pan.mp4 (make-landscape-pan.mjs) is 1280×720: a textured wall
 * with a dark framed panel, panning so the panel slides left 60 px/s.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const tool = (page: Page, name: string) => page.getByRole("navigation", { name: "Editing tools" }).getByRole("button", { name, exact: true });

type Box = { x: number; y: number; width: number; height: number };
type XY = [number, number];

async function planeBox(page: Page): Promise<Box> {
  return (await page.getByTestId("stage-plane").boundingBox())!;
}

/** A finger drag through the Chrome DevTools touch input, holding at the end while `hold` runs. */
async function touchDrag(cdp: CDPSession, from: XY, to: XY, hold?: () => Promise<void>) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
  for (let i = 1; i <= 10; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / 10, y = from[1] + ((to[1] - from[1]) * i) / 10;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  }
  if (hold) await hold();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function cornerCentres(page: Page): Promise<XY[]> {
  const corners = page.getByTestId("surface-corner");
  await expect(corners).toHaveCount(4);
  const out: XY[] = [];
  for (let i = 0; i < 4; i++) {
    const b = (await corners.nth(i).boundingBox())!;
    out.push([b.x + b.width / 2, b.y + b.height / 2]);
  }
  return out;
}

/** Mean colour of square patches of a PNG screenshot, decoded in the page; points and radius in CSS px. */
async function screenPatches(page: Page, png: Buffer, points: XY[], radius: number): Promise<number[][]> {
  return page.evaluate(async ({ b64, points, radius }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = document.createElement("canvas"); c.width = bitmap.width; c.height = bitmap.height;
    const ctx = c.getContext("2d")!; ctx.drawImage(bitmap, 0, 0);
    const k = bitmap.width / window.innerWidth;
    return points.map(([x, y]) => {
      const r = Math.max(1, Math.round(radius * k));
      const d = ctx.getImageData(Math.round(x * k) - r, Math.round(y * k) - r, 2 * r + 1, 2 * r + 1).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
      return sum.map((v) => v / (d.length / 4));
    });
  }, { b64: png.toString("base64"), points, radius });
}

/** Mean colour of square patches of the loupe's own canvas (its pixels, not a screenshot), in loupe px. */
async function loupePatches(page: Page, points: XY[], radius: number): Promise<number[][]> {
  return page.getByTestId("loupe").evaluate((el, { points, radius }) => {
    const ctx = (el as HTMLCanvasElement).getContext("2d")!;
    return points.map(([x, y]) => {
      const d = ctx.getImageData(Math.round(x) - radius, Math.round(y) - radius, 2 * radius + 1, 2 * radius + 1).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
      return sum.map((v) => v / (d.length / 4));
    });
  }, { points, radius });
}

const colourDiff = (a: number[][], b: number[][]) => a.reduce((sum, p, i) => sum + (Math.abs(p[0] - b[i][0]) + Math.abs(p[1] - b[i][1]) + Math.abs(p[2] - b[i][2])) / 3, 0) / a.length;

/**
 * With the finger holding a corner at `at`, the loupe (150 px, ×2.5) must show
 * the stage's pixels around that point: patches just outside the corner's
 * handle on the stage against the same offsets ×2.5 in the loupe. The same
 * comparison against the stage 14 px to the side must be clearly worse, so
 * the check can tell a right loupe from a shifted one.
 */
async function expectLoupeMatchesStage(page: Page, at: XY, label: string) {
  const offsets: XY[] = [[-27, -6], [-27, 6], [-6, -27], [6, -27], [-24, -14], [-14, -24]];
  // The loupe draws black until the frame service has the frame.
  await expect.poll(async () => { const [p] = await loupePatches(page, [[75 + 2.5 * -27, 75 + 2.5 * -6]], 2); return p[0] + p[1] + p[2]; }, { timeout: 15_000 }).toBeGreaterThan(30);
  const png = await page.screenshot();
  const stage = await screenPatches(page, png, offsets.map(([dx, dy]) => [at[0] + dx, at[1] + dy]), 1.5);
  const shifted = await screenPatches(page, png, offsets.map(([dx, dy]) => [at[0] + dx + 14, at[1] + dy]), 1.5);
  const loupe = await loupePatches(page, offsets.map(([dx, dy]) => [75 + 2.5 * dx, 75 + 2.5 * dy]), 3);
  const same = colourDiff(stage, loupe), wrong = colourDiff(shifted, loupe);
  console.log(`${label}: loupe vs stage ${same.toFixed(1)}, vs stage shifted 14 px ${wrong.toFixed(1)} (0-255 per channel)`);
  expect(same, `${label}: the loupe shows the stage's pixels at the corner`).toBeLessThan(16);
  expect(wrong, `${label}: the comparison can tell a shifted loupe`).toBeGreaterThan(same * 2 + 8);
}

/** Drags each corner onto its target (composition fractions); checks the loupe on the first. */
async function placeCorners(page: Page, cdp: CDPSession, targets: XY[], label: string) {
  const plane = await planeBox(page);
  const toScreen = ([u, v]: XY): XY => [plane.x + u * plane.width, plane.y + v * plane.height];
  for (let i = 0; i < 4; i++) {
    const from = (await cornerCentres(page))[i];
    const to = toScreen(targets[i]);
    await touchDrag(cdp, from, to, i === 0 ? async () => { await page.waitForTimeout(150); await expectLoupeMatchesStage(page, to, label); } : undefined);
  }
  const placed = await cornerCentres(page);
  // Handles sit exactly where the finger left them, in the composition's own rectangle.
  placed.forEach((c, i) => { const t = toScreen(targets[i]); expect(Math.hypot(c[0] - t[0], c[1] - t[1])).toBeLessThan(1.5); });
}

/**
 * Where the composition renders the title, by difference: a screenshot with
 * the editing overlays hidden, against the same frame with the title's own
 * element in the composition hidden. The pixels that change are the title.
 */
async function titleBox(page: Page, debugName?: string): Promise<Box | null> {
  const overlays = (hidden: boolean) => page.evaluate((hidden) => { for (const el of document.querySelectorAll<HTMLElement>(".stage-plane, .corners-bar, .placing-strip")) el.style.visibility = hidden ? "hidden" : ""; }, hidden);
  const title = (hidden: boolean) => page.evaluate((hidden) => {
    const player = document.querySelector(".player");
    for (const el of player ? Array.from(player.querySelectorAll<HTMLElement>("span, div")) : []) {
      if (el.children.length === 0 && el.textContent === "WALL") el.style.visibility = hidden ? "hidden" : "";
    }
  }, hidden);
  await overlays(true);
  await page.waitForTimeout(250);
  const withTitle = await page.screenshot(debugName ? { path: `test-results/${debugName}-title.png` } : undefined);
  await title(true);
  await page.waitForTimeout(250);
  const without = await page.screenshot();
  await title(false);
  await overlays(false);
  return page.evaluate(async ({ a, b }) => {
    const decode = async (b64: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = document.createElement("canvas"); c.width = bitmap.width; c.height = bitmap.height;
      const ctx = c.getContext("2d")!; ctx.drawImage(bitmap, 0, 0);
      return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
    };
    const A = await decode(a), B = await decode(b);
    const k = A.width / window.innerWidth;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
      const i = (y * A.width + x) * 4;
      if (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]) > 90) { n++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    if (n < 30) return null;
    return { x: minX / k, y: minY / k, width: (maxX - minX) / k, height: (maxY - minY) / k };
  }, { a: withTitle.toString("base64"), b: without.toString("base64") });
}

/**
 * Puts each corner on its own corner of the frame and checks the 44 px
 * handle there is whole on screen: inside the viewport and the topmost
 * element at its four inset corners (so nothing clips or covers it).
 */
async function expectCornersReachable(page: Page, cdp: CDPSession) {
  const plane = await planeBox(page);
  const view = page.viewportSize()!;
  console.log(`placing frame x ${plane.x.toFixed(1)}–${(plane.x + plane.width).toFixed(1)} of ${view.width}`);
  const extremes: XY[] = [[plane.x, plane.y], [plane.x + plane.width, plane.y], [plane.x + plane.width, plane.y + plane.height], [plane.x, plane.y + plane.height]];
  for (let i = 0; i < 4; i++) {
    const from = (await cornerCentres(page))[i];
    await touchDrag(cdp, from, extremes[i]);
    const box = (await page.getByTestId("surface-corner").nth(i).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
    const painted = await page.evaluate(({ box, i }) => {
      const handle = document.querySelectorAll("[data-testid=surface-corner]")[i];
      const inset = 3;
      return [[box.x + inset, box.y + box.height / 2], [box.x + box.width - inset, box.y + box.height / 2], [box.x + box.width / 2, box.y + inset], [box.x + box.width / 2, box.y + box.height - inset]]
        .every(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit === handle || handle.contains(hit); });
    }, { box, i });
    expect(painted, `corner ${i + 1} is painted whole at the frame's corner`).toBe(true);
  }
}

/** The rendered title lies inside the handles' quad and spans most of it. */
async function expectTitleOnHandles(page: Page, label: string) {
  const quad = await cornerCentres(page);
  await page.screenshot({ path: `test-results/${label.replace(/[^a-z0-9]+/gi, "-")}-handles.png` });
  const box = await titleBox(page, label.replace(/[^a-z0-9]+/gi, "-"));
  expect(box, `${label}: the title is rendered near the handles`).not.toBeNull();
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const qx0 = Math.min(...xs), qx1 = Math.max(...xs), qy0 = Math.min(...ys), qy1 = Math.max(...ys);
  console.log(`${label}: handles x ${qx0.toFixed(1)}–${qx1.toFixed(1)} y ${qy0.toFixed(1)}–${qy1.toFixed(1)}; title x ${box!.x.toFixed(1)}–${(box!.x + box!.width).toFixed(1)} y ${box!.y.toFixed(1)}–${(box!.y + box!.height).toFixed(1)}`);
  const slack = 3;
  expect(box!.x).toBeGreaterThan(qx0 - slack);
  expect(box!.x + box!.width).toBeLessThan(qx1 + slack);
  expect(box!.y).toBeGreaterThan(qy0 - slack);
  expect(box!.y + box!.height).toBeLessThan(qy1 + slack);
  expect(box!.width).toBeGreaterThan((qx1 - qx0) * 0.5);
  return quad;
}

test("placing on landscape footage under Fill and Fit: loupe, handles and tracked plane agree with the picture", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await page.goto("/");
  await page.getByTestId("new-reel-input").setInputFiles(path.join(fixtures, "landscape-pan.mp4"));
  await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 60_000 });
  await expect(page.getByTestId("clip")).toHaveCount(1, { timeout: 120_000 });
  await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());

  await tool(page, "Text").click();
  await page.getByLabel("Text to show").fill("WALL");
  await page.getByRole("group", { name: "Colour" }).getByRole("button", { name: "#3ddc97" }).click();
  await page.getByRole("button", { name: "Add text" }).last().click();

  // ── Fill (the default): landscape footage cropped to the 9:16 frame ──
  await tool(page, "Pin").click();
  await page.getByTestId("surface-corners").click();
  await expect(page.getByTestId("corners-bar")).toBeVisible();
  await page.waitForTimeout(800);
  const cdp = await page.context().newCDPSession(page);

  // The handles' rectangle is the composition as the Player draws it, not the (wider-than-9:16) stage box.
  const plane = await planeBox(page);
  const stageBox = (await page.getByTestId("preview").boundingBox())!;
  console.log(`stage box ${stageBox.width.toFixed(1)}×${stageBox.height.toFixed(1)}, composition ${plane.width.toFixed(1)}×${plane.height.toFixed(1)} at +${(plane.y - stageBox.y).toFixed(1)}`);
  expect(plane.width / plane.height).toBeCloseTo(9 / 16, 3);

  // Every corner can be put on the frame's own corner and stays whole under a thumb.
  await expectCornersReachable(page, cdp);
  // On the dark panel at the shot's first frame.
  await placeCorners(page, cdp, [[0.42, 0.36], [0.88, 0.36], [0.88, 0.54], [0.42, 0.54]], "Fill, first frame");
  const placed = await cornerCentres(page);

  await page.getByTestId("placing-track").click();
  await expect(page.locator(".placing-status")).toContainText(/track/i, { timeout: 120_000 });
  await expect(page.getByTestId("placing-track")).toHaveText("Track", { timeout: 120_000 });
  console.log(`track: ${await page.locator(".placing-status").textContent()}`);
  await expect(page.locator(".placing-status")).toContainText(/Good track|Weak track/);

  // Halfway through the shot the panel has slid left about 0.3 of the frame: the handles follow it…
  await page.getByRole("button", { name: "Show ½" }).click();
  await page.waitForTimeout(1200);
  const later = await cornerCentres(page);
  const moved = later[0][0] - placed[0][0];
  console.log(`handles moved ${moved.toFixed(1)} px at ½ (stage ${plane.width.toFixed(1)} px wide)`);
  expect(moved).toBeLessThan(-0.2 * plane.width);
  // …and sit on the title the composition renders there.
  await expectTitleOnHandles(page, "Fill, ½, tracked");

  // An edit on this later frame: the corner goes where the finger leaves it and the rendered title follows.
  const release: XY = [later[1][0] + 12, later[1][1] - 8];
  await touchDrag(cdp, later[1], release);
  await page.waitForTimeout(600);
  const edited = await cornerCentres(page);
  expect(Math.hypot(edited[1][0] - release[0], edited[1][1] - release[1])).toBeLessThan(1.5);
  await expectTitleOnHandles(page, "Fill, ½, after moving corner 2");
  await page.getByTestId("corners-done").click();
  await page.locator(".sheet-close").click();

  // ── Fit: the whole landscape picture between bands ──
  await page.getByTestId("clip").first().click();
  await tool(page, "Fit").click();
  await page.getByTestId("text-bar").first().click();
  await tool(page, "Pin").click();
  await page.getByTestId("place-corners").click();
  await expect(page.getByTestId("corners-bar")).toBeVisible();
  await page.waitForTimeout(800);
  // The panel at the first frame under Fit: u 0.44–0.81, v 0.42–0.55.
  await placeCorners(page, cdp, [[0.47, 0.44], [0.78, 0.44], [0.78, 0.53], [0.47, 0.53]], "Fit, first frame");
  const placedFit = await cornerCentres(page);
  // Tracked under Fit: the analysis sees the picture alone, so the plane follows the panel, not the backdrop.
  await page.getByTestId("placing-track").click();
  await expect(page.getByTestId("placing-track")).toHaveText("Tracking…", { timeout: 10_000 }).catch(() => undefined);
  await expect(page.getByTestId("placing-track")).toHaveText("Track", { timeout: 120_000 });
  console.log(`Fit track: ${await page.locator(".placing-status").textContent()}`);
  await expect(page.locator(".placing-status")).toContainText(/Good track|Weak track/);
  await page.getByRole("button", { name: "Show ½" }).click();
  await page.waitForTimeout(1200);
  const laterFit = await cornerCentres(page);
  // Under Fit the picture is the full width: 120 source px of 1280 is 0.094 of the frame.
  console.log(`Fit: handles moved ${(laterFit[0][0] - placedFit[0][0]).toFixed(1)} px at ½; expected about ${(-0.094 * plane.width).toFixed(1)}`);
  const turn = (q: XY[]) => (Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180) / Math.PI;
  console.log(`Fit: top edge turned ${(turn(laterFit) - turn(placedFit)).toFixed(1)}° at ½`);
  await expectTitleOnHandles(page, "Fit, ½, tracked");
  await page.getByTestId("corners-done").click();
});
