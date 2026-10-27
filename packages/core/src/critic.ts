/**
 * The critic before export (ADR 0062): the reel looked at the way
 * Instagram's ranking and a viewer would, with a one-tap fix for each thing
 * it finds. Every fix is an existing document command (ADR 0048), so it
 * lands as one undo step and moves titles the way any other edit does.
 *
 * Deterministic wherever the timeline or a few small frames can decide:
 *
 *   hook        something changes in the first 1.5 s (a cut, a title, a
 *               hook, a camera move, or motion in the picture); frame 0 is
 *               not empty; the opening title reads by 300 ms (retention.ts)
 *   safe-zone   no title in Instagram's UI dead zones (INSTAGRAM.safeZonePx)
 *   face        an AI presenter's face is over the floor the identity gate
 *               recorded for the take (ADR 0056), 220 px when she speaks
 *               (advice), and the gate passed it
 *               comfortably
 *   legibility  a title's contrast with the frame behind it, and its size
 *               on a phone; never a box or tag, which bring their own
 *   loop        the last frame looks like the first, and the music ends on
 *               a bar, so the replay does not jump
 *
 * and the retention proxies of ADR 0071 (retention.ts): dead air, reading
 * time, cut rate against the song, cuts off the beat (snapped to frame-exact
 * times), a presenter held too long, untouched stock. Every finding carries
 * an impact tag (hook | hold | finish).
 *
 * API
 *
 *   criticSamples(timeline) -> CriticSample[]
 *     The moments whose pixels the checks read, in priority order and
 *     capped (CRITIC.maxSamples). The editor draws each through the frame
 *     service (ADR 0047) as the composition shows it, small, and hands the
 *     pixels back as CriticFrame (`lumaFromRgba`).
 *
 *   critique(input) -> CriticFinding[]
 *     Pure. Checks that need a frame that is missing are skipped, never
 *     guessed: a video's motion or a title's contrast is only judged from
 *     its pixels.
 *
 *   settleUndecided(findings, judge) -> Promise<CriticFinding[]>
 *     The one place a model may be asked: a legibility finding whose pixel
 *     metrics fall in the grey band (`undecided`). Nothing else is sent.
 *
 *   fixAllCommand(findings) -> Command | null
 *     The safe fixes (text moves and treatments, the beat snap) as one
 *     batch: one step, one undo.
 *
 * Spaces: frames are small grids of gamma-encoded luma (0..1, row-major);
 * boxes are composition fractions; times are reel ms unless named
 * `sourceMs`.
 */
import { beatPeriodMs } from "./beats";
import { estimateLineWidth } from "./cinematic";
import { applyCommand, type BatchableCommand, type Command } from "./commands";
import { retentionFindings, seriesFromSamples, type RetentionInput } from "./retention";
import type { FrameSeries } from "./render-checks";
import { INSTAGRAM } from "./instagram";
import { MIN_SPEAKING_FACE_PX, minFacePx } from "./presenter";
import { evaluateTitle, screenTitleExtent, TITLE_LEADING, type Measure, type SurfacePlacement, type TitleFont } from "./scene";
import { applyHomography, type Quad } from "./motion";
import {
  clipDurationMs,
  clipStartsMs,
  framePlan,
  locate,
  MIN_CLIP_MS,
  placedByApp,
  REEL_FORMAT,
  TEXT_SIZE_MAX,
  timelineDurationMs,
  type Clip,
  type TextOverlay,
  type Timeline,
} from "./timeline";

/** The thresholds, in one place so they can be tuned from what studios see. */
export const CRITIC = {
  /** The opening that has to move. */
  hookMs: 1500,
  /** A dead-air fix leaves at most this much stillness (the dead-air rule itself is RETENTION.deadAirMs, 1.2 s). */
  stillTargetMs: 1000,
  /** Spacing of the frames read for motion. */
  stepMs: 500,
  /** Mean luma difference between frames `stepMs` apart above which the picture moved (compression noise on a still shot is under 0.01). */
  motion: 0.02,
  /**
   * The presenter face, in px of a 1080×1920 frame, a speaking shot should have so her eyes and mouth hold
   * on a phone. Advice only: the hard floor is the identity gate's (MIN_SPEAKING_FACE_PX in presenter.ts),
   * read from what the gate recorded on the take.
   */
  speakingAdvicePx: 220,
  /** An identity gate score below this passed, but only just (the gate's own bar is 0.6). */
  faceReviewScore: 0.7,
  /** A phone's width in CSS px (the editor's reference phone, 412×915). */
  phoneWidthPx: 412,
  /** Smallest comfortable title font size on that phone, CSS px. */
  minPhoneFontPx: 14,
  /** A cut further than this from the nearest beat is off it (a frame and a half). */
  beatToleranceMs: 50,
  /** The reel's end counts as on a bar within this. */
  barToleranceMs: 60,
  /** Mean luma difference between the last and first frames above which the loop visibly jumps. */
  loopMaxDiff: 0.12,
  /** A loop fix must make the ends at least this much more alike. */
  loopMinGain: 0.03,
  /** How far into the Instagram zones a title may reach before it counts (px of 1080×1920): anti-aliasing and shadows, not words. */
  intrusionPx: 24,
  /** Title-to-background contrast (WCAG ratio, against the mean behind it) below which it is hard to read. */
  contrastBad: 2,
  /** At or above this against the brightest (or darkest) tenth behind it, it reads. Between the two, pixels cannot decide. */
  contrastGood: 3,
  /** Most frames read per check run: a phone seeks each one. */
  maxSamples: 72,
} as const;

const FRAME_MS = 1000 / REEL_FORMAT.fps;
const W = REEL_FORMAT.width, H = REEL_FORMAT.height;

// ── Types ───────────────────────────────────────────────────────

