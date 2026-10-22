/**
 * Verification of a rendered reel (ADR 0071): the facts an agent used to
 * get from ffmpeg frame strips and offline scans, computed once per render
 * from a sequence of small grey frames, plus the hard checks that stop a
 * post ("Post anyway" is the override, logged).
 *
 * Everything here is pure. The worker decodes the MP4 to a FrameSeries with
 * ffmpeg after every export and stores the result beside the file; the
 * editor can build a sparser series from the frames the critic already
 * reads (`seriesFromSamples` in retention.ts). A check that needs frames it
 * does not have is left out, never guessed: `facts` says what was measured.
 *
 *   analyseSeries(series, timeline?)      the per-frame facts
 *   renderChecks(input)                   facts + hard and soft checks + the verdict
 *   postBlockReason(checks)               one line for the Post button, or null
 *
 * Spaces: frames are gamma luma 0..1 row-major (CriticFrame); times are
 * reel ms; boxes are composition fractions.
 */
import { beatPeriodMs } from "./beats";
import { CRITIC, frameDifference, titleGeometry, type CriticBox, type CriticFrame } from "./critic";
import { INSTAGRAM } from "./instagram";
import { KINETIC_PRESET } from "./kinetic";
import type { Measure, TitleFont } from "./scene";
import { clipStartsMs, locate, REEL_FORMAT, timelineDurationMs, type TextOverlay, type Timeline } from "./timeline";

export const RENDER_CHECKS = {
  /** Mean luma at or under which a frame is near-black. */
  blackMean: 0.035,
  /** The brightest twentieth of a near-black frame stays under this (a dark room with a lit lamp is not black). */
  blackP95: 0.1,
  /** A black run of at most this many frames between lit frames is a flash: the renderer's black frame, not a fade. */
  flashMaxFrames: 4,
  /** Luma standard deviation under which a frame is one flat colour (an empty frame 0). */
  emptyStd: 0.015,
  /** Consecutive frames differing by no more than this are the same picture. */
  duplicateDiff: 0.0015,
  /** The same picture held this long inside a video clip is a frozen decode or a still mistaken for footage. */
  frozenMinMs: 1000,
  /** A title's entrance should be done by this reel time for the opening to read. */
  legibleByMs: 300,
  /** Pop: opacity is full by its third frame. */
  popMs: 100,
  /** The elegant fade (render's ELEGANT_FADE_S). */
  fadeMs: 600,
  riseMs: 500,
  /** The typewriter writes this many characters a second (render's TYPE_CHARS_PER_S). */
  typeCharsPerS: 14,
  /** Frames this far apart are compared for motion energy. */
  motionSpanMs: 500,
  /** A frame is matched to a wanted time within this. */
  matchToleranceMs: 170,
} as const;

const FRAME_MS = 1000 / REEL_FORMAT.fps;
const W = REEL_FORMAT.width, H = REEL_FORMAT.height;

// ── Types ───────────────────────────────────────────────────────

/** One frame of a rendered reel at a reel time. */
export type SeriesFrame = { ms: number; frame: CriticFrame };
/** Frames in time order. Dense (every frame of the render) or sparse (the editor's samples). */
export type FrameSeries = SeriesFrame[];

export type FrameRun = { fromMs: number; toMs: number; frames: number };

/**
 * Motion between a frame and the next one at least `motionSpanMs` later (up to about twice that, so a
 * one-second sample grid still measures): mean luma difference scaled to a 500 ms span (0 still, 0.02
 * barely moving, 0.2 a cut). `toMs` is the later frame's time: the window the reading stands for.
 */
export type MotionPoint = { ms: number; toMs: number; energy: number };

