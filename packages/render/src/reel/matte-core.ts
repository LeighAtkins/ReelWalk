/**
 * The matte rule, without a DOM (ADR 0051). Preview and export run exactly
 * this code; the components only fetch pixels, call the segmenter and draw.
 *
 * Person: raw(f) is the segmenter's mask of picture f, refined (a second pass
 * on a crop around the person, a guided filter onto the picture's edges, a
 * one-pixel grow). The matte of frame n is raw(n) settled 35 % toward
 * raw(n − 1), the previous frame *of the same shot* (none on its first
 * frame). That is a pure function of the two pictures: whichever order the
 * frames are asked for in (playback, a scrub, parallel render pages, a retry)
 * the alpha is the same. The editor used to skip the previous frame when it
 * was not cached, so a scrubbed preview and the export disagreed; now both
 * read it from the footage when it is not held.
 *
 * Object: the union of the touch segmenter's masks at the taps on frame n,
 * refined the same way; no settle. Each tap is placed on frame n by
 * `trackTaps` (the point tracker, falling back to the wall's homography).
 *
 * MATTE_VERSION names every input that changes the pixels: the rule, sizes,
 * thresholds, tracker settings, runtime and model hashes. It is derived from
 * them, so it cannot be forgotten when one changes; a test pins its value so
 * the change shows in review.
 */
import { MATTE_MODELS, MATTE_WASM, TASKS_VISION_VERSION } from "./matte-assets";
import { blend, boundingBox, grow, guidedFilter, luminance, paste, resample, toAlpha, Workspace, type Mask } from "./matte-refine";
import { TRACK_PARAMS, trackPoint, type Gray, type Point, type TrackStatus } from "./point-track";

/** Working size for the matte's edge work: a quarter of the pixels, upscaled at the end; the model's own grid is coarser still. */
export const WORK_WIDTH = 540, WORK_HEIGHT = 960;

export const PERSON_PARAMS = {
  /** The crop pass runs around the pixels above this confidence, padded by these shares of the box. */
  cropThreshold: 0.5, padX: 0.15, padY: 0.1,
  /** A crop smaller than this (either side) or larger than this share of the frame is not worth a second pass. */
  minCrop: 16, maxCropShare: 0.6,
  radius: 5, eps: 2e-3,
  /** Two pixels, with a low alpha floor, drew a halo of the wall behind her over the words around the hair (snow reel, 2026-10-21). */
  grow: 1,
  /** How much of the previous frame's mask is kept, to settle the edge between frames. */
  settle: 0.35,
  /** The edge ramps over the middle of the segmenter's confidence: a floor near zero kept the background around the hair. */
  low: 0.35, high: 0.65,
} as const;

export const OBJECT_PARAMS = { radius: 5, eps: 2e-3, grow: 2, low: 0.35, high: 0.65 } as const;

/** The blur on the alpha when it is scaled up to the frame. */
export const COMPOSITE_PARAMS = { blurPx: 0.8 } as const;

export const MATTE_INPUTS = {
  rule: "person: raw(n) settled toward raw(n-1) of the same shot, pictures at exact source times; object: union of taps on frame n while the title's frame range is on screen, each tap tracked from the exact source time it was made on (exhaustive search before lost), else carried by the wall; seeks clamped to the file, same picture within 3 ms",
  work: [WORK_WIDTH, WORK_HEIGHT],
  person: PERSON_PARAMS,
  object: OBJECT_PARAMS,
  composite: COMPOSITE_PARAMS,
  track: TRACK_PARAMS,
  runtime: { tasksVision: TASKS_VISION_VERSION, wasm: MATTE_WASM.binary.sha256 },
  models: { selfie: MATTE_MODELS.selfie.sha256, touch: MATTE_MODELS.touch.sha256 },
} as const;

/** 64-bit FNV-1a of a string, as hex: stable across platforms, no crypto needed. */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export const MATTE_VERSION = `matte-1-${fnv1a64(JSON.stringify(MATTE_INPUTS))}`;