/** One moment to read pixels at: a clip instance and its source time. `key` names it for the frames map. */
export type CriticSample = { key: string; clipId: string; sourceMs: number; reelMs: number };

/** A small frame as the composition shows it: gamma-encoded luma 0..1, row-major. */
export type CriticFrame = { width: number; height: number; luma: Float32Array };

/** What the editor knows about an AI take in the reel, from its generation row (ADR 0056). */
export type CriticFace = {
  assetId: string;
  /**
   * The identity gate's face floor for this take, px at 1080×1920, as the gate recorded it on each check
   * (MIN_SPEAKING_FACE_PX for a speaking end, MIN_GATE_FACE_PX otherwise; the largest across ends).
   * Rows checked before the gate recorded it fall back to the shot's spoken line; null when neither is known.
   */
  floorPx: number | null;
  /** The face's height in the composed keyframe the take was made from (1080×1920), smallest of its ends; null when not measured. */
  faceHeightPx: number | null;
  /** The identity gate's lowest accepted confidence; null when the gate did not run. */
  identityScore: number | null;
  /** False when the gate saw an accepted end without both eyes and the mouth clearly drawn; null when it did not look (takes from before that check). */
  eyesAndMouthRendered: boolean | null;
};

/**
 * A generation row's face facts for the critic: whether the shot speaks, and
 * the face height the identity gate measured on the accepted attempt of each
 * composed end (the smallest of them). Rows from before the gate have none.
 */
export function criticFaceFromGeneration(row: { assetId: string; shot: unknown; identityChecks: unknown; identityScore: number | null }): CriticFace {
  const shot = row.shot && typeof row.shot === "object" ? (row.shot as { line?: unknown }) : {};
  const checks = Array.isArray(row.identityChecks) ? (row.identityChecks as { end?: unknown; attempt?: unknown; faceHeightPx?: unknown; minFacePx?: unknown; eyesAndMouthRendered?: unknown }[]) : [];
  const floors = checks.flatMap((check) => (check && typeof check === "object" && typeof check.minFacePx === "number" ? [check.minFacePx] : []));
  const spoken = typeof shot.line === "string" && shot.line.trim().length > 0;
  const accepted = new Map<string, { attempt: number; faceHeightPx: number | null; eyesAndMouth: boolean | null }>();
  for (const check of checks) {
    if (!check || typeof check !== "object") continue;
    const end = String(check.end ?? "first"), attempt = typeof check.attempt === "number" ? check.attempt : 1;
    const faceHeightPx = typeof check.faceHeightPx === "number" && check.faceHeightPx > 0 ? check.faceHeightPx : null;
    const eyesAndMouth = typeof check.eyesAndMouthRendered === "boolean" ? check.eyesAndMouthRendered : null;
    const held = accepted.get(end);
    if (!held || attempt > held.attempt) accepted.set(end, { attempt, faceHeightPx, eyesAndMouth });
  }
  const looked = [...accepted.values()].flatMap((check) => (check.eyesAndMouth === null ? [] : [check.eyesAndMouth]));
  const heights = [...accepted.values()].flatMap((check) => (check.faceHeightPx === null ? [] : [check.faceHeightPx]));
  return {
    assetId: row.assetId,
    floorPx: floors.length ? Math.max(...floors) : spoken ? minFacePx(true) : null,
    faceHeightPx: heights.length ? Math.min(...heights) : null,
    identityScore: typeof row.identityScore === "number" ? row.identityScore : null,
    eyesAndMouthRendered: looked.length ? looked.every(Boolean) : null,
  };
}

export type CriticCheck = "hook" | "safe-zone" | "dead-air" | "face" | "legibility" | "loop" | "beat" | "reading" | "cut-rate" | "presenter" | "stock";
export type CriticSeverity = "high" | "medium" | "low";
/** What a finding costs the reel: the first three seconds (hook), the middle (hold), or the ending and loop (finish). */
export type CriticImpact = "hook" | "hold" | "finish";

export type CriticFix =
  /** A document command: one tap, one undo. `safe` ones are applied by "Fix all". A batch (several trims for the beat snap) counts as one. */
  | { kind: "command"; label: string; command: Command; safe: boolean }
  /** Not a timeline change: opens the place where it is done (a new AI take costs a credit, so it is never automatic; a cutaway needs a shot picked). */
  | { kind: "open"; label: string; sheet: "ai-video" | "media"; clipId: string };

export type CriticBox = { x: number; y: number; w: number; h: number };

export type CriticFinding = {
  /** Stable across runs while the subject is the same (`check:subject`). */
  id: string;
  check: CriticCheck;
  severity: CriticSeverity;
  /** Where it hurts: the hook, the hold through the middle, or the finish. */
  impact: CriticImpact;
  /** One plain-English line. */
  reason: string;
  /** The moment to show, reel ms, and the clip and source time it falls on (for the thumbnail). */
  atMs: number;
  clipId: string | null;
  sourceMs: number | null;
  /** The title's box on that frame, fractions, to outline on the thumbnail. */
  box?: CriticBox;
  textId?: string;
  fixes: CriticFix[];
  /** Pixel metrics could not decide: a judge may settle it (`settleUndecided`). */
  undecided?: { kind: "legibility"; textId: string; meanContrast: number; worstContrast: number };
};

