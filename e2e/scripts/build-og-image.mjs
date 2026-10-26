/* global process, console, fetch, Buffer, document */
/**
 * Builds the link-preview image (ADR 0081): 1200x630, a phone showing a real
 * ReelWalk sample-reel frame, and "Your listing, as a reel, in a minute." in
 * the brand serif. Run from the repo root after `pnpm install`:
 *
 *   node e2e/scripts/build-og-image.mjs
 *
 * It writes apps/web/public/og/reelwalk-1200x630.png, which the root layout
 * and /pricing name in their openGraph and twitter tags. Playwright's Chromium
 * draws the page, so the fonts are the app's own (Bodoni Moda, Archivo, from
 * the same @fontsource-variable packages the web app imports) and the picture is
 * the sample reel's poster frame from the CDN the landing page plays them from.
 *
 * The sample posters carry US listing details baked into the frame. This image is
 * for Australian ads, so the details card of the frame is redrawn with an
 * Australian listing, exactly where and as large as the app draws it. To use a
 * frame from a real Australian export instead, pass its path as the first
 * argument (a 1080x1920 JPEG or PNG) and the card is left as it is: pass --keep-card.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromWeb = createRequire(path.join(root, "apps/web/package.json"));
const POSTER = "https://dh5xvp6apljoh.cloudfront.net/samples/us-country-house-poster.jpg";

const args = process.argv.slice(2);
const keepCard = args.includes("--keep-card");
const framePath = args.find((arg) => !arg.startsWith("--"));

async function dataUrl(file, type) {
  return `data:${type};base64,${(await readFile(file)).toString("base64")}`;
}

async function fontUrl(pkg, file) {
  return dataUrl(path.join(path.dirname(requireFromWeb.resolve(`${pkg}/package.json`)), "files", file), "font/woff2");
}

async function frame() {
  if (framePath) return dataUrl(path.resolve(framePath), framePath.endsWith(".png") ? "image/png" : "image/jpeg");
  const response = await fetch(POSTER);
  if (!response.ok) throw new Error(`Could not fetch the sample poster: ${response.status}`);
  return `data:image/jpeg;base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}

const bodoni = await fontUrl("@fontsource-variable/bodoni-moda", "bodoni-moda-latin-opsz-normal.woff2");
const archivo = await fontUrl("@fontsource-variable/archivo", "archivo-latin-wdth-normal.woff2");
const picture = await frame();

// The phone's screen is the 1080x1920 frame scaled to fit; the card is drawn in frame pixels.
const SCALE = 0.29;
const card = keepCard
  ? ""
  : `<div class="card">
       <div class="price">$1,850,000</div>
       <div class="facts">4 bed <i></i> 3 bath <i></i> 270 m²</div>
       <div class="where">Bronte NSW</div>
       <div class="when">Open home Sat 11–11:30</div>
     </div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Bodoni Moda Variable"; src: url(${bodoni}) format("woff2"); font-weight: 400 900; }
@font-face { font-family: "Archivo Variable"; src: url(${archivo}) format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }
* { box-sizing: border-box; }
html, body { margin: 0; width: 1200px; height: 630px; background: #0a0a0a; overflow: hidden; }
body { position: relative; color: #f3ede2; font-family: "Archivo Variable", system-ui, sans-serif;
  background: radial-gradient(900px 520px at 78% 48%, #26211c 0%, #0a0a0a 70%); }
.brand { position: absolute; left: 76px; top: 64px; font: 500 26px/1 "Bodoni Moda Variable", serif; letter-spacing: 0.28em; text-transform: uppercase; font-variation-settings: "opsz" 28; }
h1 { position: absolute; left: 76px; top: 168px; width: 620px; margin: 0; font: 500 76px/1.06 "Bodoni Moda Variable", serif; font-variation-settings: "opsz" 96; letter-spacing: -0.01em; }
.sub { position: absolute; left: 76px; bottom: 112px; margin: 0; width: 560px; font-size: 25px; line-height: 1.4; color: #a89f93; }
.url { position: absolute; left: 76px; bottom: 56px; font-size: 22px; letter-spacing: 0.04em; color: #f3ede2; }
.phone { position: absolute; left: 770px; top: 36px; width: 336px; height: 598px; padding: 11px; border-radius: 46px; background: #151412;
  border: 2px solid rgb(243 237 226 / 0.28); box-shadow: 0 30px 80px rgb(0 0 0 / 0.65), 0 0 0 1px rgb(0 0 0 / 0.6); transform: rotate(3deg); transform-origin: center; }
.screen { position: relative; width: 310px; height: 552px; border-radius: 36px; overflow: hidden; background: #000; }
.frame { position: absolute; left: 0; top: 0; width: 1080px; height: 1920px; transform: scale(${SCALE}); transform-origin: 0 0; }
.frame img { position: absolute; inset: 0; width: 1080px; height: 1920px; display: block; }
.card { position: absolute; left: 60px; top: 1000px; width: 900px; height: 390px; padding: 44px 60px; border-radius: 40px; background: #1b2c44; border-left: 12px solid #e2452c; }
.price { font: 800 104px/1.1 "Archivo Variable", sans-serif; font-stretch: 118%; letter-spacing: -0.01em; }
.facts { margin-top: 14px; font: 700 54px/1.2 "Archivo Variable", sans-serif; font-stretch: 70%; }
.facts i { display: inline-block; width: 4px; height: 38px; margin: 0 22px; background: #e2452c; vertical-align: -4px; }
.where { margin-top: 12px; font: 400 44px/1.2 "Archivo Variable", sans-serif; color: #8fa3bd; }
.when { margin-top: 14px; font: 700 44px/1.2 "Archivo Variable", sans-serif; }
</style></head><body>
<div class="brand">ReelWalk</div>
<h1>Your listing, as a reel, in a minute.</h1>
<p class="sub">Listing reels for Australian real-estate agents, made on your phone.</p>
<div class="url">reelwalking.com</div>
<div class="phone"><div class="screen"><div class="frame"><img src="${picture}" alt="">${card}</div></div></div>
</body></html>`;

const out = path.join(root, "apps/web/public/og/reelwalk-1200x630.png");
await mkdir(path.dirname(out), { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await writeFile(out, await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1200, height: 630 } }));
} finally {
  await browser.close();
}
console.log(`wrote ${path.relative(root, out)}`);