export type SeriesFacts = {
  /** Frames measured and their typical spacing (null without frames). */
  frames: { count: number; stepMs: number } | null;
  /** Near-black runs. */
  black: FrameRun[];
  /** Black runs short enough, between lit frames, to be a glitch: reel ms of each. */
  flashFrames: number[];
  openingBlack: boolean | null;
  /** Frame 0 is one flat colour. */
  openingEmpty: boolean | null;
  /** The same picture held over `frozenMinMs` (inside video clips when the timeline is known). */
  frozen: FrameRun[];
  /** Mean luma difference between the last frame and the first. */
  loopSeamDiff: number | null;
  motion: MotionPoint[];
  /** Motion energy for each whole second of the reel (the largest step in it); -1 where nothing was measured. */
  motionPerSecond: number[];
};

export type RenderCheckLevel = "block" | "warn";
export type RenderCheckImpact = "hook" | "hold" | "finish";

export type RenderCheck = {
  id: string;
  level: RenderCheckLevel;
  /** A short name ("Black frame"). */
  title: string;
  /** One plain line with the numbers. */
  detail: string;
  impact: RenderCheckImpact;
  atMs?: number;
  textId?: string;
  box?: CriticBox;
};

/** What another analysis found wrong with the sound (W3-A's audio trace, when it is on main): passed through as checks. */
export type AudioProblem = { id: string; level: RenderCheckLevel; title: string; detail: string; atMs?: number };

/** Opening facts from the hook planner (W3-C) when it lands; they replace what is computed here. */
export type HookFacts = { openingEmpty?: boolean | null; titleLegibleByMs?: number | null };

export type RenderChecksInput = {
  timeline?: Timeline | null;
  series?: FrameSeries | null;
  /** The reel's length when no timeline is given (ms). */
  durationMs?: number;
  titleFont?: (text: TextOverlay) => TitleFont;
  measure?: Measure;
  audio?: AudioProblem[] | null;
  hook?: HookFacts | null;
};

export type RenderChecks = {
  version: 1;
  durationMs: number;
  facts: SeriesFacts & {
    /** How far the reel's end is from a bar line of its song (null without a tempo). */
    offBarMs: number | null;
    /** When the first title that starts in the opening 300 ms is fully in (null when none starts there). */
    titleLegibleByMs: number | null;
    /** Each title's reach into Instagram's zones, px of 1080×1920, where it reaches at all. */
    zoneReach: { textId: string; text: string; left: number; right: number; top: number; bottom: number }[];
  };
  checks: RenderCheck[];
  blocked: boolean;
  blockReasons: string[];
  audio: { available: boolean; problems: AudioProblem[] };
};

/**
 * How a render is decoded for the checks: ffmpeg scales every frame to this
 * grey picture (the editor's sample size, ADR 0062) and the bytes come back
 * as one raw stream, 30 of them a second.
 */
export const CHECK_SERIES = { width: 72, height: 128, fps: 30 } as const;

/**
 * ffmpeg's arguments for that decode, from `input` to raw grey frames on stdout, back to back with no
 * headers (the worker and the web routes share them). The image2pipe muxer with the rawvideo encoder,
 * `-r` for the rate and only the scale and format filters: the parts every ffmpeg build has, including
 * the trimmed one Remotion ships, which has neither the rawvideo muxer nor the fps filter.
 */
export function checkDecodeArgs(input: string): string[] {
  return ["-v", "error", "-nostdin", "-i", input, "-an", "-vf", `scale=${CHECK_SERIES.width}:${CHECK_SERIES.height},format=gray`, "-r", String(CHECK_SERIES.fps), "-f", "image2pipe", "-vcodec", "rawvideo", "-"];
}

/**
 * A series from ffmpeg's raw grey output (`-vf fps=F,scale=W:H,format=gray -f rawvideo`):
 * one byte per pixel, frames back to back, in time order. A trailing partial
 * frame is dropped. Luma is the byte over 255, the same scale `lumaFromRgba`
 * gives the editor's frames.
 */
export function seriesFromGreyFrames(bytes: Uint8Array, width: number = CHECK_SERIES.width, height: number = CHECK_SERIES.height, fps: number = CHECK_SERIES.fps): FrameSeries {
  const size = width * height;
  const count = Math.floor(bytes.length / size);
  const series: FrameSeries = [];
  for (let n = 0; n < count; n++) {
    const luma = new Float32Array(size);
    const base = n * size;
    for (let i = 0; i < size; i++) luma[i] = bytes[base + i] / 255;
    series.push({ ms: Math.round((n * 1000) / fps), frame: { width, height, luma } });
  }
  return series;
}