export type CriticInput = {
  timeline: Timeline;
  /** Frames by sample key; missing ones skip the checks that need them. */
  frames?: ReadonlyMap<string, CriticFrame>;
  /** AI takes in the reel, by asset. */
  faces?: readonly CriticFace[];
  /** A title's font as the renderer styles it (the editor passes render's textTreatmentCss). */
  titleFont(text: TextOverlay): TitleFont;
  /** Line measurement for the scene evaluator; defaults to the character-count estimate. */
  measure?: Measure;
  /** Words for a title in the first second (the reel's name); without it that fix is not offered. */
  headline?: string | null;
  /** Source lengths by asset id, so a fix never trims or snaps past a video's end. */
  sourceDurationsMs?: Record<string, number | null | undefined>;
  /** Frames of the whole reel in time order (the render's decode), when the caller has them; otherwise built from `frames`. */
  series?: FrameSeries | null;
  /** What each video says, by asset id, for the dead-air and cut-rate checks. */
  transcripts?: RetentionInput["transcripts"];
  /** Presenter takes by asset id (AI assets count without being listed). */
  presenterAssetIds?: readonly string[];
  /** W3-E's transform scores by asset id, when measured. */
  transformScores?: Record<string, number>;
  /** W3-C's opening facts, when it has them. */
  hook?: RetentionInput["hook"];
};

/** Decides a legibility call the pixels could not: is this title readable over this frame? */
export type CriticJudge = (question: { textId: string; text: string; color: string; frame: CriticFrame | null; box: CriticBox | null }) => Promise<{ readable: boolean }>;

const SEVERITY_ORDER: Record<CriticSeverity, number> = { high: 0, medium: 1, low: 2 };
/** Where a moment hurts: the first three seconds, the ending, or the middle. */
export const impactOf = (atMs: number, totalMs: number): CriticImpact => (atMs < 3000 ? "hook" : atMs > totalMs - 3000 ? "finish" : "hold");

// ── Moments ─────────────────────────────────────────────────────

const sampleKey = (clipId: string, sourceMs: number) => `${clipId}@${Math.round(sourceMs)}`;

/** The clip on screen at reel `reelMs` (clamped into the reel) and the source time it shows. */
export function momentAt(timeline: Timeline, reelMs: number): CriticSample | null {
  const total = timelineDurationMs(timeline);
  if (total <= 0) return null;
  const at = Math.max(0, Math.min(reelMs, total - FRAME_MS / 2));
  const where = locate(timeline, at);
  if (!where) return null;
  const clip = timeline.clips[where.index];
  const sourceMs = clip.kind === "VIDEO" ? Math.min(clip.sourceStartMs + where.offsetMs * clip.speed, clip.sourceEndMs - 1) : where.offsetMs;
  return { key: sampleKey(clip.id, sourceMs), clipId: clip.id, sourceMs, reelMs: at };
}

/** A clip whose picture moves without looking at its pixels: a camera move or a 360 sweep. */
const cameraMoves = (clip: Clip) => clip.motion !== "none" || Boolean(clip.pano);

/** Offsets (reel ms into the clip) a still-or-moving clip is read at: every step, and its last frame. */
function gridOffsets(durationMs: number, stepMs: number = CRITIC.stepMs): number[] {
  const offsets: number[] = [];
  for (let t = 0; t < durationMs - FRAME_MS; t += stepMs) offsets.push(t);
  offsets.push(Math.max(0, durationMs - FRAME_MS));
  return offsets;
}

/** The moment a title is read at: the middle of its time on screen. */
const titleMoment = (text: TextOverlay) => (text.startMs + text.endMs) / 2;

/** Candidate reel ends for a loop-friendly ending: bar lines (with a tempo) or steps, in the last clip's last 3 s, shortening only. */
function loopEnds(timeline: Timeline): number[] {
  const total = timelineDurationMs(timeline);
  const last = timeline.clips.at(-1);
  if (!last) return [];
  const lastStart = total - clipDurationMs(last);
  const earliest = Math.max(lastStart + MIN_CLIP_MS, total - 3000);
  const music = timeline.music;
  const ends: number[] = [];
  if (music?.bpm) {
    const bar = beatPeriodMs({ bpm: music.bpm, offsetMs: 0 }) * 4;
    const first = (music.beatOffsetMs ?? 0) - music.sourceStartMs;
    for (let k = Math.floor((total - first) / bar); k >= 0; k--) {
      const end = Math.round(first + k * bar);
      if (end < earliest) break;
      if (end <= total) ends.push(end);
    }
  } else {
    for (let end = total - CRITIC.stepMs; end >= earliest; end -= CRITIC.stepMs) ends.push(Math.round(end));
  }
  return ends;
}

/**
 * The moments the checks read, highest priority first: the opening, the
 * loop's ends, each title's middle, each later clip's opening (to find a
 * livelier first shot), then whole clips for dead air. A clip's dead-air
 * grid is taken whole or not at all, so a check never runs on half a clip.
 */
export function criticSamples(timeline: Timeline): CriticSample[] {
  const out = new Map<string, CriticSample>();
  const add = (sample: CriticSample | null) => { if (sample && !out.has(sample.key) && out.size < CRITIC.maxSamples) out.set(sample.key, sample); };
  const total = timelineDurationMs(timeline);
  if (total <= 0) return [];
  for (let t = 0; t <= CRITIC.hookMs; t += CRITIC.stepMs) add(momentAt(timeline, t));
  add(momentAt(timeline, total - FRAME_MS));
  for (const end of loopEnds(timeline)) add(momentAt(timeline, end - FRAME_MS));
  for (const text of timeline.texts.slice(0, 12)) add(momentAt(timeline, titleMoment(text)));
  const starts = clipStartsMs(timeline);
  timeline.clips.slice(1, 13).forEach((clip, i) => {
    if (clip.kind !== "VIDEO" || cameraMoves(clip)) return;
    const d = clipDurationMs(clip);
    add(momentAt(timeline, starts[i + 1]));
    add(momentAt(timeline, starts[i + 1] + Math.min(CRITIC.stepMs, d - FRAME_MS)));
  });
  // Motion through the whole reel (ADR 0071): every step of each video clip, so dead air and the motion
  // profile cover the reel, not only the long still shots. A clip's grid is taken whole or not at all,
  // so a check never runs on half a clip; when the half-second grid does not fit the cap, a one-second
  // grid is tried, and the clips that fit are judged.
  for (const step of [CRITIC.stepMs, CRITIC.stepMs * 2]) {
    timeline.clips.forEach((clip, index) => {
      const d = clipDurationMs(clip);
      if (clip.kind !== "VIDEO" || cameraMoves(clip) || d <= CRITIC.stepMs) return;
      const grid = gridOffsets(d, step).map((offset) => momentAt(timeline, starts[index] + offset)).filter((s): s is CriticSample => s !== null);
      const fresh = grid.filter((sample) => !out.has(sample.key));
      if (out.size + fresh.length <= CRITIC.maxSamples) fresh.forEach(add);
    });
  }
  return [...out.values()];
}

