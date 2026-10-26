/**
 * A STAND-IN for the shot analysis (ADR 0086), for proving the cut planner (ADR 0087) on real footage before the
 * worker's analyzer lands. It measures what small grey frames can tell, in the contract's shape:
 *
 *   flow        core's affine flow fit (motion-kind.ts) between the samples either side, per 250 ms
 *   sharpness   Laplacian variance of the 96 px frame, squashed like the contract's
 *   saliency    the peak of a centre-surround contrast map (not spectral residual)
 *   occluders   a dark band of columns (or rows) sweeping across the frame
 *   blowouts    a compact region near white (a window, the sky)
 *   ramps       the mean brightness climbing or falling by 0.15 inside 2 s
 *
 * Not measured: depth (no model here), aesthetics, colour palette, round shapes, close-ups, the reframe path. The
 * planner falls back where these are missing; the proof report says which cuts that touched.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readMotion, type PlannerAnalysis } from "@reelwalk/core";
import { ffmpegBin } from "./acceptance/ffmpeg";

const run = promisify(execFile);
const SAMPLE_MS = 250;
const W = 96;

type Gray = { data: Float32Array; width: number; height: number };
type Flow = PlannerAnalysis["samples"][number]["flow"];
type Direction = PlannerAnalysis["windows"][number]["best"][number]["direction"];

async function greyFrames(file: string, width: number, height: number): Promise<Gray[]> {
  const h = Math.round((W * height) / width / 2) * 2;
  const { stdout } = await run(ffmpegBin(), ["-v", "error", "-i", file, "-vf", `fps=${1000 / SAMPLE_MS},scale=${W}:${h},format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 28 });
  const size = W * h, frames: Gray[] = [];
  for (let at = 0; at + size <= stdout.length; at += size) {
    const data = new Float32Array(size);
    for (let i = 0; i < size; i++) data[i] = stdout[at + i] / 255;
    frames.push({ data, width: W, height: h });
  }
  return frames;
}

function blur(g: Gray, r: number): Float32Array {
  const { width: w, height: h, data } = g;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += data[y * w + xx]; n++; } }
    tmp[y * w + x] = s / n;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; } }
    out[y * w + x] = s / n;
  }
  return out;
}

function sharpness(g: Gray): number {
  const { width: w, height: h, data } = g;
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const lap = 255 * (4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w]);
    sum += lap; sq += lap * lap; n++;
  }
  const variance = sq / n - (sum / n) ** 2;
  return variance / (variance + 600);
}

/** The attention peak inside the columns [x0, x1) (the part of the frame the reel shows), source fractions. */
function saliency(g: Gray, x0 = 0, x1 = 1): { x: number; y: number; strength: number } {
  const fine = blur(g, 1), coarse = blur(g, 8);
  const contrast = new Float32Array(fine.length);
  for (let i = 0; i < fine.length; i++) contrast[i] = Math.abs(fine[i] - coarse[i]) + 0.15 * fine[i];
  const map = blur({ ...g, data: contrast }, 4);
  // The frame's edges are skipped: the blur's clamped border reads as contrast.
  const left = Math.round(g.width * x0), right = Math.round(g.width * x1);
  const mx = Math.round((right - left) * 0.08), my = Math.round(g.height * 0.08);
  let best = 0, at = 0, mean = 0;
  for (let i = 0; i < map.length; i++) {
    mean += map[i];
    const x = i % g.width, y = Math.floor(i / g.width);
    if (x >= left + mx && x < right - mx && y >= my && y < g.height - my && map[i] > best) { best = map[i]; at = i; }
  }
  mean /= map.length;
  return { x: ((at % g.width) + 0.5) / g.width, y: (Math.floor(at / g.width) + 0.5) / g.height, strength: Math.min(1, Math.max(0, (best / Math.max(1e-6, mean) - 1) / 3)) };
}

function direction(flow: { dx: number; dy: number; zoom: number }): Direction {
  const slide = Math.hypot(flow.dx, flow.dy), zoomEdge = Math.abs(flow.zoom) * 0.5;
  if (Math.max(slide, zoomEdge) < 0.02) return "static";
  if (zoomEdge >= slide / 1.33) return flow.zoom > 0 ? "push" : "pull";
  if (Math.abs(flow.dx) >= Math.abs(flow.dy)) return flow.dx > 0 ? "right" : "left";
  return flow.dy > 0 ? "down" : "up";
}