/**
 * The moments the Judge view (ADR 0071) shows side by side: the opening at
 * 0, 0.5, 1 and 1.5 s, then the last 1.5 s in four steps ending on the final
 * frame. A reel shorter than 3 s shows what it has, each moment once.
 */
export function judgeTimesMs(durationMs: number): { opening: number[]; ending: number[] } {
  const frameMs = 1000 / REEL_FORMAT.fps;
  const last = Math.max(0, Math.floor((durationMs - 1) / frameMs) * frameMs);
  const opening = [0, 500, 1000, 1500].filter((ms) => ms <= last);
  const ending = [1500, 1000, 500, 0].map((back) => Math.round(last - back)).filter((ms) => ms > (opening[opening.length - 1] ?? -1));
  return { opening, ending };
}

// ── Frame facts ─────────────────────────────────────────────────

/** Mean, standard deviation and the 95th percentile of a frame's luma. */
export function frameStats(frame: CriticFrame): { mean: number; std: number; p95: number } {
  const n = frame.luma.length;
  if (!n) return { mean: 0, std: 0, p95: 0 };
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) { sum += frame.luma[i]; sq += frame.luma[i] * frame.luma[i]; }
  const mean = sum / n;
  const sorted = Float32Array.from(frame.luma).sort();
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), p95: sorted[Math.min(n - 1, Math.floor(n * 0.95))] };
}

export const isNearBlack = (stats: { mean: number; p95: number }) => stats.mean <= RENDER_CHECKS.blackMean && stats.p95 <= RENDER_CHECKS.blackP95;
export const isEmptyFrame = (stats: { std: number }) => stats.std <= RENDER_CHECKS.emptyStd;

/** The frame nearest `ms`, within the tolerance; null when the series has none there. */
export function frameNear(series: FrameSeries, ms: number, toleranceMs: number = RENDER_CHECKS.matchToleranceMs): SeriesFrame | null {
  if (!series.length) return null;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].ms < ms) lo = mid + 1; else hi = mid;
  }
  const candidates = [series[lo], series[lo - 1]].filter((f): f is SeriesFrame => Boolean(f));
  const best = candidates.reduce((a, b) => (Math.abs(b.ms - ms) < Math.abs(a.ms - ms) ? b : a));
  return Math.abs(best.ms - ms) <= toleranceMs ? best : null;
}

