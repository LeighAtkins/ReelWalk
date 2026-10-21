import { describe, expect, it } from "vitest";
import {
  applyHomography, behindInPlane, calloutAnchorAt, calloutLabelInSafeArea, CALLOUT_MAX_WIDTH, homography, INSTAGRAM, occluderTapsInPlane, TYPE_MOTION_START_MAX_MS, calloutGeometry, calloutQuad, calloutSvg, calloutTrackTarget, CALLOUT_GAP_PX, CALLOUT_TRACK_HALF, countUpText, evaluateTitle, flareCss,
  framePlan, glintLetter, glintSvg, hasCountableNumber, kineticProgress, parseTimeline, PINNED_ELSEWHERE, revealEdge, setTypeMotionCue, shineAt, shineBandCss, SHINE_PRESET,
  slideFromBehind, snapTypeMotionToBeat, textSchema, typeMotionCues, wordReveal,
  type Measure, type ShineSpec, type SurfacePlacement, type TextOverlay, type Timeline, type TitleFont,
} from "../src";

const W = 1080, H = 1920, FPS = 30;
const measure: Measure = (line, font) => ({ width: line.length * font.fontSize * 0.6, height: font.fontSize * 1.12 });
const font: TitleFont = { fontFamily: "Archivo", fontWeight: 800, fontSize: 96 };

const surface = [0.1, 0.2, 0.8, 0.26, 0.8, 0.5, 0.1, 0.56];
const surfaceMoved = [0.12, 0.21, 0.82, 0.27, 0.82, 0.51, 0.12, 0.57];

function reel(texts: unknown[]): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "c1", assetId: "walk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2500 },
      { id: "c2", assetId: "room", kind: "VIDEO", sourceStartMs: 200, sourceEndMs: 2600 },
      { id: "c3", assetId: "photo", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2000 },
    ],
    texts,
    music: null,
  });
}

function evalAt(timeline: Timeline, id: string, reelFrame: number) {
  const entry = framePlan(timeline, FPS).texts.find((e) => e.text.id === id)!;
  return evaluateTitle({ text: entry.text, timeline, frame: reelFrame - entry.from, from: entry.from, durationInFrames: entry.durationInFrames, fps: FPS, width: W, height: H, font, measure });
}

const msOf = (frame: number) => (frame * 1000) / FPS;

describe("schema (ADR 0061)", () => {
  it("parses a saved title without the new fields exactly as before", () => {
    const saved = { id: "a", text: "HELLO", startMs: 0, endMs: 1000 };
    const parsed = textSchema.parse(saved);
    expect(parsed).not.toHaveProperty("shine");
    expect(parsed).not.toHaveProperty("kinetic");
    expect(parsed).not.toHaveProperty("callout");
  });

  it("keeps shine, kinetic and callout through a parse", () => {
    const parsed = textSchema.parse({ id: "a", text: "$1.2M", startMs: 0, endMs: 3000, shine: { preset: "golden", startMs: 600 }, kinetic: { preset: "count" }, callout: { x: 0.3, y: 0.7 } });
    expect(parsed.shine).toEqual({ preset: "golden", startMs: 600 });
    expect(parsed.kinetic).toEqual({ preset: "count" });
    expect(parsed.callout).toEqual({ x: 0.3, y: 0.7 });
    expect(() => textSchema.parse({ id: "a", text: "x", startMs: 0, endMs: 10, shine: { preset: "disco" } })).toThrow();
  });
});