/** The darkest contiguous band of columns (vertical occluders: a door frame, a wall edge): its extent and how dark. */
function darkBand(g: Gray): { from: number; to: number; coverage: number } | null {
  const cols = new Float32Array(g.width);
  for (let x = 0; x < g.width; x++) { let s = 0; for (let y = 0; y < g.height; y++) s += g.data[y * g.width + x]; cols[x] = s / g.height; }
  const sorted = [...cols].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
  let best: { from: number; to: number } | null = null, start = -1;
  for (let x = 0; x <= g.width; x++) {
    const dark = x < g.width && cols[x] < Math.min(0.5 * median, 0.25);
    if (dark && start < 0) start = x;
    if (!dark && start >= 0) { if (!best || x - start > best.to - best.from) best = { from: start, to: x }; start = -1; }
  }
  return best ? { from: best.from / g.width, to: best.to / g.width, coverage: (best.to - best.from) / g.width } : null;
}

export async function measureClip(file: string, info: { width: number; height: number; durationMs: number }): Promise<PlannerAnalysis> {
  const frames = await greyFrames(file, info.width, info.height);
  // The flow fit reads grey levels 0..255 (motion.ts), the rest of this file 0..1.
  const levels = frames.map((g) => ({ ...g, data: g.data.map((v) => v * 255) }));
  const flows: Flow[] = frames.map((_, i) => {
    const a = levels[Math.max(0, i - 1)], b = levels[Math.min(frames.length - 1, i + 1)];
    const read = a === b ? null : readMotion([{ t: Math.max(0, i - 1) * SAMPLE_MS, gray: a }, { t: Math.min(frames.length - 1, i + 1) * SAMPLE_MS, gray: b }]);
    const dx = read?.tx ?? 0, dy = read?.ty ?? 0, zoom = read?.zoom ?? 0;
    return { dx, dy, zoom, magnitude: Math.max(Math.hypot(dx, dy), Math.abs(zoom) / 2), residual: read ? Math.min(1, (1 - read.confidence) * 0.6) : 0.5 };
  });
  // No reframe is drawn yet (ADR 0086's crop path is not on this branch): the reel shows the centred cover crop.
  const crop = info.width / info.height > 9 / 16 ? (9 / 16) / (info.width / info.height) : 1;
  const samples = frames.map((g, i) => {
    const near = flows.slice(Math.max(0, i - 2), i + 3);
    const mx = near.reduce((s, f) => s + f.dx, 0) / near.length, my = near.reduce((s, f) => s + f.dy, 0) / near.length;
    const jitter = Math.hypot(flows[i].dx - mx, flows[i].dy - my);
    let luma = 0; for (const v of g.data) luma += v; luma /= g.data.length;
    return { t: i * SAMPLE_MS, sharpness: Math.round(sharpness(g) * 1000) / 1000, steady: Math.max(0, 1 - jitter / 0.15), luma, flow: flows[i], saliency: saliency(g, 0.5 - crop / 2, 0.5 + crop / 2) };
  });
  const durationMs = info.durationMs;

  const motionCredit = (m: number) => (m <= 0.02 ? 0 : m <= 0.18 ? (m - 0.02) / 0.16 : m <= 0.6 ? 1 : Math.max(0, 1 - (m - 0.6) / 0.6));
  const scoreSpan = (s: number, e: number) => {
    const inside = samples.filter((x) => x.t >= s && x.t < e);
    if (!inside.length) return null;
    const mean = (f: (x: (typeof samples)[number]) => number) => inside.reduce((a, x) => a + f(x), 0) / inside.length;
    const flow = { dx: mean((x) => x.flow.dx), dy: mean((x) => x.flow.dy), zoom: mean((x) => x.flow.zoom) };
    const exposure = mean((x) => (x.luma < 0.12 ? x.luma / 0.12 : x.luma > 0.88 ? (1 - x.luma) / 0.12 : 1));
    const motion = motionCredit(mean((x) => x.flow.magnitude));
    return { startMs: s, endMs: e, score: Math.round((0.35 * mean((x) => x.sharpness) + 0.15 * exposure + 0.2 * mean((x) => x.steady) + 0.3 * motion) * 1000) / 1000, motion, direction: direction(flow) };
  };
  const windows = [800, 1500, 2500, 4000].map((lengthMs) => {
    const scored = [];
    for (let s = 300; s + lengthMs <= durationMs - 300; s += SAMPLE_MS) { const w = scoreSpan(s, s + lengthMs); if (w) scored.push(w); }
    scored.sort((a, b) => b.score - a.score || a.startMs - b.startMs);
    const best: typeof scored = [];
    for (const w of scored) { if (best.length >= 3) break; if (best.every((p) => w.endMs <= p.startMs || w.startMs >= p.endMs)) best.push(w); }
    return { lengthMs, best };
  });

  const dirs = samples.map((s) => direction(s.flow));
  const motion: PlannerAnalysis["motion"] = [];
  dirs.forEach((d, i) => {
    const last = motion[motion.length - 1];
    if (last && last.direction === d) last.endMs = (i + 1) * SAMPLE_MS;
    else motion.push({ startMs: i * SAMPLE_MS, endMs: (i + 1) * SAMPLE_MS, direction: d, magnitude: 0, mover: d === "static" ? "none" : "camera", consistency: 1 });
  });
  for (const segment of motion) {
    const inside = samples.filter((s) => s.t >= segment.startMs && s.t < segment.endMs);
    segment.magnitude = inside.reduce((a, s) => a + s.flow.magnitude, 0) / Math.max(1, inside.length);
  }

  const mags = samples.map((s) => s.flow.magnitude), median = [...mags].sort((a, b) => a - b)[Math.floor(mags.length / 2)] ?? 0;
  const flowPeaks: PlannerAnalysis["flowPeaks"] = [];
  mags.forEach((m, i) => {
    if (i === 0 || i === mags.length - 1 || !(m >= mags[i - 1] && m > mags[i + 1] && m > Math.max(1.5 * median, 0.06))) return;
    if (flowPeaks.some((p) => Math.abs(p.t - i * SAMPLE_MS) < 700)) return;
    flowPeaks.push({ t: i * SAMPLE_MS, magnitude: m, direction: dirs[i], mover: "camera" });
  });

  // Occluders: a dark band covering a quarter of the frame or more for two samples or longer, its centre moving one way.
  const bands = frames.map(darkBand);
  const occluders: PlannerAnalysis["occluders"] = [];
  for (let i = 0; i < bands.length; i++) {
    if (!bands[i] || bands[i]!.coverage < 0.25) continue;
    let j = i;
    while (j + 1 < bands.length && bands[j + 1] && bands[j + 1]!.coverage >= 0.2) j++;
    if (j > i) {
      const first = bands[i]!, last = bands[j]!;
      const move = (last.from + last.to) / 2 - (first.from + first.to) / 2;
      if (Math.abs(move) >= 0.08) {
        const peak = bands.slice(i, j + 1).reduce((b, x, k) => (x!.coverage > bands[b]!.coverage ? i + k : b), i);
        const dir = move > 0 ? "right" : "left";
        occluders.push({ startMs: i * SAMPLE_MS, endMs: (j + 1) * SAMPLE_MS, peakMs: peak * SAMPLE_MS, direction: dir, coverage: bands[peak]!.coverage,
          edgeFrom: dir === "right" ? first.to : first.from, edgeTo: dir === "right" ? last.to : last.from, near: true, score: Math.min(1, bands[peak]!.coverage * 1.4) });
      }
    }
    i = j;
  }

  const blowouts: PlannerAnalysis["scene"]["blowouts"] = [];
  frames.forEach((g, i) => {
    if (i % 4) return;
    let n = 0, x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (let k = 0; k < g.data.length; k++) if (g.data[k] > 0.94) { n++; const x = (k % g.width) / g.width, y = Math.floor(k / g.width) / g.height; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const share = n / g.data.length;
    if (share >= 0.03 && share <= 0.4 && (x1 - x0) * (y1 - y0) < 0.5) blowouts.push({ t: i * SAMPLE_MS, box: { x: x0, y: y0, w: Math.max(0.02, x1 - x0), h: Math.max(0.02, y1 - y0) }, share, kind: y0 < 0.15 && x1 - x0 > 0.6 ? "sky" : "window" });
  });

  const brightnessRamps: PlannerAnalysis["scene"]["brightnessRamps"] = [];
  for (let i = 0; i + 8 < samples.length; i += 4) {
    const a = samples[i].luma, b = samples[i + 8].luma;
    if (Math.abs(b - a) >= 0.15) brightnessRamps.push({ startMs: samples[i].t, endMs: samples[i + 8].t, from: a, to: b, kind: b > a ? "up" : "down" });
  }

  const aspect = info.width / info.height;
  return {
    durationMs, width: info.width, height: info.height, samples, windows, motion, flowPeaks, depth: [], occluders,
    reframe: aspect > 9 / 16 ? { aspect, cropWidth: (9 / 16) / aspect, path: [], closeUps: [] } : null,
    scene: { palette: [], round: null, brightnessRamps: brightnessRamps.slice(0, 8), blowouts: blowouts.slice(0, 8) },
  };
}
