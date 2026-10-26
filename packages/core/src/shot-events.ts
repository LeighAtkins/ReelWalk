/**
 * Events across a clip's samples (ADR 0086): steadiness, occluders sweeping the
 * lens, light changes, the reframe's raw targets and virtual close-ups. Pure:
 * the worker hands in per-sample measurements, these turn them into the
 * contract's lists.
 */
import { cropWidthFor } from "./crop-path";
import type { CloseUp, Occluder, SceneFacts, ShotSample } from "./shot-analysis";
import type { Strip } from "./shot-pixels";

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Flow jitter (frame widths a second) that halves the steadiness score: a handheld walk's sway. */
export const JITTER_HALF = 0.05;

/**
 * Steadiness per sample: 1 minus the share of the flow that is high-frequency shake, read as the distance of each
 * sample's flow from the mean of its neighbours (±`radius` samples). A smooth glide or a locked-off shot scores 1.
 */
export function steadiness(flows: readonly { dx: number; dy: number }[], radius = 2): number[] {
  return flows.map((_, i) => {
    let sx = 0, sy = 0, n = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(flows.length - 1, i + radius); k++) { sx += flows[k].dx; sy += flows[k].dy; n++; }
    const jitter = Math.hypot(flows[i].dx - sx / n, flows[i].dy - sy / n);
    return round3(1 / (1 + (jitter / JITTER_HALF) ** 2));
  });
}

/** One sample's strips, for occluder finding: `t` source ms, and the analysed frame's width in px. */
export type StripSample = { t: number; strips: Strip[]; width: number };

/** Whether each strip is covered by something near or dark passing the lens. */
export function occludedStrips(strips: readonly Strip[]): boolean[] {
  const sorted = (pick: (s: Strip) => number) => strips.map(pick).sort((a, b) => a - b);
  const median = (values: number[]) => values[Math.floor(values.length / 2)] ?? 0;
  const background = median(sorted((s) => s.shift)), luma = median(sorted((s) => s.luma)), texture = median(sorted((s) => s.texture));
  return strips.map((s) => {
    const faster = Math.abs(s.shift - background) >= Math.max(2, Math.abs(background) * 0.6);
    // Parallax: a near thing moves the same way as the background, but faster; or across a still frame.
    const parallax = faster && (Math.abs(background) < 1 || Math.sign(s.shift) === Math.sign(background));
    // Soft and set apart in brightness: a door frame or wall edge close to the lens, out of focus (darker, or a wall
    // of another colour), which block matching cannot follow.
    const softApart = s.texture < texture * 0.3 && Math.abs(s.luma - luma) > Math.max(0.08, luma * 0.25);
    return parallax || softApart;
  });
}

/** Every run of `true`, as [from, to] strip indexes (inclusive). */
function runsOf(flags: readonly boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    let j = i;
    while (j + 1 < flags.length && flags[j + 1]) j++;
    runs.push([i, j]);
    i = j;
  }
  return runs;
}

/**
 * Windows where a near or soft thing sweeps across the frame. Every occluded band of every sample (at least
 * `minCoverage` of the width) is linked to the band it overlaps in the sample before (one missed sample allowed), so a
 * still dark wall on one side and a post sweeping out on the other are followed apart. A track needs two samples and
 * must move (its strips shift, or its centre travels): a band that sits still the whole time (a vignette, a fixed wall)
 * is not a sweep. The direction is the band's motion; `near` when parallax, not softness, marked most of it.
 */