describe("shine (ADR 0061)", () => {
  const sweep: ShineSpec = { preset: "sweep" };

  it("is a pure function of the frame: same frame, same state and same CSS and SVG strings", () => {
    for (const preset of ["sweep", "glint", "golden"] as const) {
      for (const frame of [0, 14, 20, 33, 61, 90]) {
        const a = shineAt({ preset }, msOf(frame)), b = shineAt({ preset }, msOf(frame));
        expect(a).toEqual(b);
        if (a.band) expect(shineBandCss(a.band)).toEqual(shineBandCss(b.band!));
        if (a.flare) expect(flareCss(a.flare)).toEqual(flareCss(b.flare!));
        for (const [i, g] of a.glints.entries()) expect(glintSvg(g, "#fff")).toBe(glintSvg(b.glints[i], "#fff"));
      }
    }
    expect(shineBandCss(shineAt(sweep, 600).band!).tone.backgroundImage).not.toBe(shineBandCss(shineAt(sweep, 700).band!).tone.backgroundImage);
  });

  it("draws nothing before its start", () => {
    for (const preset of ["sweep", "glint", "golden"] as const) {
      const state = shineAt({ preset }, SHINE_PRESET[preset].startMs - 1);
      expect(state).toEqual({ band: null, glints: [], flare: null });
    }
  });

  it("sweeps the band from wholly before the letters to wholly past them, once per everyMs", () => {
    const { startMs, passMs, band, everyMs } = SHINE_PRESET.sweep;
    const first = shineAt(sweep, startMs)!.band!;
    expect(first.position).toBeCloseTo(-band);
    expect(first.opacity).toBe(0);
    let last = -Infinity;
    for (let t = startMs; t < startMs + passMs; t += 25) {
      const p = shineAt(sweep, t).band!.position;
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
    expect(last).toBeGreaterThan(1);
    expect(shineAt(sweep, startMs + passMs + 1).band).toBeNull();
    expect(shineAt(sweep, startMs + 300)).toEqual(shineAt(sweep, startMs + 300 + everyMs));
    expect(shineAt({ ...sweep, everyMs: 0 }, startMs + 300 + everyMs).band).toBeNull();
  });

  it("takes the title's own angle and start", () => {
    const s = shineAt({ preset: "sweep", angle: -30, startMs: 1000 }, 1300).band!;
    expect(s.angle).toBe(-30);
    expect(shineAt({ preset: "sweep", startMs: 1000 }, 900).band).toBeNull();
    expect(shineBandCss(s).bloom.maskImage.startsWith("linear-gradient(60deg,")).toBe(true);
    expect(shineBandCss(s).tone.backgroundImage.startsWith("linear-gradient(60deg,")).toBe(true);
  });

  it("glint: no band, a few stars at a time, on letters and never on a space", () => {
    let seen = 0;
    for (let t = 0; t < 6000; t += 50) {
      const state = shineAt({ preset: "glint" }, t);
      expect(state.band).toBeNull();
      expect(state.glints.length).toBeLessThanOrEqual(SHINE_PRESET.glint.glints);
      for (const g of state.glints) {
        expect(g.opacity).toBeGreaterThanOrEqual(0);
        expect(g.opacity).toBeLessThanOrEqual(1);
        expect(g.fx).toBeGreaterThanOrEqual(0.45);
        expect(g.fx).toBeLessThanOrEqual(0.85);
        const at = glintLetter("4 BED  HOME", g);
        expect(at).toBeGreaterThanOrEqual(0);
        expect("4 BED  HOME"[at]).not.toMatch(/\s/);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(50);
    expect(glintLetter("   ", { letter: 3 })).toBe(-1);
  });

  it("golden hour: a wide warm band with a streak that rides it; the streak can be turned off", () => {
    const at = SHINE_PRESET.golden.startMs + SHINE_PRESET.golden.passMs / 2;
    const state = shineAt({ preset: "golden" }, at);
    expect(state.band!.half).toBeGreaterThan(SHINE_PRESET.sweep.band);
    expect(state.flare).not.toBeNull();
    expect(state.flare!.x).toBeGreaterThan(0.3);
    expect(state.flare!.x).toBeLessThan(0.7);
    // The streak follows the band across the box.
    expect(shineAt({ preset: "golden" }, at + 300).flare!.x).toBeGreaterThan(state.flare!.x);
    expect(shineAt({ preset: "golden", flare: false }, at).flare).toBeNull();
    expect(shineAt({ preset: "sweep", flare: true }, SHINE_PRESET.sweep.startMs + 300).flare).not.toBeNull();
  });

  it("matches a snapshot of one frame per preset", () => {
    const frame = (preset: ShineSpec["preset"]) => {
      const s = shineAt({ preset }, SHINE_PRESET[preset].startMs + 420);
      return { band: s.band && shineBandCss(s.band), flare: s.flare && flareCss(s.flare), glints: s.glints.map((g) => ({ ...g, svg: glintSvg(g, "#ffffff") })) };
    };
    expect({ sweep: frame("sweep"), glint: frame("glint"), golden: frame("golden") }).toMatchSnapshot();
  });
});

describe("kinetic type (ADR 0061)", () => {
  it("word by word: hidden before, staggered in order, all in after, and the text is kept whole", () => {
    const text = "FOUR BED\nHOME";
    const spec = { preset: "words" as const };
    const at = (ms: number) => wordReveal(text, spec, ms);
    expect(at(0).map((p) => p.text).join("")).toBe(text);
    expect(at(0).filter((p) => !p.space).every((p) => p.opacity === 0 && p.rise > 0 && p.blur > 0)).toBe(true);
    expect(at(900).filter((p) => !p.space).every((p) => p.opacity === 1 && p.rise === 0 && p.blur === 0)).toBe(true);
    const mid = at(400).filter((p) => !p.space).map((p) => p.opacity);
    expect(mid[0]).toBeGreaterThan(mid[1]);
    expect(mid[1]).toBeGreaterThan(mid[2]);
    expect(at(400)).toEqual(at(400));
    // Starts later when told to.
    expect(wordReveal(text, { preset: "words", startMs: 500 }, 400).filter((p) => !p.space).every((p) => p.opacity === 0)).toBe(true);
  });

  it("from behind: the words start wholly behind the edge and slide away from it to their place", () => {
    const spec = { preset: "behind" as const };
    const start = slideFromBehind({ spec, titleMs: 0, textLeft: 300, textRight: 700, edge: 250 });
    expect(start.dx).toBe(-450);
    expect(700 + start.dx).toBe(250);
    expect(start.clipLeft).toBe(250);
    const end = slideFromBehind({ spec, titleMs: 900, textLeft: 300, textRight: 700, edge: 250 });
    expect(end.dx).toBeCloseTo(0);
    // Out to the left from a post on the right.
    const left = slideFromBehind({ spec, titleMs: 0, textLeft: 300, textRight: 700, edge: 760 });
    expect(300 + left.dx).toBe(760);
    expect(left.clipRight).toBe(760);
    expect(left.clipLeft).toBeUndefined();
    // A post across the words: the clip opens at the end so the far side shows too.
    const across = slideFromBehind({ spec, titleMs: 900, textLeft: 300, textRight: 700, edge: 420 });
    expect(across.clipLeft).toBeLessThan(300);
  });

  it("from behind: picks the post or tap nearest the words, else their own left edge", () => {
    expect(revealEdge({ textLeft: 300, textRight: 700, shapes: [[100, 0, 140, 0, 140, 50, 100, 50], [720, 0, 760, 0, 760, 50, 720, 50]] })).toBe(740);
    expect(revealEdge({ textLeft: 300, textRight: 700, points: [{ x: 200, y: 5 }] })).toBe(200);
    expect(revealEdge({ textLeft: 300, textRight: 700 })).toBe(300);
    // Only what is level with the line: a post above it, or a tap below it, is not an edge.
    const band = { textLeft: 300, textRight: 700, textTop: 100, textBottom: 200 };
    expect(revealEdge({ ...band, shapes: [[720, 0, 760, 0, 760, 60, 720, 60]] })).toBe(300);
    expect(revealEdge({ ...band, shapes: [[720, 150, 760, 150, 760, 400, 720, 400]] })).toBe(740);
    expect(revealEdge({ ...band, points: [{ x: 200, y: 300 }] })).toBe(300);
    expect(revealEdge({ ...band, points: [{ x: 200, y: 210 }] })).toBe(200);
  });

  it("count up: every number counts from zero in its own format and lands exactly", () => {
    expect(countUpText("4 BED", 0)).toBe("0 BED");
    expect(countUpText("4 BED", 0.5)).toBe("3 BED");
    expect(countUpText("4 BED", 1)).toBe("4 BED");
    expect(countUpText("$1.2M", 0)).toBe("$0.0M");
    expect(countUpText("$1.2M", 0.25)).toBe("$0.6M");
    expect(countUpText("$1.2M", 1)).toBe("$1.2M");
    expect(countUpText("2,400 sq ft", 0.5)).toBe("2,100 sq ft");
    expect(countUpText("2,400 sq ft", 1)).toBe("2,400 sq ft");
    expect(countUpText("$1,250,000", 1)).toBe("$1,250,000");
    expect(countUpText("3 bed · 2 bath · 240 m²", 1)).toBe("3 bed · 2 bath · 240 m²");
    expect(countUpText("3 bed · 2 bath", 0)).toBe("0 bed · 0 bath");
    expect(countUpText("Ocean views", 0.3)).toBe("Ocean views");
    expect(hasCountableNumber("Ocean views")).toBe(false);
    // Never past the final number, never backwards.
    let last = -1;
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const value = Number(countUpText("1,250", p).replace(/,/g, ""));
      expect(value).toBeGreaterThanOrEqual(last);
      expect(value).toBeLessThanOrEqual(1250);
      last = value;
    }
  });

  it("progress runs over the move's own time", () => {
    expect(kineticProgress({ preset: "count" }, 150)).toBe(0);
    expect(kineticProgress({ preset: "count" }, 750)).toBeCloseTo(0.5);
    expect(kineticProgress({ preset: "count", durationMs: 400, startMs: 0 }, 400)).toBe(1);
  });
});

describe("cues for the pacing work (ADR 0059 seam)", () => {
  const title = textSchema.parse({ id: "p", text: "$1.2M", startMs: 2000, endMs: 5000, shine: { preset: "sweep" }, kinetic: { preset: "count" } });

  it("lists when each move begins, in reel time", () => {
    expect(typeMotionCues(title)).toEqual([{ textId: "p", key: "shine", reelMs: 2400 }, { textId: "p", key: "kinetic", reelMs: 2150 }]);
    expect(typeMotionCues(textSchema.parse({ id: "q", text: "x", startMs: 0, endMs: 10 }))).toEqual([]);
  });

  it("sets a cue on a whole frame, inside the title, relative to its start", () => {
    const moved = setTypeMotionCue(title, "kinetic", 2510);
    expect(moved.kinetic!.startMs).toBe(500);
    expect(setTypeMotionCue(title, "shine", 2520).shine!.startMs).toBe(533);
    expect(setTypeMotionCue(title, "shine", 100).shine!.startMs).toBe(0);
    expect(setTypeMotionCue(title, "shine", 99_000).shine!.startMs).toBe(2999);
    // Never past the schema's bound, however long the title.
    const long = textSchema.parse({ ...title, endMs: 120_000 });
    expect(setTypeMotionCue(long, "shine", 99_000).shine!.startMs).toBe(TYPE_MOTION_START_MAX_MS);
    expect(textSchema.parse(setTypeMotionCue(long, "kinetic", 99_000))).toBeTruthy();
    const plain = textSchema.parse({ id: "q", text: "x", startMs: 0, endMs: 10 });
    expect(setTypeMotionCue(plain, "shine", 5)).toBe(plain);
    expect(textSchema.parse(moved)).toEqual(moved);
  });

  it("snaps every cue to the beat when the music has a tempo, never before the title", () => {
    const snapped = snapTypeMotionToBeat(title, { bpm: 120, beatOffsetMs: 0, sourceStartMs: 0 });
    // Beats every 500 ms: 2400 → 2500, 2150 → 2000 (the title's own start).
    expect(typeMotionCues(snapped).map((c) => c.reelMs)).toEqual([2500, 2000]);
    expect(snapTypeMotionToBeat(title, { bpm: null, beatOffsetMs: null, sourceStartMs: 0 })).toBe(title);
    const late = textSchema.parse({ ...title, startMs: 2100, shine: { preset: "sweep", startMs: 0 } });
    expect(typeMotionCues(snapTypeMotionToBeat(late, { bpm: 120, beatOffsetMs: 0, sourceStartMs: 0 }))[0].reelMs).toBe(2500);
  });
});

describe("plane space: the motion is laid out in the title's plane and carried by it", () => {
  // A tracked surface; a tapped object (first-frame fraction) level with the words, right of them; a post high above them.
  const tap = { x: 0.7, y: 0.38 };
  const above = [0.3, 0.2, 0.34, 0.2, 0.34, 0.21, 0.3, 0.21];
  const timeline = reel([
    { id: "s", text: "OUT", startMs: 2500, endMs: 4900, x: 0.45, y: 0.38, style: "headline", blend: "surface", surface, bars: [above], occluders: [tap], kinetic: { preset: "behind" },
      pin: { assetId: "room", fromMs: 200, toMs: 2600, quad: surface }, path: [{ t: 0, x: 0, y: 0, s: 1, r: 0, q: surface }, { t: 1, x: 0.02, y: 0.01, s: 1, r: 0, q: surfaceMoved }] },
  ]);

  it("carries a tapped object back into the plane through the frame's homography: one fixed place on the surface, on every frame", () => {
    // Independently of the evaluator: the tap's place in the plane is where the rest plane's own map sends it.
    const first = evalAt(timeline, "s", 76) as SurfacePlacement;
    const { width: w, height: h } = first.rect;
    const toPlane = homography(first.restPlane, [0, 0, w, 0, w, h, 0, h])!;
    const [ex, ey] = applyHomography(toPlane, tap.x * W, tap.y * H);
    let travelled = 0;
    for (const frame of [76, 100, 130, 146]) {
      const placement = evalAt(timeline, "s", frame) as SurfacePlacement;
      // On screen the tap moves with the track (carryTaps); in the plane it stays put.
      travelled = Math.max(travelled, Math.abs(placement.occluderTaps[0].x - tap.x) * W);
      const [inPlane] = occluderTapsInPlane(placement, { width: W, height: H });
      expect(inPlane.x).toBeCloseTo(ex, 3);
      expect(inPlane.y).toBeCloseTo(ey, 3);
      const behind = behindInPlane(placement, { width: W, height: H });
      // Level with the words, it is the edge; the post above the line is ignored.
      expect(behind.taps[0].y).toBeGreaterThanOrEqual(behind.textTop);
      expect(behind.edge).toBeCloseTo(ex, 3);
    }
    expect(travelled).toBeGreaterThan(10);
  });

  it("a post or tap above or below the line is not an edge: the words come from their own left edge", () => {
    const high = reel([{ ...timeline.texts[0], occluders: [{ x: 0.7, y: 0.08 }] }]);
    const placement = evalAt(high, "s", 100) as SurfacePlacement;
    const behind = behindInPlane(placement, { width: W, height: H });
    expect(placement.maskShapes).toHaveLength(1);
    expect(behind.edge).toBe(behind.textLeft);
    // Without the band (older callers), the nearest by x would have been taken.
    expect(revealEdge({ textLeft: behind.textLeft, textRight: behind.textRight, shapes: placement.maskShapes, points: behind.taps })).not.toBe(behind.textLeft);
  });
});

describe("pinned callouts (ADR 0061)", () => {
  const point = { x: 0.3, y: 0.7 };
  const square = calloutQuad(point);
  const shifted = square.map((v, i) => Number((v + (i % 2 === 0 ? 0.05 : -0.02)).toFixed(4)));
  const callout = (extra: Record<string, unknown> = {}) => reel([{
    id: "k", text: "Oak", startMs: 2500, endMs: 4900, x: 0.55, y: 0.6, style: "box", size: 0.6, callout: point,
    pin: { assetId: "room", fromMs: 200, toMs: 2600, quad: square },
    path: [{ t: 0, x: 0, y: 0, s: 1, r: 0, q: square }, { t: 0.5, x: 0.05, y: -0.02, s: 1.3, r: 12, q: shifted }, { t: 1, x: 0.05, y: -0.02, s: 1.3, r: 12, q: shifted }],
    ...extra,
  }]);

  it("tracks a small square around the point, with the point as the target's centre", () => {
    expect(square).toEqual([0.22, 0.655, 0.38, 0.655, 0.38, 0.745, 0.22, 0.745]);
    expect((square[2] - square[0]) * W).toBeCloseTo((square[7] - square[1]) * H, 0);
    const target = calloutTrackTarget(textSchema.parse({ id: "k", text: "x", startMs: 0, endMs: 1000, callout: point }));
    expect([target.x, target.y]).toEqual([0.3, 0.7]);
    expect(target.surface).toEqual(square);
    expect(CALLOUT_TRACK_HALF.x * 2 * W).toBeGreaterThan(150);
  });

  it("is a screen title whose label keeps its size and angle and travels with the tracked point", () => {
    const timeline = callout();
    const first = evalAt(timeline, "k", 75), later = evalAt(timeline, "k", 140);
    expect(first.kind).toBe("screen");
    if (first.kind !== "screen" || later.kind !== "screen") throw new Error("screen");
    expect(first.callout!.anchor.x / W).toBeCloseTo(0.3, 3);
    expect(first.callout!.anchor.y / H).toBeCloseTo(0.7, 3);
    expect(later.callout!.anchor.x / W).toBeCloseTo(0.35, 3);
    expect(later.callout!.anchor.y / H).toBeCloseTo(0.68, 3);
    // The label moved exactly as far as the point; the tracked scale and turn are not applied to it.
    expect(later.center.x - first.center.x).toBeCloseTo(later.callout!.anchor.x - first.callout!.anchor.x, 6);
    expect(later.center.y - first.center.y).toBeCloseTo(later.callout!.anchor.y - first.callout!.anchor.y, 6);
    expect([later.scale, later.rotation]).toEqual([1, 0]);
    expect(later.wrap.mode).toBe("line");
  });

  it("maps the point through the square's homography, not just its centre", () => {
    const grown = [0.2, 0.64, 0.4, 0.64, 0.4, 0.76, 0.2, 0.76];
    const text = textSchema.parse({ id: "k", text: "x", startMs: 0, endMs: 1000, callout: { x: 0.25, y: 0.7 }, pin: { assetId: "a", fromMs: 0, toMs: 1000, quad: square }, path: [{ t: 0, x: 0, y: 0, q: square }, { t: 1, x: 0, y: 0, q: grown }] });
    const at = calloutAnchorAt(text, 1);
    expect(at.x).toBeCloseTo(0.3 - 0.05 * (0.1 / 0.08), 4);
    expect(calloutAnchorAt(text, PINNED_ELSEWHERE)).toEqual({ x: 0.25, y: 0.7 });
    const unpinned = textSchema.parse({ id: "k", text: "x", startMs: 0, endMs: 1000, callout: { x: 0.25, y: 0.7 } });
    expect(calloutAnchorAt(unpinned, 0.5)).toEqual({ x: 0.25, y: 0.7 });
  });

  it("fades where the track was lost, and is not drawn on another shot", () => {
    const lost = callout({ path: [{ t: 0, x: 0, y: 0, q: square }, { t: 0.5, x: 0.05, y: -0.02, q: shifted }, { t: 0.6, x: 0.05, y: -0.02, q: shifted, o: 0 }, { t: 1, x: 0.05, y: -0.02, q: shifted, o: 0 }] });
    // Room clip: source 200..2600 played from reel 2500; t = (source - 200) / 2400.
    const frameAt = (t: number) => Math.round(((2500 + t * 2400) * FPS) / 1000);
    expect(evalAt(lost, "k", frameAt(0.3)).opacity).toBe(1);
    const fading = evalAt(lost, "k", frameAt(0.55)).opacity;
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(1);
    expect(evalAt(lost, "k", frameAt(0.8)).opacity).toBe(0);
    // Pinned to the room; while the photo is on screen it is hidden.
    const long = callout({ endMs: 5500 });
    expect(evalAt(long, "k", 160).kind).toBe("hidden");
  });

  it("draws the dot, then the line out of it, then the label, ending outside the label's box", () => {
    const label = { x: 600, y: 1100, halfWidth: 160, halfHeight: 40 };
    const anchor = { x: 300, y: 1350 };
    const g0 = calloutGeometry({ anchor, label, titleMs: 0, lifeMs: 3000 });
    expect(g0.dot.r).toBe(0);
    expect(g0.line!.drawn).toBe(0);
    expect(g0.label.opacity).toBe(0);
    const g = calloutGeometry({ anchor, label, titleMs: 1000, lifeMs: 3000 });
    expect(g.dot.r).toBeGreaterThan(5);
    expect(g.line!.drawn).toBe(1);
    expect(g.label.opacity).toBe(1);
    expect(g.label.shift).toEqual({ x: -0, y: 0 });
    // The line ends exactly the gap outside the box: on the grown box's edge.
    const { x2, y2 } = g.line!;
    const outside = Math.max(Math.abs(x2 - label.x) - label.halfWidth, Math.abs(y2 - label.y) - label.halfHeight);
    expect(outside).toBeCloseTo(CALLOUT_GAP_PX, 6);
    // It starts at the dot's rim, pointing at the label.
    expect(Math.hypot(g.line!.x1 - anchor.x, g.line!.y1 - anchor.y)).toBeGreaterThan(g.dot.r * 0.9);
    // No line when the point is under the label; the whole callout fades out over its last 250 ms.
    expect(calloutGeometry({ anchor: { x: 610, y: 1110 }, label, titleMs: 1000, lifeMs: 3000 }).line).toBeNull();
    expect(calloutGeometry({ anchor, label, titleMs: 2875, lifeMs: 3000 }).opacity).toBeCloseTo(0.5);
    // Same frame, same SVG.
    const size = { width: W, height: H };
    expect(calloutSvg(calloutGeometry({ anchor, label, titleMs: 300, lifeMs: 3000 }), size, "#fff")).toBe(calloutSvg(calloutGeometry({ anchor, label, titleMs: 300, lifeMs: 3000 }), size, "#fff"));
    expect(calloutSvg(g, size, "#ffffff")).toMatchSnapshot();
  });

  it("keeps the label inside Instagram's safe area and at most 86% of the frame wide", () => {
    // A callout's label at its starting size (0.6 of the base, about 58 px).
    const small = { ...font, fontSize: 58 };
    const long = textSchema.parse({ id: "k", text: "Underfloor heating", startMs: 0, endMs: 1000, callout: point });
    const input = { width: W, height: H, font: small, measure };
    const safe = INSTAGRAM.safeZonePx;
    for (const at of [{ x: 0.99, y: 0.99 }, { x: 0, y: 0 }, { x: 0.5, y: 0.5 }]) {
      const c = calloutLabelInSafeArea(long, at, input);
      const half = Math.min(W * CALLOUT_MAX_WIDTH, measure(long.text, small).width) / 2;
      expect(c.x - half).toBeGreaterThanOrEqual(safe.left - 1e-6);
      expect(c.x + half).toBeLessThanOrEqual(W - safe.right + 1e-6);
      expect(c.y).toBeGreaterThan(safe.top);
      expect(c.y).toBeLessThan(H - safe.bottom);
    }
    // Wider than the safe area: centred in it rather than pushed off one side.
    const huge = calloutLabelInSafeArea(textSchema.parse({ id: "k", text: "Underfloor heating in every single room", startMs: 0, endMs: 1000, callout: point }), { x: 0.95, y: 0.5 }, input);
    expect(huge.x).toBeCloseTo((safe.left + W - safe.right) / 2, 6);
    const middle = calloutLabelInSafeArea(textSchema.parse({ id: "k", text: "Oak", startMs: 0, endMs: 1000, callout: point }), { x: 0.5, y: 0.5 }, input);
    expect(middle).toEqual({ x: 540, y: 960 });
    const placement = evalAt(callout({ x: 0.99, y: 0.99 }), "k", 80);
    if (placement.kind !== "screen") throw new Error("screen");
    expect(placement.center.y).toBeLessThan(H - safe.bottom);
    expect(placement.wrap).toEqual({ mode: "line", maxWidth: W * CALLOUT_MAX_WIDTH });
  });

  it("unpinned, goes with the cut instead of pointing into the next shot", () => {
    const loose = reel([{ id: "k", text: "Oak", startMs: 2000, endMs: 3500, x: 0.5, y: 0.5, callout: point }]);
    expect(evalAt(loose, "k", 70).kind).toBe("screen");
    expect(evalAt(loose, "k", 80).kind).toBe("hidden");
  });

  it("does not change a title that is not a callout", () => {
    const plain = reel([{ id: "t", text: "Hi", startMs: 0, endMs: 1000, x: 0.5, y: 0.5, pin: { assetId: "walk", fromMs: 0, toMs: 1000, quad: square }, path: [{ t: 0, x: 0, y: 0, q: square }, { t: 1, x: 0, y: 0, q: shifted }] }]);
    expect(evalAt(plain, "t", 10).kind).toBe("surface");
    const asText = (t: Timeline) => t.texts[0] as TextOverlay;
    expect(asText(plain).callout).toBeUndefined();
  });
});
