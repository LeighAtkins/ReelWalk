// Debug the surface finder on a real frame: surface-debug.ts <gray.raw 720x1280> <cx frac> <cy frac>
import { readFileSync } from "node:fs";
import { findSurfaceQuad, houghLines, type Gray } from "../src";

const [file, cxs, cys] = process.argv.slice(2);
const width = 720, height = 1280;
const bytes = readFileSync(file);
const data = new Float32Array(width * height);
for (let i = 0; i < data.length; i++) data[i] = bytes[i];
const gray: Gray = { data, width, height };
const cx = Number(cxs) * width, cy = Number(cys) * height;

// Replicate the finder's steps to see where it gives up.
const searchX = 0.42, searchY = 0.3, threshold = 24;
const x0 = Math.round(cx - searchX * width), x1 = Math.round(cx + searchX * width), y0 = Math.round(cy - searchY * height), y1 = Math.round(cy + searchY * height);
const pts: { x: number; y: number; dir: number }[] = [];
for (let y = Math.max(1, y0); y < Math.min(height - 1, y1); y++) for (let x = Math.max(1, x0); x < Math.min(width - 1, x1); x++) {
  const i = y * width + x;
  const gx = data[i + 1] - data[i - 1] + 0.5 * (data[i - width + 1] - data[i - width - 1] + data[i + width + 1] - data[i + width - 1]);
  const gy = data[i + width] - data[i - width] + 0.5 * (data[i + width - 1] - data[i - width - 1] + data[i + width + 1] - data[i - width + 1]);
  if (Math.hypot(gx, gy) >= threshold) pts.push({ x, y, dir: Math.atan2(gy, gx) });
}
const lines = houghLines(pts, width, height, { minVotes: Math.round(Math.min(width, height) * 0.08) });
const deg = (t: number) => Math.round((t * 180) / Math.PI);
const xAt = (l: { theta: number; rho: number }, y: number) => (l.rho - y * Math.sin(l.theta)) / Math.cos(l.theta);
const yAt = (l: { theta: number; rho: number }, x: number) => (l.rho - x * Math.cos(l.theta)) / Math.sin(l.theta);
console.log(`points ${pts.length}, lines ${lines.length}, centre ${cx.toFixed(0)},${cy.toFixed(0)}`);
for (const l of lines.slice(0, 20)) {
  const kind = l.theta < Math.PI / 6 || l.theta > Math.PI - Math.PI / 6 ? `V x@cy=${xAt(l, cy).toFixed(0)}` : Math.abs(l.theta - Math.PI / 2) < Math.PI / 5 ? `H y@cx=${yAt(l, cx).toFixed(0)}` : "diag";
  console.log(`  theta ${deg(l.theta)}° rho ${l.rho.toFixed(0)} votes ${l.votes}  ${kind}`);
}
console.log("result:", JSON.stringify(findSurfaceQuad(gray, cx, cy)));