export function detectOccluders(series: readonly StripSample[], { minCoverage = 0.16, stepMs }: { minCoverage?: number; stepMs?: number } = {}): Occluder[] {
  if (series.length < 2) return [];
  const step = stepMs ?? series[1].t - series[0].t;
  type Band = { t: number; index: number; from: number; to: number; shift: number; parallax: number };
  type Track = { bands: Band[]; lastIndex: number };
  const tracks: Track[] = [];
  series.forEach(({ t, strips }, index) => {
    const sorted = strips.map((s) => s.shift).sort((a, b) => a - b);
    const background = sorted[Math.floor(sorted.length / 2)];
    // Any band may continue a track (a wall edge leaving the frame narrows to one strip); only a wide one starts one.
    const bands: (Band & { wide: boolean })[] = runsOf(occludedStrips(strips))
      .map(([a, b]) => {
        const inside = strips.slice(a, b + 1);
        const parallax = inside.filter((s) => Math.abs(s.shift - background) >= Math.max(2, Math.abs(background) * 0.6)).length / inside.length;
        return { t, index, from: a / strips.length, to: (b + 1) / strips.length, shift: inside.reduce((sum, s) => sum + s.shift, 0) / inside.length, parallax, wide: (b - a + 1) / strips.length >= minCoverage - 1e-9 };
      });
    for (const band of bands) {
      const open = tracks.filter((track) => index - track.lastIndex <= 2);
      const last = (track: Track) => track.bands[track.bands.length - 1];
      const overlap = (track: Track) => Math.min(last(track).to, band.to) - Math.max(last(track).from, band.from);
      const into = open.filter((track) => overlap(track) > -1e-6).sort((a, b) => overlap(b) - overlap(a))[0];
      if (into && into.lastIndex !== index) { into.bands.push(band); into.lastIndex = index; }
      else if (band.wide) tracks.push({ bands: [band], lastIndex: index });
    }
  });

  const out: Occluder[] = [];
  for (const { bands } of tracks) {
    if (bands.length < 2) continue;
    const first = bands[0], last = bands[bands.length - 1];
    // How far an edge of the band travelled: a wall edge leaving the frame moves its inner edge while the outer one stays.
    const travel = Math.abs(last.from - first.from) >= Math.abs(last.to - first.to) ? last.from - first.from : last.to - first.to;
    const meanShift = bands.reduce((a, h) => a + h.shift, 0) / bands.length;
    // More than one strip of travel (a strip flickering in and out at a still wall's edge is not a sweep).
    if (Math.abs(travel) < 0.12 && Math.abs(meanShift) < 1.5) continue;
    const rightward = Math.abs(meanShift) >= 1.5 ? meanShift > 0 : travel > 0;
    const peak = bands.reduce((a, h) => (h.to - h.from > a.to - a.from ? h : a), first);
    const coverage = peak.to - peak.from;
    const parallax = bands.reduce((a, h) => a + h.parallax, 0) / bands.length;
    const consistent = bands.filter((h) => Math.sign(h.shift) === (rightward ? 1 : -1) || Math.abs(h.shift) < 1).length / bands.length;
    out.push({
      startMs: first.t,
      endMs: last.t + step,
      peakMs: peak.t,
      direction: rightward ? "right" : "left",
      coverage: round3(coverage),
      // The edge that moves most (an entering post's leading edge, a leaving wall's inner edge): the line a wipe follows.
      edgeFrom: round3(Math.abs(last.from - first.from) >= Math.abs(last.to - first.to) ? first.from : first.to),
      edgeTo: round3(Math.abs(last.from - first.from) >= Math.abs(last.to - first.to) ? last.from : last.to),
      near: parallax >= 0.5,
      score: round3(clamp01(Math.min(1, coverage * 2) * (0.5 + 0.5 * consistent) * (parallax >= 0.5 ? 1 : 0.7) * Math.min(1, bands.length / 3))),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 16).sort((a, b) => a.startMs - b.startMs);
}

/**
 * Light changes: a smoothed luma that rises or falls by at least `minChange` (and a quarter of where it started)
 * within `maxMs`, mostly one way. Lights on, a sun flare, curtains opening.
 */
export function brightnessRamps(samples: readonly Pick<ShotSample, "t" | "luma">[], { minChange = 0.1, maxMs = 2000 }: { minChange?: number; maxMs?: number } = {}): SceneFacts["brightnessRamps"] {
  const luma = samples.map((s, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - 1); k <= Math.min(samples.length - 1, i + 1); k++) { sum += samples[k].luma; n++; }
    return sum / n;
  });
  const ramps: SceneFacts["brightnessRamps"] = [];
  for (let i = 0; i < samples.length; i++) {
    let bestJ = -1, bestChange = 0;
    for (let j = i + 1; j < samples.length && samples[j].t - samples[i].t <= maxMs; j++) {
      const change = luma[j] - luma[i];
      if (Math.abs(change) > Math.abs(bestChange)) { bestChange = change; bestJ = j; }
    }
    if (bestJ < 0 || Math.abs(bestChange) < Math.max(minChange, luma[i] * 0.25)) continue;
    // Mostly one way: the steps against the change add up to under a third of it.
    let against = 0;
    for (let k = i + 1; k <= bestJ; k++) { const d = luma[k] - luma[k - 1]; if (Math.sign(d) !== Math.sign(bestChange)) against += Math.abs(d); }
    if (against > Math.abs(bestChange) / 3) continue;
    // Trim the flat ends: the ramp is where the light actually changes.
    let from = i, to = bestJ;
    const flat = Math.abs(bestChange) * 0.06;
    while (from < to - 1 && Math.abs(luma[from + 1] - luma[from]) < flat) from++;
    while (to > from + 1 && Math.abs(luma[to] - luma[to - 1]) < flat) to--;
    ramps.push({ startMs: samples[from].t, endMs: samples[to].t, from: round3(clamp01(luma[from])), to: round3(clamp01(luma[to])), kind: bestChange > 0 ? "up" : "down" });
    i = bestJ;
    if (ramps.length >= 8) break;
  }
  return ramps;
}

