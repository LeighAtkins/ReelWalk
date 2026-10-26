// Draws the shot analysis (ADR 0086) over the footage, one PNG strip per clip, for a person to judge the readings:
// frames with the saliency peak, the flow arrow, the reframe crop and close-up boxes, depth thumbnails, and a
// timeline of quality, motion segments, flow peaks, best windows, occluders and the crop path.
// Usage: tsx scripts/shot-report.ts <manifest.json> <analysis-dir> <out-dir>   (FFMPEG_PATH for a non-PATH ffmpeg)
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { cropCentreAt, describeShotAnalysis, flowDirection, type ShotAnalysis } from "@reelwalk/core";

const run = promisify(execFile);
const [manifestPath, analysisDir, outDir] = process.argv.slice(2);
if (!manifestPath || !analysisDir || !outDir) throw new Error("Usage: tsx scripts/shot-report.ts <manifest.json> <analysis-dir> <out-dir>");
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
type Entry = { assetId: string; fileName: string; input: string };
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Entry[];
mkdirSync(outDir, { recursive: true });

const WIDTH = 1920, FRAMES = 5, FRAME_H = 200, PAD = 16;
const DIR_COLOUR: Record<string, string> = { left: "#4e9bff", right: "#ff8a3d", up: "#7ad151", down: "#c86bfa", push: "#ffd23f", pull: "#3fd2c7", rotate: "#ff5c8a", static: "#666" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function frameAt(input: string, ms: number, width: number, height: number): Promise<Buffer> {
  const { stdout } = await run(ffmpeg, ["-v", "error", "-ss", (ms / 1000).toFixed(3), "-i", input, "-frames:v", "1", "-vf", `scale=${width}:${height}`, "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function depthPng(sample: ShotAnalysis["depth"][number], width: number, height: number): Promise<Buffer> {
  const bytes = Buffer.from(sample.grid, "base64");
  // A warm ramp for near, cool for far.
  const rgb = Buffer.alloc(sample.cols * sample.rows * 3);
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] / 255;
    rgb[i * 3] = Math.round(40 + 215 * v); rgb[i * 3 + 1] = Math.round(30 + 120 * v * (1 - v) * 4 * 0.6 + 40 * v); rgb[i * 3 + 2] = Math.round(120 * (1 - v) + 20);
  }
  return sharp(rgb, { raw: { width: sample.cols, height: sample.rows, channels: 3 } }).resize(width, height, { kernel: "nearest" }).png().toBuffer();
}

for (const entry of manifest) {
  const name = entry.fileName.replace(/\.\w+$/, "");
  const a = JSON.parse(readFileSync(path.join(analysisDir, `${name}.json`), "utf8")) as ShotAnalysis;
  const aspect = a.width / a.height;
  const frameW = Math.round(FRAME_H * aspect), gap = 8;
  const perRow = Math.max(1, Math.min(FRAMES * (aspect < 1 ? 2 : 1), Math.floor((WIDTH - PAD * 2 + gap) / (frameW + gap))));
  const times = Array.from({ length: perRow }, (_, i) => Math.round(((i + 0.5) * a.durationMs) / perRow / 250) * 250);
  const depthH = 110, depthW = Math.round(depthH * aspect);
  const timelineY = 70 + FRAME_H + 20 + depthH + 30;
  const laneH = 18;
  const height = timelineY + 60 + 4 * laneH + 50 + laneH * 2 + 60 + 40;
  const svg: string[] = [];
  const composites: { input: Buffer; left: number; top: number }[] = [];
  const nearest = (t: number) => a.samples.reduce((best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best), a.samples[0]);

  svg.push(`<text x="${PAD}" y="34" font-family="Segoe UI, sans-serif" font-size="26" fill="#fff" font-weight="600">${esc(entry.fileName)} · ${(a.durationMs / 1000).toFixed(1)} s · ${a.width}×${a.height}</text>`);
  svg.push(`<text x="${PAD}" y="58" font-family="Consolas, monospace" font-size="14" fill="#bbb">${esc(describeShotAnalysis(a).slice(0, 230))}</text>`);

  for (const [i, t] of times.entries()) {
    const x = PAD + i * (frameW + gap), y = 70;
    composites.push({ input: await frameAt(entry.input, t, frameW, FRAME_H), left: x, top: y });
    const s = nearest(t);
    // Reframe crop (yellow) for a source wider than 9:16.
    if (a.reframe && a.reframe.path.length) {
      const w = a.reframe.cropWidth, cx = cropCentreAt(a.reframe.path, t, w).x;
      svg.push(`<rect x="${x + (cx - w / 2) * frameW}" y="${y}" width="${w * frameW}" height="${FRAME_H}" fill="none" stroke="#ffd23f" stroke-width="3"/>`);
    }
    for (const c of a.reframe?.closeUps ?? []) if (t >= c.startMs && t < c.endMs) svg.push(`<rect x="${x + c.box.x * frameW}" y="${y + c.box.y * FRAME_H}" width="${c.box.w * frameW}" height="${c.box.h * FRAME_H}" fill="none" stroke="#3fd2c7" stroke-width="2" stroke-dasharray="6 4"/>`);
    for (const o of a.occluders) if (t >= o.startMs && t < o.endMs) svg.push(`<rect x="${x + 2}" y="${y + 2}" width="${frameW - 4}" height="${FRAME_H - 4}" fill="none" stroke="#ff2bd6" stroke-width="5"/>`);
    // Saliency (red dot, ring by strength).
    const sx = x + s.saliency.x * frameW, sy = y + s.saliency.y * FRAME_H;
    svg.push(`<circle cx="${sx}" cy="${sy}" r="${6 + 18 * s.saliency.strength}" fill="none" stroke="#ff3b3b" stroke-width="2"/><circle cx="${sx}" cy="${sy}" r="5" fill="#ff3b3b"/>`);
    // Flow arrow from the centre: content motion over one second, scaled ×1.5; push/pull as a ring.
    const cx0 = x + frameW / 2, cy0 = y + FRAME_H / 2;
    const ax = cx0 + s.flow.dx * frameW * 3, ay = cy0 + s.flow.dy * frameW * 3;
    const dir = flowDirection(s.flow);
    if (dir === "push" || dir === "pull") svg.push(`<circle cx="${cx0}" cy="${cy0}" r="${20 + Math.min(60, Math.abs(s.flow.zoom) * 600)}" fill="none" stroke="${DIR_COLOUR[dir]}" stroke-width="3" stroke-dasharray="${dir === "pull" ? "4 4" : "0"}"/>`);
    else if (dir === "rotate") svg.push(`<path d="M ${cx0 - 30} ${cy0} A 30 30 0 1 1 ${cx0} ${cy0 + 30}" fill="none" stroke="${DIR_COLOUR.rotate}" stroke-width="4"/>`);
    else if (dir !== "static") svg.push(`<line x1="${cx0}" y1="${cy0}" x2="${ax}" y2="${ay}" stroke="#fff" stroke-width="4"/><circle cx="${ax}" cy="${ay}" r="6" fill="#fff"/>`);
    svg.push(`<rect x="${x}" y="${y + FRAME_H - 22}" width="${frameW}" height="22" fill="rgba(0,0,0,0.6)"/><text x="${x + 6}" y="${y + FRAME_H - 6}" font-family="Consolas, monospace" font-size="13" fill="#fff">${(t / 1000).toFixed(2)}s sh ${s.sharpness.toFixed(2)} st ${s.steady.toFixed(2)} res ${s.flow.residual.toFixed(2)}${s.aesthetic !== undefined ? ` ae ${s.aesthetic.toFixed(2)}` : ""}</text>`);
  }

  // Depth thumbnails.
  const depthY = 70 + FRAME_H + 20;
  svg.push(`<text x="${PAD}" y="${depthY - 4}" font-family="Segoe UI" font-size="13" fill="#aaa">depth (warm = near)</text>`);
  for (const [i, d] of a.depth.entries()) {
    const x = PAD + i * (depthW + 10);
    if (x + depthW > WIDTH) break;
    composites.push({ input: await depthPng(d, depthW, depthH), left: x, top: depthY + 4 });
    if (d.near) svg.push(`<rect x="${x + d.near.x * depthW}" y="${depthY + 4 + d.near.y * depthH}" width="${d.near.w * depthW}" height="${d.near.h * depthH}" fill="none" stroke="#fff" stroke-width="2"/>`);
    svg.push(`<text x="${x + 4}" y="${depthY + depthH}" font-family="Consolas" font-size="12" fill="#fff">${(d.t / 1000).toFixed(2)}s fg ${d.foreground.toFixed(2)} spread ${d.spread.toFixed(2)}</text>`);
  }
  // Palette.
  const palX = WIDTH - PAD - 5 * 44;
  a.scene.palette.forEach((c, i) => svg.push(`<rect x="${palX + i * 44}" y="${depthY + 4}" width="40" height="40" fill="${c.hex}" stroke="#444"/><text x="${palX + i * 44}" y="${depthY + 60}" font-family="Consolas" font-size="11" fill="#aaa">${Math.round(c.share * 100)}%</text>`));
  svg.push(`<text x="${palX}" y="${depthY + 80}" font-family="Consolas" font-size="12" fill="#aaa">rect ${a.scene.rectilinear.toFixed(2)}${a.scene.round ? ` round ${a.scene.round.score.toFixed(2)} @${(a.scene.round.t / 1000).toFixed(1)}s` : ""}${a.scene.blowouts.length ? ` blown ${a.scene.blowouts[0].kind}` : ""}</text>`);

  // Timeline.
  const tx = (t: number) => PAD + (t / a.durationMs) * (WIDTH - PAD * 2);
  const plotY = timelineY, plotH = 60;
  svg.push(`<rect x="${PAD}" y="${plotY}" width="${WIDTH - PAD * 2}" height="${plotH}" fill="#1b1b1b"/>`);
  const line = (pick: (s: ShotAnalysis["samples"][number]) => number | undefined, colour: string, scale = 1) => {
    const points = a.samples.flatMap((s) => { const v = pick(s); return v === undefined ? [] : [`${tx(s.t).toFixed(1)},${(plotY + plotH - Math.min(1, v * scale) * plotH).toFixed(1)}`]; });
    svg.push(`<polyline points="${points.join(" ")}" fill="none" stroke="${colour}" stroke-width="2"/>`);
  };
  line((s) => s.sharpness, "#7ad151");
  line((s) => s.flow.magnitude, "#ff8a3d", 2.5);
  line((s) => s.luma, "#999");
  line((s) => s.steady, "#4e9bff");
  line((s) => s.aesthetic, "#c86bfa");
  for (const ramp of a.scene.brightnessRamps) svg.push(`<rect x="${tx(ramp.startMs)}" y="${plotY}" width="${tx(ramp.endMs) - tx(ramp.startMs)}" height="${plotH}" fill="rgba(255,255,255,0.12)"/>`);
  for (const p of a.flowPeaks) svg.push(`<line x1="${tx(p.t)}" y1="${plotY}" x2="${tx(p.t)}" y2="${plotY + plotH}" stroke="#ff8a3d" stroke-dasharray="3 3"/>`);
  if (a.reframe?.path.length) {
    const pts = a.reframe.path.map((k) => `${tx(k.t).toFixed(1)},${(plotY + plotH - k.x * plotH).toFixed(1)}`).join(" ");
    svg.push(`<polyline points="${pts}" fill="none" stroke="#ffd23f" stroke-width="2" stroke-dasharray="6 3"/>`);
  }
  svg.push(`<text x="${PAD}" y="${plotY - 6}" font-family="Consolas" font-size="12" fill="#aaa"><tspan fill="#7ad151">sharpness</tspan> <tspan fill="#ff8a3d">motion×2.5 (dashed: flow peaks)</tspan> <tspan fill="#999">luma</tspan> <tspan fill="#4e9bff">steady</tspan> <tspan fill="#c86bfa">aesthetic</tspan> <tspan fill="#ffd23f">crop centre x</tspan></text>`);

  let laneY = plotY + plotH + 10;
  for (const set of a.windows) {
    svg.push(`<text x="${PAD}" y="${laneY + 13}" font-family="Consolas" font-size="12" fill="#aaa">${(set.lengthMs / 1000).toFixed(1)}s</text>`);
    set.best.forEach((w, i) => svg.push(`<rect x="${tx(w.startMs)}" y="${laneY}" width="${Math.max(2, tx(w.endMs) - tx(w.startMs))}" height="${laneH - 3}" fill="${i === 0 ? "#2fbf71" : "#1f6e45"}" stroke="#000"/><text x="${tx(w.startMs) + 3}" y="${laneY + 12}" font-family="Consolas" font-size="11" fill="#fff">${w.score.toFixed(2)}</text>`));
    laneY += laneH;
  }
  laneY += 6;
  for (const m of a.motion) svg.push(`<rect x="${tx(m.startMs)}" y="${laneY}" width="${tx(m.endMs) - tx(m.startMs)}" height="${laneH}" fill="${DIR_COLOUR[m.direction]}" stroke="#000"/><text x="${tx(m.startMs) + 3}" y="${laneY + 13}" font-family="Consolas" font-size="12" fill="#000">${m.direction} ${m.mover}</text>`);
  laneY += laneH + 4;
  for (const o of a.occluders) svg.push(`<rect x="${tx(o.startMs)}" y="${laneY}" width="${tx(o.endMs) - tx(o.startMs)}" height="${laneH}" fill="#ff2bd6"/><text x="${tx(o.startMs) + 3}" y="${laneY + 13}" font-family="Consolas" font-size="12" fill="#000">occluder ${o.direction} ${o.coverage.toFixed(2)} ${o.near ? "near" : ""}</text>`);
  for (const c of a.reframe?.closeUps ?? []) svg.push(`<rect x="${tx(c.startMs)}" y="${laneY + laneH + 2}" width="${tx(c.endMs) - tx(c.startMs)}" height="${laneH - 4}" fill="#3fd2c7"/><text x="${tx(c.startMs) + 3}" y="${laneY + laneH + 13}" font-family="Consolas" font-size="11" fill="#000">close-up ${c.sourcePx}px ${c.score.toFixed(2)}</text>`);
  svg.push(`<text x="${PAD}" y="${height - 12}" font-family="Consolas" font-size="12" fill="#888">frames: red = saliency peak (ring = strength), white arrow = content flow (1 s ×3), ring = push (dashed pull), pink arc = rotate, yellow = reframe 9:16 crop, cyan dashed = virtual close-up, magenta = occluder. Lanes: best windows per length (bright = best), motion segments, occluders, close-ups. cost ${a.cost ? `${a.cost.cpuMs} ms cpu / ${a.cost.wallMs} ms wall` : "n/a"}</text>`);

  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">${svg.join("")}</svg>`);
  const out = path.join(outDir, `${name}.png`);
  await sharp({ create: { width: WIDTH, height, channels: 3, background: "#0e0e0e" } }).composite([...composites, { input: overlay, left: 0, top: 0 }]).png().toFile(out);
  console.log(out);
}
writeFileSync(path.join(outDir, "README.md"), `# Shot analysis on Reel 91 (ADR 0086)\n\nOne strip per clip, drawn by apps/worker/scripts/shot-report.ts from the stored analysis JSON beside it.\n`);