// ── Pixels ──────────────────────────────────────────────────────

/** RGBA bytes (a canvas's getImageData) to gamma-encoded luma 0..1. */
export function lumaFromRgba(data: ArrayLike<number>, width: number, height: number): CriticFrame {
  const luma = new Float32Array(width * height);
  for (let i = 0; i < luma.length; i++) luma[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
  return { width, height, luma };
}

/** Mean absolute luma difference of two frames (0 identical, 1 opposite). Frames of different sizes are compared on the smaller grid. */
export function frameDifference(a: CriticFrame, b: CriticFrame): number {
  const width = Math.min(a.width, b.width), height = Math.min(a.height, b.height);
  if (!width || !height) return 0;
  let sum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pa = a.luma[Math.floor((y * a.height) / height) * a.width + Math.floor((x * a.width) / width)];
      const pb = b.luma[Math.floor((y * b.height) / height) * b.width + Math.floor((x * b.width) / width)];
      sum += Math.abs(pa - pb);
    }
  }
  return sum / (width * height);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance of a #rrggbb colour. */
export function colorLuminance(hex: string): number {
  const v = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => toLinear(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The relative luminance of an inverted title's letters (ADR 0091) over a picture of relative luminance `behind`: the
 * negative is taken in sRGB (as CSS blends are), then multiplied by the title's colour.
 */
export function invertedInkLuminance(behind: number, color: string): number {
  const encoded = behind <= 0.0031308 ? behind * 12.92 : 1.055 * behind ** (1 / 2.4) - 0.055;
  return colorLuminance(color) * toLinear(Math.min(1, Math.max(0, 1 - encoded)));
}

/** WCAG contrast ratio of two relative luminances (1..21). */
export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The relative luminance behind a box (fractions): mean, darkest tenth and brightest tenth. */
export function regionLuminance(frame: CriticFrame, box: CriticBox): { mean: number; p10: number; p90: number } | null {
  const x0 = Math.max(0, Math.floor(box.x * frame.width)), x1 = Math.min(frame.width, Math.ceil((box.x + box.w) * frame.width));
  const y0 = Math.max(0, Math.floor(box.y * frame.height)), y1 = Math.min(frame.height, Math.ceil((box.y + box.h) * frame.height));
  const values: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) values.push(toLinear(frame.luma[y * frame.width + x]));
  if (!values.length) return null;
  values.sort((p, q) => p - q);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return { mean, p10: values[Math.floor(values.length * 0.1)], p90: values[Math.min(values.length - 1, Math.floor(values.length * 0.9))] };
}

// ── Titles ──────────────────────────────────────────────────────

type TitleGeometry = { kind: "screen" | "surface"; box: CriticBox; fontPx: number };

const fallbackMeasure: Measure = (line, font) => ({ width: estimateLineWidth(line, font), height: font.fontSize * TITLE_LEADING });

/**
 * Where a title is (its box, composition fractions) and how big its type is
 * drawn, from the scene evaluator (ADR 0046) at its first, middle and last
 * frames: the union of the three boxes, so a drift is checked over its
 * whole path. Null when it is never drawn (a pinned title off its shot).
 */
export function titleGeometry(timeline: Timeline, text: TextOverlay, font: TitleFont, measure: Measure = fallbackMeasure): TitleGeometry | null {
  const plan = framePlan(timeline).texts.find((entry) => entry.text.id === text.id);
  if (!plan) return null;
  let kind: TitleGeometry["kind"] = "screen", fontPx = font.fontSize;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const frames = [...new Set([0, Math.floor(plan.durationInFrames / 2), Math.max(0, plan.durationInFrames - 1)])];
  for (const frame of frames) {
    const placement = evaluateTitle({ text, timeline, frame, from: plan.from, durationInFrames: plan.durationInFrames, fps: REEL_FORMAT.fps, width: W, height: H, font, measure });
    if (placement.kind === "hidden") continue;
    if (placement.kind === "surface") {
      kind = "surface";
      fontPx = Math.min(fontPx, font.fontSize * placement.fitScale);
      // The words, not the plane: the text block sits centred in the plane rectangle at its fitted size
      // (the renderer's flex-centred span scaled by fitScale), so a wide low surface whose words are
      // height-bound draws far narrower than its corners. Mapped through the plane's homography; the
      // plane itself when the corners are degenerate, or where a chosen surface clips the words.
      const quad = surfaceTextQuad(placement);
      for (let i = 0; i < 4; i++) {
        x0 = Math.min(x0, quad[i * 2]); x1 = Math.max(x1, quad[i * 2]);
        y0 = Math.min(y0, quad[i * 2 + 1]); y1 = Math.max(y1, quad[i * 2 + 1]);
      }
      continue;
    }
    const { center, wrap, scale } = placement;
    // The drawn extent (the wrapped lines plus the style's padding), not the wrap column the renderer
    // centres them in: the column is 86% of the frame and overhangs the button column by 44 px, so a
    // centred sentence measured by it was always "under the buttons" however short its lines.
    const extent = screenTitleExtent(text, font, measure, wrap);
    const w = extent.width * scale;
    const h = extent.height * scale;
    fontPx = Math.min(fontPx, font.fontSize * scale);
    x0 = Math.min(x0, center.x - w / 2); x1 = Math.max(x1, center.x + w / 2);
    y0 = Math.min(y0, center.y - h / 2); y1 = Math.max(y1, center.y + h / 2);
  }
  if (!Number.isFinite(x0)) return null;
  return { kind, box: { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H }, fontPx };
}

/**
 * Where a surface title's words are drawn, composition px (tl, tr, br, bl): the text block at its fitted
 * size, centred in the plane rectangle, through the plane's homography. A chosen surface clips the words to
 * its rectangle, so there each corner is kept inside the plane's own box; without a homography (degenerate
 * corners) the plane stands in.
 */
export function surfaceTextQuad(placement: SurfacePlacement): Quad {
  const { rect, homography, fitScale, lineBox, plane, clipToPlane } = placement;
  if (!homography) return plane;
  const halfW = (lineBox.width * fitScale) / 2, halfH = (lineBox.height * fitScale) / 2;
  const cx = rect.width / 2, cy = rect.height / 2;
  const local: Quad = [cx - halfW, cy - halfH, cx + halfW, cy - halfH, cx + halfW, cy + halfH, cx - halfW, cy + halfH];
  const mapped = [0, 1, 2, 3].flatMap((i) => applyHomography(homography, local[i * 2], local[i * 2 + 1])) as Quad;
  if (!clipToPlane) return mapped;
  const xs = [0, 1, 2, 3].map((i) => plane[i * 2]), ys = [0, 1, 2, 3].map((i) => plane[i * 2 + 1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return mapped.map((v, i) => (i % 2 === 0 ? Math.min(maxX, Math.max(minX, v)) : Math.min(maxY, Math.max(minY, v)))) as Quad;
}

/** Texts the editor redraws itself (room labels): a fix to them would be undone by the next cut change. */
const managed = (text: TextOverlay) => text.id.startsWith("room-");

const quote = (text: TextOverlay) => `“${text.text.length > 24 ? `${text.text.slice(0, 23)}…` : text.text}”`;

// ── The checks ──────────────────────────────────────────────────

type Context = CriticInput & { frames: ReadonlyMap<string, CriticFrame>; total: number; starts: number[]; measure: Measure };

const frameAt = (ctx: Context, reelMs: number) => {
  const moment = momentAt(ctx.timeline, reelMs);
  return moment ? { moment, frame: ctx.frames.get(moment.key) ?? null } : null;
};

/** Motion energy of a clip's opening (the largest step difference), or null when its frames were not read. */
function openingEnergy(ctx: Context, index: number): number | null {
  const clip = ctx.timeline.clips[index];
  if (cameraMoves(clip)) return 1;
  const d = clipDurationMs(clip);
  const a = frameAt(ctx, ctx.starts[index]), b = frameAt(ctx, ctx.starts[index] + Math.min(CRITIC.stepMs, d - FRAME_MS));
  return a?.frame && b?.frame ? frameDifference(a.frame, b.frame) : null;
}

function hookCheck(ctx: Context): CriticFinding | null {
  const { timeline, starts } = ctx;
  const first = timeline.clips[0];
  if (!first || timeline.hook) return null;
  if (starts.some((start) => start > 0 && start <= CRITIC.hookMs)) return null;
  if (timeline.texts.some((text) => text.startMs < CRITIC.hookMs)) return null;
  if (cameraMoves(first)) return null;
  if (first.kind === "VIDEO") {
    const frames: CriticFrame[] = [];
    for (let t = 0; t <= CRITIC.hookMs; t += CRITIC.stepMs) {
      const at = frameAt(ctx, t);
      if (!at?.frame) return null; // Not read: the opening is not judged without its pixels.
      frames.push(at.frame);
    }
    if (frames.some((frame, i) => i > 0 && frameDifference(frames[i - 1], frame) > CRITIC.motion)) return null;
  }
  const fixes: CriticFix[] = [];
  // The liveliest later shot, by its opening's motion; only one that clearly moves.
  let hero = -1, best: number = CRITIC.motion;
  timeline.clips.forEach((_, index) => {
    if (index === 0 || index > 12) return;
    const energy = openingEnergy(ctx, index);
    if (energy !== null && energy > best) { best = energy; hero = index; }
  });
  if (hero > 0) fixes.push({ kind: "command", label: `Start on shot ${hero + 1}`, command: { type: "moveClip", clipId: timeline.clips[hero].id, toIndex: 0 }, safe: false });
  const headline = ctx.headline?.trim();
  if (headline) {
    const id = uniqueTextId(timeline, "hook-title");
    fixes.push({
      kind: "command", label: "Title in the first second", safe: false,
      command: { type: "addText", text: { id, text: headline.slice(0, 60), startMs: 150, endMs: Math.min(ctx.total, 2400), x: 0.5, y: 0.36, style: "headline", color: "#ffffff", size: 1 } },
    });
  }
  const moment = momentAt(timeline, 0);
  return {
    id: "hook:opening", check: "hook", severity: "high", impact: "hook",
    reason: "Nothing changes in the first 1.5 s, so people scroll past before it gets going.",
    atMs: 0, clipId: moment?.clipId ?? null, sourceMs: moment?.sourceMs ?? null, fixes,
  };
}

function uniqueTextId(timeline: Timeline, base: string): string {
  const ids = new Set(timeline.texts.map((text) => text.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** How far a box reaches into Instagram's zones, px per side (0 when clear). */
function intrusion(box: CriticBox) {
  const zone = INSTAGRAM.safeZonePx;
  return {
    left: Math.max(0, zone.left - box.x * W),
    right: Math.max(0, (box.x + box.w) * W - (W - zone.right)),
    top: Math.max(0, zone.top - box.y * H),
    bottom: Math.max(0, (box.y + box.h) * H - (H - zone.bottom)),
  };
}

/** Where a screen title's centre goes so its box sits inside the safe area (centred in it on an axis where it is too big). */
function safeCentre(text: TextOverlay, box: CriticBox): { x: number; y: number } {
  const zone = INSTAGRAM.safeZonePx;
  const left = zone.left / W, right = 1 - zone.right / W, top = zone.top / H, bottom = 1 - zone.bottom / H;
  // The box's offset from the stored centre (a drift path moves it): keep it.
  const dx = box.x + box.w / 2 - text.x, dy = box.y + box.h / 2 - text.y;
  const fit = (centre: number, half: number, lo: number, hi: number) => (2 * half >= hi - lo ? (lo + hi) / 2 : Math.min(hi - half, Math.max(lo + half, centre)));
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { x: round(fit(box.x + box.w / 2, box.w / 2, left, right) - dx), y: round(fit(box.y + box.h / 2, box.h / 2, top, bottom) - dy) };
}

function titleChecks(ctx: Context): CriticFinding[] {
  const findings: CriticFinding[] = [];
  for (const text of ctx.timeline.texts) {
    if (managed(text)) continue;
    const font = ctx.titleFont(text);
    const geometry = titleGeometry(ctx.timeline, text, font, ctx.measure);
    if (!geometry) continue;
    const moment = momentAt(ctx.timeline, titleMoment(text));
    const base = { atMs: moment?.reelMs ?? text.startMs, clipId: moment?.clipId ?? null, sourceMs: moment?.sourceMs ?? null, box: geometry.box, textId: text.id };
    // Only a plain screen title moves by its x/y. A surface title's corners decide where it is, and a pinned
    // title's tracked path is offsets from x/y (cinematic.ts textPositionAt): moving x/y drags it off its object.
    const movable = geometry.kind === "screen" && !text.pin;

    // Safe zones.
    const into = intrusion(geometry.box);
    const worst = Math.max(into.left, into.right, into.top, into.bottom);
    // Only a title a person placed or moved is theirs to fix; the app answers for its own (ADR 0081).
    if (worst > CRITIC.intrusionPx && !placedByApp(text)) {
      const where = into.bottom === worst ? "the caption" : into.top === worst ? "the header" : into.right === worst ? "the like and share buttons" : "the screen edge";
      const fixes: CriticFix[] = [];
      if (movable) {
        const centre = safeCentre(text, geometry.box);
        if (Math.abs(centre.x - text.x) > 0.001 || Math.abs(centre.y - text.y) > 0.001) {
          fixes.push({ kind: "command", label: "Move it in", command: { type: "updateText", textId: text.id, patch: { x: centre.x, y: centre.y } }, safe: true });
        }
      }
      findings.push({ ...base, id: `safe-zone:${text.id}`, check: "safe-zone", severity: "high", impact: impactOf(base.atMs, ctx.total),
        reason: `${quote(text)} runs under ${where}${geometry.kind === "surface" ? "; it is on a surface, so move its corners" : text.pin ? "; it is tracked, so place it again" : ""}.`, fixes });
    }

    // Size on a phone (a surface title is sized by its surface, not by `size`).
    const phonePx = (geometry.fontPx * CRITIC.phoneWidthPx) / W;
    if (geometry.kind === "screen" && phonePx < CRITIC.minPhoneFontPx && text.size < TEXT_SIZE_MAX) {
      const size = Math.min(TEXT_SIZE_MAX, Math.ceil(((text.size * CRITIC.minPhoneFontPx) / phonePx) * 20) / 20);
      // Bigger type takes more room: if at its new size the box would reach into Instagram's zones, the same
      // step moves it in (from the box at the new size), so making it bigger never undoes a move.
      const bigger = { ...text, size };
      const grown = movable ? titleGeometry(ctx.timeline, bigger, ctx.titleFont(bigger), ctx.measure) : null;
      const reach = grown ? intrusion(grown.box) : null;
      const centre = grown && reach && Math.max(reach.left, reach.right, reach.top, reach.bottom) > 0 ? safeCentre(text, grown.box) : null;
      findings.push({ ...base, id: `legibility-size:${text.id}`, check: "legibility", severity: "medium", impact: impactOf(base.atMs, ctx.total),
        reason: `${quote(text)} is about ${Math.round(phonePx)} px on a phone; small type is skipped.`,
        fixes: [{ kind: "command", label: "Make it bigger", command: { type: "updateText", textId: text.id, patch: centre ? { size, x: centre.x, y: centre.y } : { size } }, safe: true }] });
    }

    // Contrast with the frame behind it. A box or tag paints its own background, whatever its shadow, so it is never judged
    // (ADR 0071: "add a shadow" on boxed titles was the critic's commonest false positive); an outline with its own edge is
    // not either; a strong shadow or extrusion is already the fix.
    const ownContrast = ["box", "tag"].includes(text.style) || ((text.shadow ?? "auto") === "auto" && text.style === "outline");
    if (ownContrast || (text.shadow === "strong" && text.blend !== "surface") || (text.depth === "extruded" && text.blend !== "surface")) continue;
    const frame = moment ? ctx.frames.get(moment.key) : undefined;
    const behind = frame ? regionLuminance(frame, geometry.box) : null;
    if (!behind) continue;
    const surface = text.blend === "surface";
    const textL = colorLuminance(text.color);
    // Inverted (ADR 0091) the letters have no colour of their own: judge the negative of each part of the picture against
    // it. Its weak spot is a mid-tone, where the negative is the same grey, so the worst of dark, mean and bright counts.
    const inverted = text.blend === "invert";
    const against = (l: number) => contrastRatio(inverted ? invertedInkLuminance(l, text.color) : textL, l);
    const meanContrast = against(behind.mean);
    const worstContrast = inverted ? Math.min(against(behind.p10), meanContrast, against(behind.p90)) : against(textL > 0.4 ? behind.p90 : behind.p10);
    // Painted on a surface, the wall's own light shows through the letters: hold it to a higher bar.
    const bad = CRITIC.contrastBad * (surface ? 1.3 : 1), good = CRITIC.contrastGood * (surface ? 1.3 : 1);
    if (worstContrast >= good) continue;
    const fix: CriticFix = surface || inverted
      ? { kind: "command", label: inverted ? "On top, not inverted" : "Plain, not painted", command: { type: "updateText", textId: text.id, patch: { blend: "plain" } }, safe: true }
      : { kind: "command", label: "Add a shadow", command: { type: "updateText", textId: text.id, patch: { shadow: "strong" } }, safe: true };
    const decided = meanContrast < bad;
    findings.push({ ...base, id: `legibility:${text.id}`, check: "legibility", severity: decided ? "high" : "low", impact: impactOf(base.atMs, ctx.total),
      reason: decided ? `${quote(text)} is hard to read against the picture behind it.` : `${quote(text)} may be hard to read where the picture behind it is ${textL > 0.4 ? "bright" : "dark"}.`,
      fixes: [fix], ...(decided ? {} : { undecided: { kind: "legibility" as const, textId: text.id, meanContrast, worstContrast } }) });
  }
  return findings;
}

function faceChecks(ctx: Context): CriticFinding[] {
  const faces = new Map((ctx.faces ?? []).map((face) => [face.assetId, face]));
  const findings: CriticFinding[] = [];
  ctx.timeline.clips.forEach((clip, index) => {
    const face = faces.get(clip.assetId);
    if (!face) return;
    const moment = momentAt(ctx.timeline, ctx.starts[index] + Math.min(1000, clipDurationMs(clip) / 2));
    const base = { atMs: moment?.reelMs ?? ctx.starts[index], clipId: clip.id, sourceMs: moment?.sourceMs ?? null, impact: impactOf(ctx.starts[index], ctx.total),
      fixes: [{ kind: "open", label: "Make a closer take", sheet: "ai-video", clipId: clip.id }] as CriticFix[] };
    // The composed keyframe is 1080×1920 like the reel; Fill and the clip's zoom scale her face with the picture.
    const shownPx = face.faceHeightPx !== null ? Math.round(face.faceHeightPx * clip.zoom) : null;
    const speaking = face.floorPx !== null && face.floorPx >= MIN_SPEAKING_FACE_PX;
    if (shownPx !== null && face.floorPx !== null && shownPx < face.floorPx) {
      findings.push({ ...base, id: `face-small:${clip.id}`, check: "face", severity: "high",
        reason: `Her face in shot ${index + 1} is about ${shownPx} px tall, under the ${face.floorPx} px the likeness check needs${speaking ? " for a speaking take" : ""}.` });
    } else if (speaking && shownPx !== null && shownPx < CRITIC.speakingAdvicePx) {
      // Above the gate's floor: advice, with no credit-spending fix offered.
      findings.push({ ...base, fixes: [], id: `face-small:${clip.id}`, check: "face", severity: "low",
        reason: `She speaks in shot ${index + 1} with her face about ${shownPx} px tall; on a phone her eyes and lips read better from ${CRITIC.speakingAdvicePx} px.` });
    } else if (face.eyesAndMouthRendered === false) {
      findings.push({ ...base, id: `face-features:${clip.id}`, check: "face", severity: "high",
        reason: `The likeness check saw her eyes or mouth badly drawn in shot ${index + 1}.` });
    } else if (face.identityScore !== null && face.identityScore < CRITIC.faceReviewScore) {
      findings.push({ ...base, id: `face-identity:${clip.id}`, check: "face", severity: "medium",
        reason: `The likeness check only just passed shot ${index + 1} (${face.identityScore.toFixed(2)}); look closely at her eyes and mouth.` });
    }
  });
  return findings;
}

function loopCheck(ctx: Context): CriticFinding | null {
  const { timeline, total } = ctx;
  const last = timeline.clips.at(-1);
  if (!last || total < 3000) return null;
  const first = frameAt(ctx, 0)?.frame ?? null;
  const end = frameAt(ctx, total - FRAME_MS);
  const diff = first && end?.frame ? frameDifference(first, end.frame) : null;
  const music = timeline.music;
  let offBarMs: number | null = null;
  if (music?.bpm) {
    const bar = beatPeriodMs({ bpm: music.bpm, offsetMs: 0 }) * 4;
    const firstBeat = (music.beatOffsetMs ?? 0) - music.sourceStartMs;
    const r = (((total - firstBeat) % bar) + bar) % bar;
    const away = Math.min(r, bar - r);
    if (away > CRITIC.barToleranceMs) offBarMs = away;
  }
  const jumps = diff !== null && diff > CRITIC.loopMaxDiff;
  if (!jumps && offBarMs === null) return null;

  // The best ending among the candidates: on a bar when the song has a tempo, and the most like the opening when frames were read.
  const lastStart = total - clipDurationMs(last);
  const scored = loopEnds(timeline).map((candidate) => {
    const frame = frameAt(ctx, candidate - FRAME_MS)?.frame ?? null;
    return { end: candidate, diff: first && frame ? frameDifference(first, frame) : null };
  });
  let pick: { end: number; diff: number | null } | null = null;
  if (music?.bpm) {
    const withDiff = scored.filter((c) => c.diff !== null);
    pick = withDiff.length ? withDiff.reduce((a, b) => (b.diff! < a.diff! ? b : a)) : scored[0] ?? null;
    // On a bar is the point; a jump that gets worse is not a fix.
    if (pick && diff !== null && pick.diff !== null && pick.diff > diff + CRITIC.loopMinGain) pick = null;
  } else if (diff !== null) {
    const better = scored.filter((c) => c.diff !== null && c.diff < diff - CRITIC.loopMinGain);
    pick = better.length ? better.reduce((a, b) => (b.diff! < a.diff! ? b : a)) : null;
  }
  const fixes: CriticFix[] = [];
  if (pick && pick.end < total) {
    const speed = last.kind === "IMAGE" ? 1 : last.speed;
    const sourceEndMs = last.sourceStartMs + Math.round((pick.end - lastStart) * speed);
    fixes.push({ kind: "command", label: `End ${((total - pick.end) / 1000).toFixed(1)} s sooner`, command: { type: "trimClip", clipId: last.id, window: { sourceStartMs: last.sourceStartMs, sourceEndMs } }, safe: false });
  }
  const reasons = [jumps ? "the last frame looks nothing like the first, so the replay jumps" : null, offBarMs !== null ? "the music stops mid-bar" : null].filter(Boolean);
  const said = reasons.join(" and ");
  return {
    id: "loop:end", check: "loop", severity: "low", impact: "finish",
    reason: `${said.charAt(0).toUpperCase()}${said.slice(1)}.`,
    atMs: end?.moment.reelMs ?? total - FRAME_MS, clipId: last.id, sourceMs: end?.moment.sourceMs ?? null, fixes,
  };
}

/**
 * Runs every check. A fix is offered only if its command really changes the
 * reel and the result is valid (tried against the timeline, never applied).
 */
export function critique(input: CriticInput): CriticFinding[] {
  const { timeline } = input;
  if (!timeline.clips.length) return [];
  const ctx: Context = { ...input, frames: input.frames ?? new Map(), total: timelineDurationMs(timeline), starts: clipStartsMs(timeline), measure: input.measure ?? fallbackMeasure };
  const series = input.series ?? seriesFromSamples(timeline, ctx.frames);
  const retention = retentionFindings({ timeline, series, transcripts: input.transcripts, presenterAssetIds: input.presenterAssetIds, transformScores: input.transformScores, hook: input.hook, sourceDurationsMs: input.sourceDurationsMs });
  const findings = [hookCheck(ctx), ...titleChecks(ctx), ...faceChecks(ctx), loopCheck(ctx), ...retention].filter((f): f is CriticFinding => f !== null);
  const context = { generation: 0, sourceDurationsMs: input.sourceDurationsMs };
  for (const finding of findings) {
    finding.fixes = finding.fixes.filter((fix) => {
      if (fix.kind !== "command") return true;
      const result = applyCommand(timeline, fix.command, context);
      return !result.rejected && result.changes.length > 0;
    });
  }
  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.atMs - b.atMs);
}

/**
 * Settles the legibility calls the pixels left open by asking `judge`, one
 * call per undecided finding and nothing else. A readable verdict drops the
 * finding; otherwise it stays, raised to medium. A judge that fails leaves
 * the finding as it was.
 */
export async function settleUndecided(findings: CriticFinding[], judge: CriticJudge, timeline: Timeline, frames: ReadonlyMap<string, CriticFrame> = new Map()): Promise<CriticFinding[]> {
  const out: CriticFinding[] = [];
  for (const finding of findings) {
    if (!finding.undecided) { out.push(finding); continue; }
    const text = timeline.texts.find((t) => t.id === finding.undecided!.textId);
    const moment = text ? momentAt(timeline, titleMoment(text)) : null;
    try {
      const verdict = await judge({ textId: finding.undecided.textId, text: text?.text ?? "", color: text?.color ?? "#ffffff", frame: moment ? frames.get(moment.key) ?? null : null, box: finding.box ?? null });
      if (!verdict.readable) out.push({ ...finding, severity: "medium", undecided: undefined });
    } catch {
      out.push(finding);
    }
  }
  return out;
}

/**
 * The fixes "Fix all" applies: one safe command per finding, with every change to one title merged into
 * one `updateText` (a resize, which places the box at its new size, applied over a move), then the beat
 * snap. Running the critic again afterwards finds nothing left to fix safely.
 */
export function safeFixes(findings: readonly CriticFinding[]): BatchableCommand[] {
  const commands = findings.flatMap((finding): BatchableCommand[] => {
    const fix = finding.fixes.find((f): f is Extract<CriticFix, { kind: "command" }> => f.kind === "command" && f.safe);
    if (!fix) return [];
    // A fix that is itself a batch (the frame-exact beat snap) contributes its steps; a proposal is never a fix.
    if (fix.command.type === "batch") return fix.command.commands;
    return fix.command.type === "applyProposal" ? [] : [fix.command];
  });
  const patches = new Map<string, Extract<BatchableCommand, { type: "updateText" }>["patch"]>();
  const others: BatchableCommand[] = [];
  const updates = commands.filter((c): c is Extract<BatchableCommand, { type: "updateText" }> => c.type === "updateText");
  for (const command of [...updates.filter((c) => c.patch.size === undefined), ...updates.filter((c) => c.patch.size !== undefined)]) {
    patches.set(command.textId, { ...patches.get(command.textId), ...command.patch });
  }
  for (const command of commands) if (command.type !== "updateText" && command.type !== "snapToBeat") others.push(command);
  return [
    ...[...patches].map(([textId, patch]): BatchableCommand => ({ type: "updateText", textId, patch })),
    ...others,
    ...commands.filter((c) => c.type === "snapToBeat").slice(0, 1),
  ];
}

/** "Fix all" as one command (one step, one undo), or null when nothing safe is left to fix. */
export function fixAllCommand(findings: readonly CriticFinding[]): Command | null {
  const commands = safeFixes(findings);
  return commands.length ? { type: "batch", commands } : null;
}