/**
 * The reframe's raw target per sample: the saliency peak, led a little toward where the camera is heading (content
 * moving left means the camera pans right, and new things enter from the right), weighted by the peak's strength.
 */
export function reframeTargets(samples: readonly Pick<ShotSample, "t" | "saliency" | "flow">[], leadSeconds = 0.5): { t: number; x: number; weight: number }[] {
  return samples.map((s) => {
    const lead = Math.max(-0.15, Math.min(0.15, -s.flow.dx * leadSeconds));
    return { t: s.t, x: clamp01(s.saliency.x + lead), weight: round3(0.25 + 0.75 * s.saliency.strength) };
  });
}

/** Narrowest real-pixel width a virtual close-up may have (the reel is 1080 wide; under 720 the upscale shows). */
export const CLOSE_UP_MIN_PX = 720;

/** The 9:16 box of a virtual close-up `widthPx` wide on a `width` × `height` source, centred near (x, y), source fractions; null when it cannot fit. */
export function closeUpBox(width: number, height: number, x: number, y: number, widthPx = CLOSE_UP_MIN_PX): CloseUp["box"] | null {
  const heightPx = (widthPx * 16) / 9;
  if (widthPx > width || heightPx > height) return null;
  const w = widthPx / width, h = heightPx / height;
  // A close-up of the whole frame is not a close-up: it must be at most 85 % of the full-height 9:16 crop.
  if (w > cropWidthFor(width / height) * 0.85 && h > 0.85) return null;
  return { x: round3(Math.min(1 - w, Math.max(0, x - w / 2))), y: round3(Math.min(1 - h, Math.max(0, y - h / 2))), w: round3(w), h: round3(h) };
}

/** One sample's close-up reading: the box around the saliency peak and how good the picture is inside it. */
export type CloseUpReading = { t: number; box: CloseUp["box"]; sharpness: number; saliency: number; steady: number };

/**
 * Virtual close-up windows: runs of at least `minMs` where the box around the attention peak stays put (centre within
 * 6 % of the frame) and the region is sharp and salient. Best `max` by score, in time order.
 */
export function closeUpWindows(readings: readonly CloseUpReading[], sourceWidth: number, { minMs = 1200, max = 6 }: { minMs?: number; max?: number } = {}): CloseUp[] {
  if (readings.length < 2) return [];
  const step = readings[1].t - readings[0].t;
  const good = (r: CloseUpReading) => r.sharpness >= 0.35 && r.steady >= 0.4;
  const runs: CloseUpReading[][] = [];
  let run: CloseUpReading[] = [];
  const centre = (r: CloseUpReading) => ({ x: r.box.x + r.box.w / 2, y: r.box.y + r.box.h / 2 });
  for (const reading of readings) {
    const anchor = run[0];
    const fits = anchor && good(reading) && Math.hypot(centre(reading).x - centre(anchor).x, centre(reading).y - centre(anchor).y) <= 0.06;
    if (fits) { run.push(reading); continue; }
    if (run.length) runs.push(run);
    run = good(reading) ? [reading] : [];
  }
  if (run.length) runs.push(run);
  const out: CloseUp[] = runs
    .filter((r) => r.length * step >= minMs)
    .map((r) => {
      const mean = (pick: (x: CloseUpReading) => number) => r.reduce((a, x) => a + pick(x), 0) / r.length;
      const box = r[Math.floor(r.length / 2)].box;
      const score = clamp01(0.45 * mean((x) => x.sharpness) + 0.35 * mean((x) => x.saliency) + 0.2 * mean((x) => x.steady));
      return { startMs: r[0].t, endMs: r[r.length - 1].t + step, box, sourcePx: Math.round(box.w * sourceWidth), score: round3(score) };
    });
  return out.sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.startMs - b.startMs);
}
