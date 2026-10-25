/**
 * Runs the surface finder (ADR 0075) on real footage and draws what it proposes: the contact sheet in
 * docs/adr/assets/0075-surfaces.png, and a JSON report of every candidate.
 *
 *   tsx scripts/surface-sheet.mts --ffmpeg /path/to/ffmpeg --out sheet.png [--title "THE LODGE"] [--regions regions.json]
 *       [--json report.json] [--cols 4] file.mp4@seconds[=label] ...
 *
 * Each frame is read as the composition shows it (a cover crop to 9:16) at the tracker's size, 360×640.
 * `--regions` is a map from the spec's label to { regions, horizonY } (what the vision call returns), for
 * trying the fusion with labels from somewhere else; without it only the geometry runs.
 * Not part of the app: a tool for looking at the finder's work.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { findSurfaces, titleAspect, type Gray, type SurfaceHints, type SurfaceSearch } from "@reelwalk/core";

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flagged = new Set(["--ffmpeg", "--out", "--title", "--regions", "--json", "--cols"]);
const specs = args.filter((a, i) => !a.startsWith("--") && !flagged.has(args[i - 1] ?? ""));
const ffmpeg = option("ffmpeg", "ffmpeg")!;
const out = option("out", "surfaces.png")!;
const title = option("title", "THE LODGE")!;
const cols = Number(option("cols", "4"));
const hints: Record<string, SurfaceHints> = option("regions") ? JSON.parse(readFileSync(option("regions")!, "utf8")) : {};
const W = 360, H = 640;
const scratch = mkdtempSync(join(tmpdir(), "surface-sheet-"));
const COLORS = ["#ffb000", "#27c4e8", "#e24bd0"];

const filter = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
const frames: { label: string; png: Buffer; result: SurfaceSearch; ms: number }[] = [];
for (const spec of specs) {
  const eq = spec.lastIndexOf("=");
  const target = eq >= 0 ? spec.slice(0, eq) : spec, label = eq >= 0 ? spec.slice(eq + 1) : spec;
  const at = target.lastIndexOf("@");
  const file = target.slice(0, at), seconds = target.slice(at + 1);
  const raw = execFileSync(ffmpeg, ["-v", "error", "-ss", seconds, "-i", file, "-frames:v", "1", "-vf", filter, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 26 });
  const png = execFileSync(ffmpeg, ["-v", "error", "-ss", seconds, "-i", file, "-frames:v", "1", "-vf", filter, "-f", "image2pipe", "-vcodec", "png", "-"], { maxBuffer: 1 << 26 });
  const gray: Gray = { data: Float32Array.from(raw), width: W, height: H };
  const t0 = performance.now();
  const result = findSurfaces(gray, { aspect: titleAspect(title) }, hints[label] ?? {});
  frames.push({ label, png, result, ms: performance.now() - t0 });
}

const poly = (q: number[]) => [0, 1, 2, 3].map((i) => `${(q[i * 2] * W).toFixed(1)},${(q[i * 2 + 1] * H).toFixed(1)}`).join(" ");
const tiles = await Promise.all(frames.map(async (f) => {
  const shapes = f.result.candidates.map((c, i) => {
    const color = COLORS[i % COLORS.length];
    const cx = (c.plane[0] + c.plane[2] + c.plane[4] + c.plane[6]) / 4 * W, cy = (c.plane[1] + c.plane[3] + c.plane[5] + c.plane[7]) / 4 * H;
    return `<polygon points="${poly(c.plane)}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="6 4"/>`
      + `<polygon points="${poly(c.placement)}" fill="${color}" fill-opacity="0.45" stroke="${color}" stroke-width="2"/>`
      + `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="13" fill="#000" fill-opacity="0.7"/><text x="${cx.toFixed(1)}" y="${(cy + 5).toFixed(1)}" font-family="sans-serif" font-size="15" font-weight="700" fill="${color}" text-anchor="middle">${i + 1}</text>`;
  }).join("");
  const legend = f.result.candidates.map((c, i) => `${i + 1} ${c.label} ${c.tracking === "surface" ? "follows" : "fixed"} ${Math.round(c.area * 100)}%`);
  const caption = `<rect x="0" y="${H}" width="${W}" height="${22 + 17 * Math.max(1, legend.length)}" fill="#14110d"/>`
    + `<text x="8" y="${H + 16}" font-family="sans-serif" font-size="13" font-weight="700" fill="#f4eee2">${f.label}  (${f.ms.toFixed(0)} ms)</text>`
    + legend.map((l, i) => `<text x="8" y="${H + 34 + 17 * i}" font-family="sans-serif" font-size="12" fill="${COLORS[i % 3]}">${l}</text>`).join("")
    + (legend.length === 0 ? `<text x="8" y="${H + 34}" font-family="sans-serif" font-size="12" fill="#c9bfa8">nothing it can stand behind</text>` : "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 22 + 17 * Math.max(1, legend.length)}">${shapes}${caption}</svg>`;
  const base = await sharp({ create: { width: W, height: H + 22 + 17 * 4, channels: 3, background: "#14110d" } }).composite([{ input: f.png, top: 0, left: 0 }, { input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
  return base;
}));

const rows = Math.ceil(tiles.length / cols), tileH = H + 22 + 17 * 4;
const gap = 6;
const sheet = sharp({ create: { width: cols * (W + gap) + gap, height: rows * (tileH + gap) + gap, channels: 3, background: "#0b0907" } })
  .composite(tiles.map((input, i) => ({ input, left: gap + (i % cols) * (W + gap), top: gap + Math.floor(i / cols) * (tileH + gap) })));
await sheet.png().toFile(out);
if (option("json")) writeFileSync(option("json")!, JSON.stringify(frames.map((f) => ({ label: f.label, ms: Math.round(f.ms), horizonY: f.result.horizonY, lines: f.result.lines, candidates: f.result.candidates, rejected: f.result.rejected })), null, 2));
rmSync(scratch, { recursive: true, force: true });
console.log(`wrote ${out}: ${frames.length} frames, ${frames.reduce((n, f) => n + f.result.candidates.length, 0)} candidates, mean ${(frames.reduce((s, f) => s + f.ms, 0) / frames.length).toFixed(0)} ms each`);
