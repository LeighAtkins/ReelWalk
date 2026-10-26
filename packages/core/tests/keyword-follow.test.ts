import { describe, expect, it } from "vitest";
import {
  BUTTON_COLUMN_X, composeKeywordLockups, criticallyDamped, faceBoxAt, followPaths, parseTimeline, REEL_FORMAT, SAFE_AREA, SERIF_CAP_EM, TEXT_SAFE_BOTTOM, textPositionAt,
  type FaceInput, type TextOverlay, type Timeline, type TranscriptWord,
} from "../src";

// ADR 0089 round 3: lockups follow the presenter's head through the phrase.
const WALK = "ai-walk";
const SPEECH: Record<string, TranscriptWord[]> = {
  [WALK]: [
    { w: "Your", s: 200, e: 500 }, { w: "listing", s: 500, e: 900 }, { w: "deserves", s: 900, e: 1400 }, { w: "more", s: 1400, e: 1700 },
    { w: "than", s: 1700, e: 1900 }, { w: "a", s: 1900, e: 2000 }, { w: "slideshow.", s: 2000, e: 2600 },
  ],
};
// Her face drifts right and down over the take (a walk with the camera sliding), sampled every 100 ms.
const track = Array.from({ length: 31 }, (_, i) => ({ ms: i * 100, x0: 0.36 + i * 0.004, y0: 0.3 + i * 0.002, x1: 0.56 + i * 0.004, y1: 0.42 + i * 0.002 }));
const MOVING: Record<string, FaceInput> = { [WALK]: { x0: 0.36, y0: 0.3, x1: 0.56, y1: 0.42, width: 1080, height: 1920, track } };
const STILL: Record<string, FaceInput> = { [WALK]: { x0: 0.36, y0: 0.3, x1: 0.56, y1: 0.42, width: 1080, height: 1920 } };

const reel = (camera?: unknown): Timeline =>
  parseTimeline({ version: 1, music: null, texts: [], clips: [{ id: "walk", assetId: WALK, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, ...(camera ? { camera } : {}) }] });
const halfWidth = (text: TextOverlay) => (text.text.length * text.size * 76 * 0.7 * 0.55) / 2 / REEL_FORMAT.width;

describe("criticallyDamped", () => {
  it("starts on the first target, never overshoots a step, and settles", () => {
    const steps = [0, ...Array(60).fill(1)];
    const out = criticallyDamped(steps, 1000 / 30);
    expect(out[0]).toBe(0);
    expect(Math.max(...out)).toBeLessThanOrEqual(1 + 1e-9);
    expect(out[out.length - 1]).toBeGreaterThan(0.99);
    // A steady walk is followed with a small lag, not a jump.
    expect(out[3]).toBeLessThan(0.5);
  });

  it("takes the frame-to-frame wobble out of a noisy track", () => {
    const noisy = Array.from({ length: 90 }, (_, i) => 0.1 + (i % 2 ? 0.01 : -0.01));
    const out = criticallyDamped(noisy, 1000 / 30).slice(30);
    expect(Math.max(...out) - Math.min(...out)).toBeLessThan(0.004);
  });
});

describe("followPaths", () => {
  const times = Array.from({ length: 61 }, (_, i) => (i * 1000) / 30);
  const room = { dx0: -0.05, dx1: 0.05, dy0: -0.05, dy1: 0.02 };

  it("gives each member the path for its own life, inside the shared room, at most 64 keyframes from t 0 to 1", () => {
    const targets = times.map((_, i) => ({ x: i * 0.002, y: i * 0.002 }));
    const [a, b] = followPaths(times, targets, [{ startMs: 0, endMs: 2000, room }, { startMs: 1000, endMs: 2000, room: { ...room, dy1: 0.01 } }]);
    for (const path of [a!, b!]) {
      expect(path.length).toBeLessThanOrEqual(64);
      expect(path[0].t).toBe(0);
      expect(path[path.length - 1].t).toBe(1);
      // The tighter member's room holds the whole block.
      for (const p of path) { expect(p.x).toBeLessThanOrEqual(0.05 + 1e-9); expect(p.y).toBeLessThanOrEqual(0.01 + 1e-9); }
    }
    // The later member starts where the block already is, not from zero.
    expect(b![0].x).toBeGreaterThan(0.01);
  });

  it("never writes an offset outside the path schema's ±0.5, however far the face goes (round-1 review)", () => {
    const wide = { dx0: -0.9, dx1: 0.9, dy0: -0.9, dy1: 0.9 };
    const [path] = followPaths(times, times.map((_, i) => ({ x: i * 0.02, y: -i * 0.02 })), [{ startMs: 0, endMs: 2000, room: wide }]);
    for (const p of path!) { expect(Math.abs(p.x)).toBeLessThanOrEqual(0.5); expect(Math.abs(p.y)).toBeLessThanOrEqual(0.5); }
  });

  it("leaves a group that hardly moves without a path", () => {
    expect(followPaths(times, times.map(() => ({ x: 0.0005, y: 0 })), [{ startMs: 0, endMs: 2000, room }])).toEqual([undefined]);
  });
});