/** Typical spacing of a series (the median gap), or 0 for fewer than two frames. */
export function seriesStepMs(series: FrameSeries): number {
  if (series.length < 2) return 0;
  const gaps = series.slice(1).map((f, i) => f.ms - series[i].ms).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Motion energy along the series: each frame against the next one at least
 * `spanMs` later (so slow drifts register that frame-to-frame differences
 * would hide), scaled to the span. With `cuts`, a pair never straddles a
 * cut: the frame before the cut is compared with the last frame before it,
 * so a hard cut never reads as motion inside the shot before it.
 */
export function motionEnergyProfile(series: FrameSeries, spanMs: number = RENDER_CHECKS.motionSpanMs, cuts: readonly number[] = []): MotionPoint[] {
  const out: MotionPoint[] = [];
  const sortedCuts = [...cuts].sort((a, b) => a - b);
  let j = 0;
  for (let i = 0; i < series.length; i++) {
    const point = series[i];
    while (j < series.length && series[j].ms < point.ms + spanMs) j++;
    let later = j < series.length ? j : -1;
    const cut = sortedCuts.find((c) => c > point.ms && (later < 0 || c <= series[later].ms));
    if (cut !== undefined) {
      // The last frame still before the cut.
      later = -1;
      for (let k = i + 1; k < series.length && series[k].ms < cut; k++) later = k;
    }
    if (later < 0 || later === i) continue;
    const gap = series[later].ms - point.ms;
    if (gap > spanMs * 2.2 || gap <= 0) continue;
    // A cut at `cut` ends the window there, so the still stretch reaches the cut.
    const toMs = cut !== undefined ? cut : series[later].ms;
    out.push({ ms: point.ms, toMs, energy: frameDifference(point.frame, series[later].frame) * Math.min(1, spanMs / gap) });
  }
  return out;
}

/** The largest motion step inside each whole second (-1 where nothing was measured). */
export function motionPerSecond(motion: MotionPoint[], durationMs: number): number[] {
  const seconds = Math.max(0, Math.ceil(durationMs / 1000));
  const out = new Array<number>(seconds).fill(-1);
  for (const point of motion) {
    const s = Math.floor(point.ms / 1000);
    if (s >= 0 && s < seconds) out[s] = Math.max(out[s], point.energy);
  }
  return out.map((v) => (v < 0 ? -1 : Math.round(v * 1000) / 1000));
}

/** Runs of frames for which `test` holds, as reel windows. */
function runsOf(series: FrameSeries, stepMs: number, test: (index: number) => boolean): FrameRun[] {
  const runs: FrameRun[] = [];
  let start = -1;
  const close = (end: number) => {
    if (start < 0) return;
    runs.push({ fromMs: series[start].ms, toMs: series[end].ms + stepMs, frames: end - start + 1 });
    start = -1;
  };
  for (let i = 0; i < series.length; i++) {
    if (test(i)) { if (start < 0) start = i; } else close(i - 1);
  }
  close(series.length - 1);
  return runs;
}

/** The clip on screen at `ms` (its index), or -1. */
function clipIndexAt(timeline: Timeline | null | undefined, ms: number): number {
  if (!timeline) return -1;
  const total = timelineDurationMs(timeline);
  const where = locate(timeline, Math.max(0, Math.min(ms, total - 1)));
  return where ? where.index : -1;
}

/**
 * The per-frame facts: black and flash frames, an empty opening, frozen
 * pictures, the loop seam and the motion profile. With the timeline, a
 * frozen run is only reported inside a video clip (a photo without a camera
 * move is meant to hold still; the retention critic judges that as dead
 * air) and a flash is never a cut to a dark shot.
 */
export function analyseSeries(series: FrameSeries, timeline?: Timeline | null): SeriesFacts {
  const total = timeline ? timelineDurationMs(timeline) : series.length ? series[series.length - 1].ms + seriesStepMs(series) : 0;
  if (!series.length) {
    return { frames: null, black: [], flashFrames: [], openingBlack: null, openingEmpty: null, frozen: [], loopSeamDiff: null, motion: [], motionPerSecond: motionPerSecond([], total) };
  }
  const stepMs = seriesStepMs(series) || FRAME_MS;
  const stats = series.map((f) => frameStats(f.frame));
  const dark = stats.map(isNearBlack);
  const black = runsOf(series, stepMs, (i) => dark[i]);
  // A flash: a short black run with lit frames on both sides. A run that is a whole clip (a fade or a black card) is not one.
  const flashFrames: number[] = [];
  for (const run of black) {
    const first = series.findIndex((f) => f.ms === run.fromMs);
    const last = first + run.frames - 1;
    const litBefore = first > 0 && !dark[first - 1], litAfter = last < series.length - 1 && !dark[last + 1];
    if (!litBefore || !litAfter || run.frames > RENDER_CHECKS.flashMaxFrames) continue;
    // Dense series only: with half-second samples a short black run is not a glitch one can see.
    if (stepMs > FRAME_MS * 1.5) continue;
    if (timeline) {
      const before = clipIndexAt(timeline, series[first - 1].ms), after = clipIndexAt(timeline, series[last + 1].ms);
      const inside = clipIndexAt(timeline, series[first].ms);
      // Black frames with the same clip on both sides, or at a cut (the renderer draws titles over a black picture there), are glitches.
      if (before !== after && inside !== before && inside !== after) continue;
    }
    flashFrames.push(Math.round(series[first].ms));
  }
  // Frozen: consecutive frames that are the same picture, long enough to be a stall, inside a video clip.
  const same = series.map((f, i) => (i > 0 ? frameDifference(series[i - 1].frame, f.frame) <= RENDER_CHECKS.duplicateDiff : false));
  const frozen = runsOf(series, stepMs, (i) => same[i] && !dark[i])
    .map((run) => ({ ...run, fromMs: Math.max(0, run.fromMs - stepMs), frames: run.frames + 1 }))
    .filter((run) => run.toMs - run.fromMs >= RENDER_CHECKS.frozenMinMs)
    .filter((run) => {
      if (!timeline) return true;
      const index = clipIndexAt(timeline, run.fromMs + (run.toMs - run.fromMs) / 2);
      const clip = index >= 0 ? timeline.clips[index] : null;
      return clip?.kind === "VIDEO";
    });
  const motion = motionEnergyProfile(series, RENDER_CHECKS.motionSpanMs, timeline ? clipStartsMs(timeline).slice(1) : []);
  return {
    frames: { count: series.length, stepMs: Math.round(stepMs * 100) / 100 },
    black,
    flashFrames,
    openingBlack: dark[0],
    openingEmpty: isEmptyFrame(stats[0]),
    frozen,
    loopSeamDiff: series.length > 1 ? Math.round(frameDifference(series[0].frame, series[series.length - 1].frame) * 1000) / 1000 : null,
    motion,
    motionPerSecond: motionPerSecond(motion, total),
  };
}

// ── Timeline facts ──────────────────────────────────────────────

/** Ms after a title appears until its entrance is done and the words read whole. */
export function titleEntranceMs(text: TextOverlay): number {
  const durationMs = text.endMs - text.startMs;
  const animation = text.animation === "auto" ? (text.style === "elegant" ? "fade" : "pop") : text.animation;
  let entrance = 0;
  switch (animation) {
    case "fade": entrance = Math.min(RENDER_CHECKS.fadeMs, durationMs / 2); break;
    case "rise": entrance = Math.min(RENDER_CHECKS.riseMs, durationMs / 2); break;
    case "type": entrance = Math.min((text.text.length / RENDER_CHECKS.typeCharsPerS) * 1000, durationMs / 2); break;
    case "none": entrance = 0; break;
    default: entrance = RENDER_CHECKS.popMs;
  }
  if (text.kinetic) {
    const preset = KINETIC_PRESET[text.kinetic.preset];
    entrance = Math.max(entrance, (text.kinetic.startMs ?? preset.startMs) + (text.kinetic.durationMs ?? preset.durationMs));
  }
  return Math.round(entrance);
}

/** How far the reel's end is from a bar line of its song, or null without a tempo. */
export function offBarMs(timeline: Timeline): number | null {
  const music = timeline.music;
  if (!music?.bpm) return null;
  const total = timelineDurationMs(timeline);
  const bar = beatPeriodMs({ bpm: music.bpm, offsetMs: 0 }) * 4;
  const firstBeat = (music.beatOffsetMs ?? 0) - music.sourceStartMs;
  const r = (((total - firstBeat) % bar) + bar) % bar;
  return Math.round(Math.min(r, bar - r));
}

const managed = (text: TextOverlay) => text.id.startsWith("room-");
const quote = (text: TextOverlay) => `“${text.text.length > 24 ? `${text.text.slice(0, 23)}…` : text.text}”`;

function zoneReach(box: CriticBox) {
  const zone = INSTAGRAM.safeZonePx;
  return {
    left: Math.max(0, Math.round(zone.left - box.x * W)),
    right: Math.max(0, Math.round((box.x + box.w) * W - (W - zone.right))),
    top: Math.max(0, Math.round(zone.top - box.y * H)),
    bottom: Math.max(0, Math.round((box.y + box.h) * H - (H - zone.bottom))),
  };
}

const fallbackFont = (text: TextOverlay): TitleFont => ({ fontSize: 76 * text.size * (text.style === "headline" ? 1.3 : text.style === "elegant" ? 0.78 : text.style === "tag" ? 0.7 : 1) });

// ── The checks ──────────────────────────────────────────────────

/**
 * Runs the checks. Hard (block): a flash frame, an empty or black frame 0,
 * a title under the like/share column. Soft (warn): other zone reaches, a
 * slow opening title, a frozen picture, a loop seam that jumps, an ending
 * off the bar, and the audio problems handed in.
 */
export function renderChecks(input: RenderChecksInput): RenderChecks {
  const timeline = input.timeline ?? null;
  const series = input.series ?? [];
  const durationMs = timeline ? timelineDurationMs(timeline) : (input.durationMs ?? (series.length ? series[series.length - 1].ms + seriesStepMs(series) : 0));
  const facts = analyseSeries(series, timeline);
  const checks: RenderCheck[] = [];
  const impactAt = (ms: number): RenderCheckImpact => (ms < 3000 ? "hook" : ms > durationMs - 3000 ? "finish" : "hold");

  // Frame 0: W3-C's facts win when given.
  const openingEmpty = input.hook?.openingEmpty !== undefined ? input.hook.openingEmpty : facts.openingBlack || facts.openingEmpty;
  if (openingEmpty) {
    checks.push({ id: "empty-opening", level: "block", impact: "hook", atMs: 0, title: "Empty first frame",
      detail: facts.openingBlack ? "Frame 0 is black: the cover and the first thing a viewer sees are nothing." : "Frame 0 is one flat colour with nothing on it." });
  }
  for (const ms of facts.flashFrames) {
    checks.push({ id: `black-frame:${ms}`, level: "block", impact: impactAt(ms), atMs: ms, title: "Black frame", detail: `A black frame at ${(ms / 1000).toFixed(2)} s between lit frames: the picture drops out for a moment.` });
  }
  for (const run of facts.frozen) {
    checks.push({ id: `frozen:${Math.round(run.fromMs)}`, level: "warn", impact: impactAt(run.fromMs), atMs: run.fromMs, title: "Frozen picture",
      detail: `The same frame holds from ${(run.fromMs / 1000).toFixed(1)} s to ${(run.toMs / 1000).toFixed(1)} s inside a video shot.` });
  }

  // Titles: where they reach, and whether the opening one is in by 300 ms.
  const reach: RenderChecks["facts"]["zoneReach"] = [];
  let titleLegibleByMs: number | null = input.hook?.titleLegibleByMs !== undefined ? input.hook.titleLegibleByMs : null;
  if (timeline) {
    const font = input.titleFont ?? fallbackFont;
    for (const text of timeline.texts) {
      if (managed(text)) continue;
      const geometry = titleGeometry(timeline, text, font(text), input.measure);
      if (!geometry) continue;
      const into = zoneReach(geometry.box);
      if (into.left || into.right || into.top || into.bottom) reach.push({ textId: text.id, text: text.text, ...into });
      const at = (text.startMs + text.endMs) / 2;
      if (into.right > CRITIC.intrusionPx) {
        checks.push({ id: `title-under-buttons:${text.id}`, level: "block", impact: impactAt(at), atMs: at, textId: text.id, box: geometry.box, title: "Title under the buttons",
          detail: `${quote(text)} reaches ${into.right} px under the like and share column.` });
      } else if (Math.max(into.left, into.top, into.bottom) > CRITIC.intrusionPx) {
        const where = into.bottom >= into.top && into.bottom >= into.left ? "the caption" : into.top >= into.left ? "the header" : "the screen edge";
        checks.push({ id: `title-in-zone:${text.id}`, level: "warn", impact: impactAt(at), atMs: at, textId: text.id, box: geometry.box, title: "Title in a dead zone",
          detail: `${quote(text)} runs ${Math.max(into.left, into.top, into.bottom)} px under ${where}.` });
      }
    }
    if (input.hook?.titleLegibleByMs === undefined) {
      const opener = timeline.texts.filter((text) => !managed(text) && text.startMs <= RENDER_CHECKS.legibleByMs).sort((a, b) => a.startMs - b.startMs)[0];
      if (opener) {
        titleLegibleByMs = opener.startMs + titleEntranceMs(opener);
        if (titleLegibleByMs > RENDER_CHECKS.legibleByMs) {
          checks.push({ id: `slow-opening-title:${opener.id}`, level: "warn", impact: "hook", atMs: opener.startMs, textId: opener.id, title: "Opening title arrives slowly",
            detail: `${quote(opener)} is only fully on screen at ${(titleLegibleByMs / 1000).toFixed(2)} s; the opening should read by ${RENDER_CHECKS.legibleByMs / 1000} s.` });
        }
      }
    } else if (titleLegibleByMs !== null && titleLegibleByMs > RENDER_CHECKS.legibleByMs) {
      checks.push({ id: "slow-opening-title", level: "warn", impact: "hook", atMs: 0, title: "Opening title arrives slowly", detail: `The opening title is only fully on screen at ${(titleLegibleByMs / 1000).toFixed(2)} s.` });
    }
  }

  // The ending.
  if (facts.loopSeamDiff !== null && facts.loopSeamDiff > CRITIC.loopMaxDiff) {
    checks.push({ id: "loop-seam", level: "warn", impact: "finish", atMs: Math.max(0, durationMs - FRAME_MS), title: "Loop jumps",
      detail: `The last frame differs from the first by ${Math.round(facts.loopSeamDiff * 255)}/255; the replay will jump.` });
  }
  const offBar = timeline ? offBarMs(timeline) : null;
  if (offBar !== null && offBar > CRITIC.barToleranceMs) {
    checks.push({ id: "off-bar", level: "warn", impact: "finish", atMs: Math.max(0, durationMs - FRAME_MS), title: "Ends mid-bar", detail: `The reel ends ${offBar} ms off a bar line of the song.` });
  }

  const result = sealChecks({ version: 1, durationMs, facts: { ...facts, offBarMs: offBar, titleLegibleByMs, zoneReach: reach }, checks, blocked: false, blockReasons: [], audio: { available: false, problems: [] } });
  return input.audio === undefined || input.audio === null ? result : withAudioProblems(result, input.audio);
}

/** Checks in order (blocks first, then by time) and the verdict that follows from them. */
function sealChecks(result: RenderChecks): RenderChecks {
  const checks = [...result.checks].sort((a, b) => (a.level === b.level ? (a.atMs ?? 0) - (b.atMs ?? 0) : a.level === "block" ? -1 : 1));
  const blockReasons = checks.filter((check) => check.level === "block").map((check) => check.detail);
  return { ...result, checks, blocked: blockReasons.length > 0, blockReasons };
}

/**
 * The sound's problems (W3-A's audio trace) folded into a result: its own
 * checks replace any audio checks already there, so stored checks can gain
 * the audio facts when the trace route exists and lose none of the picture's.
 */
export function withAudioProblems(result: RenderChecks, problems: readonly AudioProblem[]): RenderChecks {
  const impactAt = (ms: number): RenderCheckImpact => (ms < 3000 ? "hook" : ms > result.durationMs - 3000 ? "finish" : "hold");
  const picture = result.checks.filter((check) => !check.id.startsWith("audio:"));
  const sound: RenderCheck[] = problems.map((problem) => ({
    id: `audio:${problem.id}`, level: problem.level, impact: problem.atMs !== undefined ? impactAt(problem.atMs) : "hold", atMs: problem.atMs, title: problem.title, detail: problem.detail,
  }));
  return sealChecks({ ...result, checks: [...picture, ...sound], audio: { available: true, problems: [...problems] } });
}

/** The line the Post and Schedule buttons show when a hard check failed, or null. */
export function postBlockReason(checks: Pick<RenderChecks, "blocked" | "blockReasons"> | null | undefined): string | null {
  if (!checks?.blocked) return null;
  const [first, ...rest] = checks.blockReasons;
  return rest.length ? `${first} (${rest.length} more problem${rest.length > 1 ? "s" : ""}.)` : first;
}

