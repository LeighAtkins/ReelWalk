// Writes landscape-pan.mp4: 4 s of 1280×720 footage, a textured wall with a
// framed panel, panning steadily left to right (60 px/s of a 1700×900 plate).
// Landscape on purpose: under Fill and Fit it exercises the frame and
// coordinate contract of ADR 0047. Encoded in Chrome with WebCodecs (H.264)
// through mediabunny, so no ffmpeg is needed.
//   node e2e/fixtures/make-landscape-pan.mjs
/* global window, document, Buffer, console */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "package.json"));
const { chromium } = require("@playwright/test");
const bundle = readFileSync(path.join(here, "..", "..", "apps", "web", "node_modules", "mediabunny", "dist", "bundles", "mediabunny.cjs"), "utf8");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
// WebCodecs needs a secure context: serve an empty page from a made-up https origin.
await page.route("https://fixture.invalid/", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>fixture</title>" }));
await page.goto("https://fixture.invalid/");
await page.addScriptTag({ content: `${bundle}\nwindow.Mediabunny = Mediabunny;` });
const bytes = await page.evaluate(async () => {
  const M = window.Mediabunny;
  const plate = document.createElement("canvas");
  plate.width = 1700; plate.height = 900;
  const p = plate.getContext("2d");
  const img = p.createImageData(1700, 900);
  for (let y = 0; y < 900; y++) for (let x = 0; x < 1700; x++) {
    const i = (y * 1700 + x) * 4;
    img.data[i] = 128 + 110 * Math.sin(x / 23) * Math.cos(y / 31);
    img.data[i + 1] = 128 + 110 * Math.sin(x / 41 + y / 17);
    img.data[i + 2] = 128 + 110 * Math.cos(x / 13 - y / 29);
    img.data[i + 3] = 255;
  }
  p.putImageData(img, 0, 0);
  // A dark framed panel with a light border: a surface with clear edges and corners.
  p.fillStyle = "#f4f1e8"; p.fillRect(560, 250, 520, 330);
  p.fillStyle = "#24343c"; p.fillRect(580, 270, 480, 290);
  for (let k = 0; k < 6; k++) { p.fillStyle = k % 2 ? "#d8c070" : "#7a3b2e"; p.fillRect(610 + k * 75, 300 + (k % 3) * 70, 40, 40); }
  const frame = document.createElement("canvas");
  frame.width = 1280; frame.height = 720;
  const f = frame.getContext("2d");
  const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: "in-memory" }), target: new M.BufferTarget() });
  const source = new M.CanvasSource(frame, { codec: "avc", bitrate: 2_000_000, keyFrameInterval: 0.5 });
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  for (let n = 0; n < 120; n++) {
    const t = n / 30;
    f.drawImage(plate, 20 + t * 60, 90, 1280, 720, 0, 0, 1280, 720);
    await source.add(t, 1 / 30);
  }
  await output.finalize();
  return Array.from(new Uint8Array(output.target.buffer));
});
await browser.close();
writeFileSync(path.join(here, "landscape-pan.mp4"), Buffer.from(bytes));
console.log(`landscape-pan.mp4: ${bytes.length} bytes`);