describe("faceBoxAt", () => {
  it("interpolates the track, holds past its ends, and falls back to the gate's box", () => {
    expect(faceBoxAt(MOVING[WALK], 150).x0).toBeCloseTo(0.366, 6);
    expect(faceBoxAt(MOVING[WALK], -100).x0).toBe(0.36);
    expect(faceBoxAt(MOVING[WALK], 99_999).x0).toBeCloseTo(0.48, 6);
    expect(faceBoxAt(STILL[WALK], 1500)).toEqual({ x0: 0.36, y0: 0.3, x1: 0.56, y1: 0.42 });
  });
});

describe("composeKeywordLockups following the head", () => {
  const composed = composeKeywordLockups(reel(), { speech: SPEECH, faces: MOVING, keywords: ["more"] });
  const keyword = composed.texts.find((t) => t.lockup?.role === "keyword")!;
  const captions = composed.texts.find((t) => t.lockup?.role === "captions")!;

  it("moves the keyword with her face: right and down, smoothly", () => {
    expect(keyword.path).toBeDefined();
    const start = textPositionAt(keyword, 0), end = textPositionAt(keyword, 1);
    expect(end.x - start.x).toBeGreaterThan(0.02);
    expect(end.y - start.y).toBeGreaterThan(0.005);
    // Smooth: no keyframe-to-keyframe step bigger than a steady walk allows.
    const path = keyword.path!;
    for (let i = 1; i < path.length; i++) expect(Math.abs(path[i].x - path[i - 1].x)).toBeLessThan(0.01);
  });

  it("keeps everything inside the safe area while it moves: above y 0.72, left of the button column", () => {
    for (const text of [keyword, captions]) {
      for (let p = 0; p <= 1; p += 0.05) {
        const at = textPositionAt(text, p);
        expect(at.x + (text === keyword ? halfWidth(text) * 0.9 : 0)).toBeLessThanOrEqual(BUTTON_COLUMN_X);
        expect(at.y).toBeLessThanOrEqual(TEXT_SAFE_BOTTOM);
        expect(at.y).toBeGreaterThanOrEqual(SAFE_AREA.top);
      }
    }
  });

  it("keeps the keyword's base behind her head as she moves: the head top stays inside its capitals", () => {
    const H = REEL_FORMAT.height, fontPx = keyword.size * 76 * 0.7, cap = (fontPx * SERIF_CAP_EM) / H;
    for (const ms of [keyword.startMs + 100, (keyword.startMs + keyword.endMs) / 2, keyword.endMs - 50]) {
      const at = textPositionAt(keyword, (ms - keyword.startMs) / (keyword.endMs - keyword.startMs));
      const baseline = at.y + (0.4155 * fontPx) / H;
      const face = faceBoxAt(MOVING[WALK], ms);
      const headTop = face.y0 - 0.28 * (face.y1 - face.y0);
      // The follow lags a little: within a fifth of the capitals of the measured cover.
      expect(baseline - headTop).toBeGreaterThan(0.15 * cap);
      expect(baseline - headTop).toBeLessThan(0.55 * cap);
    }
  });

  it("leaves a locked-off take exactly as before (no path), and follow: false off", () => {
    const still = composeKeywordLockups(reel(), { speech: SPEECH, faces: STILL, keywords: ["more"] });
    expect(still.texts.every((t) => !t.path)).toBe(true);
    const off = composeKeywordLockups(reel(), { speech: SPEECH, faces: MOVING, keywords: ["more"], follow: false });
    expect(off.texts.every((t) => !t.path)).toBe(true);
  });

  it("follows the clip's camera move even without a track (an opening scale-out)", () => {
    const camera = { preset: "custom", keys: [{ p: 0, scale: 1.3, x: 0, y: 0 }, { p: 0.6, scale: 1, x: 0, y: 0, ease: "out" }, { p: 1, scale: 1, x: 0, y: 0, ease: "linear" }] };
    const moved = composeKeywordLockups(reel(camera), { speech: SPEECH, faces: STILL, keywords: ["more"] });
    expect(moved.texts.find((t) => t.lockup?.role === "keyword")!.path).toBeDefined();
  });

  it("does not move a keyword the author placed", () => {
    const placed = composeKeywordLockups(reel(), { speech: SPEECH, faces: MOVING, keywords: ["more"], placements: { more: { x: 0.5, y: 0.3 } } });
    expect(placed.texts.find((t) => t.lockup?.role === "keyword")!.path).toBeUndefined();
  });
});