export type Rgba = { data: Uint8ClampedArray; width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
/** The selfie segmenter on the working picture (`null`) or a crop of it: its mask at the model's own resolution, a copy the caller may keep, or null. */
export type PersonSegment = (crop: Rect | null) => Mask | null;
/** The touch segmenter asked about a point (frame fractions) on the working picture. */
export type TouchSegment = (point: Point) => Mask | null;

/** raw(f): the person in `pixels` as a soft mask written into `out` (same size). False when the segmenter gives nothing. */
export function personRaw(pixels: Rgba, segment: PersonSegment, ws: Workspace, out: Float32Array): boolean {
  const { width, height } = pixels;
  const n = width * height;
  const whole = segment(null);
  if (!whole) return false;
  let mask = resample(whole, width, height, ws.f32("person.coarse", n));
  const box = boundingBox(mask, PERSON_PARAMS.cropThreshold);
  if (box) {
    const padX = (box.x1 - box.x0) * PERSON_PARAMS.padX, padY = (box.y1 - box.y0) * PERSON_PARAMS.padY;
    const x0 = Math.max(0, Math.floor(box.x0 - padX)), y0 = Math.max(0, Math.floor(box.y0 - padY));
    const x1 = Math.min(width, Math.ceil(box.x1 + padX)), y1 = Math.min(height, Math.ceil(box.y1 + padY));
    const cw = x1 - x0, ch = y1 - y0;
    if (cw > PERSON_PARAMS.minCrop && ch > PERSON_PARAMS.minCrop && cw * ch < n * PERSON_PARAMS.maxCropShare) {
      const fine = segment({ x: x0, y: y0, width: cw, height: ch });
      if (fine) mask = paste(resample(fine, cw, ch, ws.f32("person.crop", cw * ch, n)), width, height, x0, y0, ws.f32("person.paste", n));
    }
  }
  const guide = luminance(pixels.data, ws.f32("person.guide", n));
  const filtered = guidedFilter(mask, guide, PERSON_PARAMS.radius, PERSON_PARAMS.eps, ws, ws.f32("person.filtered", n));
  grow(filtered, PERSON_PARAMS.grow, ws, out);
  return true;
}

export type ObjectOutcome = "ok" | "off-frame" | "no-mask";

/**
 * The objects under `taps` (frame fractions on this frame) as one soft mask in `out`.
 * `off-frame` when every tap is outside the picture (the object has left: an empty matte is right);
 * `no-mask` when the segmenter gives nothing for a tap that is in the picture (fail closed).
 */
export function objectRaw(pixels: Rgba, segment: TouchSegment, taps: Point[], ws: Workspace, out: Float32Array): ObjectOutcome {
  const { width, height } = pixels;
  const n = width * height;
  const union = ws.f32("object.union", n);
  let any = false;
  for (const tap of taps) {
    if (tap.x < 0 || tap.x > 1 || tap.y < 0 || tap.y > 1) continue;
    const mask = segment(tap);
    if (!mask) return "no-mask";
    const sized = resample(mask, width, height, ws.f32("object.sized", n)).data;
    if (!any) union.set(sized);
    else for (let i = 0; i < n; i++) if (sized[i] > union[i]) union[i] = sized[i];
    any = true;
  }
  if (!any) { out.fill(0); return "off-frame"; }
  const guide = luminance(pixels.data, ws.f32("object.guide", n));
  const filtered = guidedFilter({ data: union, width, height }, guide, OBJECT_PARAMS.radius, OBJECT_PARAMS.eps, ws, ws.f32("object.filtered", n));
  grow(filtered, OBJECT_PARAMS.grow, ws, out);
  return "ok";
}

/** An object matte's alpha (0–255) from its raw mask. */
export function objectAlpha(raw: Float32Array, out: Uint8ClampedArray): Uint8ClampedArray {
  return toAlpha({ data: raw, width: raw.length, height: 1 }, OBJECT_PARAMS.low, OBJECT_PARAMS.high, out);
}

/** How a tap was placed on this frame: found by the tracker, or carried by the wall's homography (no tap frame recorded, or the tracker lost it). */
export type TapStatus = "wall" | TrackStatus;

/** A tap's own frame (luminance at working size) and where on it the author tapped (frame fractions). */
export type TapReference = { gray: Gray; point: Point };

/**
 * Each tap on this frame. `priors` are where the wall's homography carries the taps
 * now (frame fractions). A tap with a reference frame is found by the tracker near
 * its prior; one without (older taps, unpinned titles) stays on its prior: no
 * reference is invented for it.
 */
export function trackTaps(refs: (TapReference | null)[], cur: Gray | null, priors: Point[]): { taps: Point[]; status: TapStatus[] } {
  const taps: Point[] = [], status: TapStatus[] = [];
  priors.forEach((prior, i) => {
    const ref = refs[i];
    if (!ref || !cur) { taps.push(prior); status.push("wall"); return; }
    const found = trackPoint(ref.gray, { x: ref.point.x * ref.gray.width, y: ref.point.y * ref.gray.height }, cur, { x: prior.x * cur.width, y: prior.y * cur.height });
    taps.push({ x: found.x / cur.width, y: found.y / cur.height });
    status.push(found.status);
  });
  return { taps, status };
}

/** One line on how the taps were placed, for the mask's status. */
export function describeTaps(status: TapStatus[]): string {
  if (status.every((s) => s === "wall")) return "taps ride the wall (no tap frame recorded)";
  const tracked = status.filter((s) => s === "tracked").length;
  if (tracked === status.length) return `tracked ${tracked}/${status.length}`;
  const reasons = [...new Set(status.filter((s) => s !== "tracked"))].join(", ");
  return `tracked ${tracked}/${status.length}; the rest follow the wall (${reasons})`;
}

/**
 * Whether a title is on screen on reel frame `frame`: the composition's own
 * frame range for it (framePlan rounds start and end to frames the same way),
 * so the matte is never off on the title's first drawn frame. An object matte
 * only segments, and only fails an export, while it is.
 */
export function titleActive(text: { startMs: number; endMs: number }, frame: number, fps: number): boolean {
  const toFrame = (ms: number) => Math.round((ms * fps) / 1000);
  return frame >= toFrame(text.startMs) && frame < toFrame(text.endMs);
}

type Slot = { key: string | null; ok: boolean; raw: Float32Array };

/** A frame's working picture and the segmenter on it. */
export type PersonFrame = { pixels: Rgba; segment: PersonSegment };

/**
 * The person matte rule with a two-frame memory. `matte(key, previousKey, read)`
 * returns frame `key`'s alpha; `read` is called only for frames whose raw mask is
 * not held, the previous frame first, so a decode is left on `key`. Holding a raw
 * mask is a cache, never an input: the result is the same with or without it.
 * All buffers are allocated once.
 */
export class PersonMatteRule {
  readonly ws = new Workspace();
  readonly alpha: Uint8ClampedArray;
  private readonly settled: Float32Array;
  private readonly slots: [Slot, Slot];

  constructor(readonly width = WORK_WIDTH, readonly height = WORK_HEIGHT) {
    const n = width * height;
    this.slots = [{ key: null, ok: false, raw: new Float32Array(n) }, { key: null, ok: false, raw: new Float32Array(n) }];
    this.settled = new Float32Array(n);
    this.alpha = new Uint8ClampedArray(n);
  }

  private held(key: string): Slot | undefined {
    return this.slots.find((slot) => slot.key === key);
  }

  async matte(key: string, previousKey: string | null, read: (key: string) => Promise<PersonFrame>): Promise<Uint8ClampedArray | null> {
    const wanted = previousKey ? [previousKey, key] : [key];
    for (const k of wanted) {
      if (this.held(k)) continue;
      const slot = this.slots.find((s) => s.key === null || !wanted.includes(s.key))!;
      slot.key = null;
      const frame = await read(k);
      if (frame.pixels.width !== this.width || frame.pixels.height !== this.height) throw new Error(`a ${frame.pixels.width}×${frame.pixels.height} picture for a ${this.width}×${this.height} matte`);
      slot.ok = personRaw(frame.pixels, frame.segment, this.ws, slot.raw);
      slot.key = k;
    }
    const now = this.held(key)!;
    if (!now.ok) return null;
    const before = previousKey ? this.held(previousKey) : undefined;
    const size = { width: this.width, height: this.height };
    const settled = blend({ data: now.raw, ...size }, before?.ok ? { data: before.raw, ...size } : null, PERSON_PARAMS.settle, this.settled);
    return toAlpha(settled, PERSON_PARAMS.low, PERSON_PARAMS.high, this.alpha);
  }
}
