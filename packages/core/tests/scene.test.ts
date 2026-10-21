import { describe, expect, it } from "vitest";
import {
  applyHomography, endsBeforeShot, evaluateTitle, framePlan, homography, invertHomography, orientOrder, orientQuad, parseTimeline,
  PINNED_ELSEWHERE, pinnedProgress, planarFitAndShift, sceneLayers, stackTitles, textPositionAt, textQuadAt,
  type Measure, type Quad, type SurfacePlacement, type TextOverlay, type Timeline, type TitleFont,
} from "../src";

const W = 1080, H = 1920, FPS = 30;
/** A fixed-advance measurer: no DOM in core, so tests pin the width down exactly. */
const measure: Measure = (line, font) => ({ width: line.length * font.fontSize * 0.6, height: font.fontSize * 1.12 });
const font: TitleFont = { fontFamily: "Archivo", fontWeight: 800, fontSize: 96 };

// The smoke reel's titles (packages/render/scripts/render-smoke.ts), the shapes saved reels carry.
const quad = [0.3, 0.3, 0.7, 0.3, 0.7, 0.45, 0.3, 0.45];
const moved = [0.32, 0.31, 0.72, 0.3, 0.72, 0.46, 0.32, 0.46];
const surface = [0.1, 0.2, 0.8, 0.26, 0.8, 0.5, 0.1, 0.56];
const surfaceMoved = [0.12, 0.21, 0.82, 0.27, 0.82, 0.51, 0.12, 0.57];
const bars = [[0.4, 0.2, 0.45, 0.2, 0.45, 0.56, 0.4, 0.56], [0.43, 0.2, 0.5, 0.2, 0.5, 0.56, 0.43, 0.56]];

function reel(texts: unknown[]): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "c1", assetId: "walk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2500 },
      { id: "c2", assetId: "room", kind: "VIDEO", sourceStartMs: 200, sourceEndMs: 2600, transitionIn: "whip", whipDirection: "left" },
      { id: "c3", assetId: "photo", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2000 },
    ],
    texts,
    music: null,
  });
}

const legacy = reel([
  { id: "w1", text: "WELCOME", startMs: 0, endMs: 2500, x: 0.5, y: 0.4, style: "headline", size: 1.4, animation: "pop", behind: true, depth: "extruded" },
  { id: "p1", text: "OCEAN VIEWS", startMs: 2500, endMs: 5000, x: 0.5, y: 0.38, style: "headline", size: 1.1, animation: "none", blend: "surface",
    pin: { assetId: "room", fromMs: 200, toMs: 2600, quad }, path: [{ t: 0, x: 0, y: 0, s: 1, r: 0, q: quad }, { t: 0.6, x: 0.02, y: 0.01, s: 1.02, r: 0.5, q: moved }, { t: 1, x: 0.02, y: 0.01, s: 1.02, r: 0.5, q: moved, o: 0 }] },
  { id: "s1", text: "STEP\nOUT", startMs: 2500, endMs: 4400, x: 0.45, y: 0.38, style: "headline", size: 1, animation: "none", blend: "surface", surface, bars,
    pin: { assetId: "room", fromMs: 200, toMs: 2600, quad: surface }, path: [{ t: 0, x: 0, y: 0, s: 1, r: 0, q: surface }, { t: 1, x: 0.02, y: 0.01, s: 1, r: 0, q: surfaceMoved }] },
  { id: "t2", text: "Just listed", startMs: 4900, endMs: 6900, x: 0.5, y: 0.2, style: "elegant", animation: "fade", path: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0.04, y: 0 }] },
  { id: "b1", text: "LIGHT", startMs: 2600, endMs: 4000, x: 0.5, y: 0.5, surface: [0.7, 0.6, 0.2, 0.6, 0.2, 0.7, 0.7, 0.7], cutouts: [[0.3, 0.6, 0.35, 0.6, 0.35, 0.7]] },
]);

function evalAt(timeline: Timeline, id: string, reelFrame: number) {
  const plan = framePlan(timeline, FPS);
  const entry = plan.texts.find((e) => e.text.id === id)!;
  return evaluateTitle({ text: entry.text, timeline, frame: reelFrame - entry.from, from: entry.from, durationInFrames: entry.durationInFrames, fps: FPS, width: W, height: H, font, measure });
}

const round = (value: unknown): unknown => typeof value === "number" ? Number(value.toFixed(6)) : Array.isArray(value) ? value.map(round)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)])) : value;

/**
 * The pre-0046 renderer's geometry, copied verbatim from ReelComposition's TextView (main at 99391b9), as the
 * oracle: the evaluator must give the same numbers, so existing reels draw the same pixels.
 */
function legacyGeometry(text: TextOverlay, timeline: Timeline, frame: number, from: number, durationInFrames: number) {
  const width = W, height = H, fps = FPS;
  const progress = text.pin ? pinnedProgress(timeline, text, ((from + frame) * 1000) / fps) : durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;
  const position = textPositionAt(text, progress);
  const bare = text.surface && !text.pin ? orientQuad(text.surface) : null;
  const order = text.pin?.quad ? orientOrder(text.pin.quad) : null;
  const reorder = (q: number[] | null): number[] | null => (q && order ? order.flatMap((i) => [q[i * 2], q[i * 2 + 1]]) : q);
  const quadNow = reorder(textQuadAt(text, progress)) ?? bare;
  const plane = (text.pin?.quad ? reorder(text.pin.quad) : bare) ?? undefined;
  if (text.pin && progress === PINNED_ELSEWHERE) return { hidden: true };
  const a = Math.max(0, durationInFrames - Math.round(0.4 * fps)), b = durationInFrames;
  const tail = text.pin && endsBeforeShot(timeline, text) ? (frame <= a ? 1 : frame >= b ? 0 : 1 - (frame - a) / (b - a)) : 1;
  const opacity = position.opacity * tail;
  if (quadNow && plane) {
    const line = Math.max(...text.text.split("\n").map((part) => measure(part || " ", font).width / width));
    const px = (i: number) => plane[i * 2] * width, py = (i: number) => plane[i * 2 + 1] * height;
    const edge = (i: number, j: number) => Math.hypot(px(j) - px(i), py(j) - py(i));
    const w = Math.max(1, (edge(0, 1) + edge(3, 2)) / 2), h = Math.max(1, (edge(0, 3) + edge(1, 2)) / 2);
    const rectWidth = Math.max(0.05, w / width), rectHeight = Math.max(0.02, h / height);
    const lineHeight = ((font.fontSize * 1.12) / height) * text.text.split("\n").length;
    const fit = text.surface ? Math.min((rectWidth * 0.94) / line, (rectHeight * 0.92) / lineHeight) : planarFitAndShift(plane, line).fit;
    const left = plane[0] * width, top = plane[1] * height;
    const now = quadNow.map((v, i) => (i % 2 === 0 ? v * width - left : v * height - top)) as Quad;
    const Hm = homography([0, 0, w, 0, w, h, 0, h], now);
    let posts: string | null = null;
    if (text.surface && (text.bars?.length || text.cutouts?.length)) {
      const H0 = homography([0, 0, w, 0, w, h, 0, h], plane.map((v, i) => (i % 2 === 0 ? v * width - left : v * height - top)) as Quad);
      const inv = H0 ? invertHomography(H0) : null;
      if (inv) {
        const toRect = (x: number, y: number) => { const qx = x * width - left, qy = y * height - top; const d = inv[6] * qx + inv[7] * qy + inv[8] || 1e-9; return `${((inv[0] * qx + inv[1] * qy + inv[2]) / d).toFixed(1)},${((inv[3] * qx + inv[4] * qy + inv[5]) / d).toFixed(1)}`; };
        posts = [...(text.bars ?? []), ...(text.cutouts ?? [])].map((shape) => Array.from({ length: shape.length / 2 }, (_, i) => toRect(shape[i * 2], shape[i * 2 + 1])).join(" ")).join("|");
      }
    }
    return { left, top, w, h, fit, H: Hm, posts, opacity };
  }
  return { x: position.x * width, y: position.y * height, scale: position.scale, rotation: position.rotation, opacity };
}

function asLegacy(p: ReturnType<typeof evaluateTitle>) {
  if (p.kind === "hidden") return { hidden: true };
  if (p.kind === "screen") return { x: p.center.x, y: p.center.y, scale: p.scale, rotation: p.rotation, opacity: p.opacity };
  const posts = p.maskShapes ? p.maskShapes.map((s) => Array.from({ length: s.length / 2 }, (_, i) => `${s[i * 2].toFixed(1)},${s[i * 2 + 1].toFixed(1)}`).join(" ")).join("|") : null;
  return { left: p.rect.left, top: p.rect.top, w: p.rect.width, h: p.rect.height, fit: p.fitScale, H: p.placed, posts, opacity: p.opacity };
}

describe("evaluateTitle: the v1 adapter", () => {
  it("derives screen for a plain or drifting title and surface for a surface or a pinned quad", () => {
    expect(evalAt(legacy, "w1", 10).kind).toBe("screen");
    expect(evalAt(legacy, "t2", 160).kind).toBe("screen");
    expect(evalAt(legacy, "p1", 90).kind).toBe("surface");
    expect(evalAt(legacy, "s1", 90).kind).toBe("surface");
    expect(evalAt(legacy, "b1", 90).kind).toBe("surface");
  });

  it("hides a pinned title while another shot is on screen", () => {
    // p1 runs to 5000 ms; from 4900 ms the photo is on screen, not the room it was pinned on.
    expect(evalAt(legacy, "p1", 148).kind).toBe("hidden");
  });

  it("treats a pin whose keyframes carry no corners as a screen title, as before", () => {
    const t = reel([{ id: "x", text: "HELLO", startMs: 2500, endMs: 4000, pin: { assetId: "room", fromMs: 200, toMs: 2600, quad }, path: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0.1, y: 0 }] }]);
    expect(evalAt(t, "x", 90).kind).toBe("screen");
  });

  it("matches the pre-0046 renderer's geometry on every frame of the legacy titles", () => {
    const plan = framePlan(legacy, FPS);
    for (const entry of plan.texts) {
      for (let frame = 0; frame < entry.durationInFrames; frame += 3) {
        const now = evaluateTitle({ text: entry.text, timeline: legacy, frame, from: entry.from, durationInFrames: entry.durationInFrames, fps: FPS, width: W, height: H, font, measure });
        expect(asLegacy(now), `${entry.text.id} @${frame}`).toEqual(legacyGeometry(entry.text, legacy, frame, entry.from, entry.durationInFrames));
      }
    }
  });
});

describe("evaluateTitle: surfaces", () => {
  const bare = (corners: number[], text = "LIGHT") => reel([{ id: "x", text, startMs: 2600, endMs: 4000, surface: corners }]);
  const at = (t: Timeline) => evalAt(t, "x", 90) as SurfacePlacement;

  it("gives the same placement whatever order the corners were placed in", () => {
    const upright = [0.2, 0.3, 0.8, 0.3, 0.8, 0.4, 0.2, 0.4];
    const reference = at(bare(upright));
    for (const corners of [
      [0.8, 0.3, 0.8, 0.4, 0.2, 0.4, 0.2, 0.3], // started top-right, clockwise
      [0.2, 0.4, 0.8, 0.4, 0.8, 0.3, 0.2, 0.3], // mirrored vertically
      [0.2, 0.3, 0.2, 0.4, 0.8, 0.4, 0.8, 0.3], // anticlockwise
    ]) {
      const other = at(bare(corners));
      expect(round(other.plane)).toEqual(round(reference.plane));
      expect(other.fitScale).toBeCloseTo(reference.fitScale, 9);
      expect(round(other.placed)).toEqual(round(reference.placed));
    }
  });

  it("fits from the average of opposite edges, so a short bottom edge does not make the title huge then thin", () => {
    // Top edge 0.8 of the frame, bottom 0.2: the rectangle is their average, half the frame.
    const trapezoid = at(bare([0.1, 0.3, 0.9, 0.3, 0.6, 0.4, 0.4, 0.4]));
    expect(trapezoid.rect.width).toBeCloseTo(0.5 * W, 6);
    const lineFraction = (5 * 96 * 0.6) / W;
    const heightFraction = Math.hypot(0.2 * W, 0.1 * H) / H; // both sides are equally long
    expect(trapezoid.fitScale).toBeCloseTo(Math.min((0.5 * 0.94) / lineFraction, (heightFraction * 0.92) / ((96 * 1.12) / H)), 9);
    expect(trapezoid.lineBox).toEqual({ width: 5 * 96 * 0.6, height: 96 * 1.12 });
    // The warp still lands the rectangle's corners on the four points given.
    const corner = applyHomography(trapezoid.homography!, trapezoid.rect.width, trapezoid.rect.height);
    expect(corner[0]).toBeCloseTo(0.6 * W, 6); expect(corner[1]).toBeCloseTo(0.4 * H, 6);
  });

  it("is height-bound for a long low strip and wraps nothing", () => {
    const strip = at(bare([0.05, 0.5, 0.95, 0.5, 0.95, 0.51, 0.05, 0.51], "STEP\nOUT"));
    expect(strip.lines).toBe(2);
    expect(strip.fitScale).toBeCloseTo((Math.max(0.02, 0.01) * 0.92) / ((96 * 1.12 * 2) / H), 9);
    expect(strip.clipToPlane).toBe(true);
  });

  it("maps posts and cut-outs into plane coordinates, at the rest plane", () => {
    const p = evalAt(legacy, "s1", 100) as SurfacePlacement;
    expect(p.maskShapes).toHaveLength(2);
    // Each mask point, taken back through the rest plane's warp, is where the post was drawn on the frame.
    const H0 = homography([0, 0, p.rect.width, 0, p.rect.width, p.rect.height, 0, p.rect.height],
      p.restPlane.map((v, i) => v - (i % 2 === 0 ? p.rect.left : p.rect.top)) as Quad)!;
    p.maskShapes!.forEach((shape, s) => {
      for (let i = 0; i < shape.length / 2; i++) {
        const [x, y] = applyHomography(H0, shape[i * 2], shape[i * 2 + 1]);
        expect(x + p.rect.left).toBeCloseTo(bars[s][i * 2] * W, 6);
        expect(y + p.rect.top).toBeCloseTo(bars[s][i * 2 + 1] * H, 6);
      }
    });
    // A pinned plane without a chosen surface has no posts and lets the words overflow.
    const p1 = evalAt(legacy, "p1", 90) as SurfacePlacement;
    expect(p1.maskShapes).toBeNull(); expect(p1.clipToPlane).toBe(false);
  });

  it("follows the track and carries tracked opacity through the keyframes", () => {
    const start = evalAt(legacy, "p1", 75) as SurfacePlacement, later = evalAt(legacy, "p1", 140) as SurfacePlacement;
    expect(start.plane[0]).toBeCloseTo(0.3 * W, 6);
    expect(later.plane[0]).toBeGreaterThan(start.plane[0]);
    expect(start.opacity).toBeCloseTo(1, 9);
    expect(later.opacity).toBeLessThan(1); // the last keyframe fades to o: 0
  });
});

describe("evaluateTitle: occluders and fades", () => {
  it("carries tapped occluders with the tracked plane through a keyframe", () => {
    const t = reel([{ id: "x", text: "VIEW", startMs: 2500, endMs: 5000, surface, occluders: [{ x: 0.5, y: 0.4 }],
      pin: { assetId: "room", fromMs: 200, toMs: 2600, quad: surface }, path: [{ t: 0, x: 0, y: 0, q: surface }, { t: 1, x: 0, y: 0, q: surface.map((v, i) => (i % 2 === 0 ? v + 0.1 : v)) }] }]);
    const first = evalAt(t, "x", 75), last = evalAt(t, "x", 146);
    if (first.kind !== "surface" || last.kind !== "surface") throw new Error("expected surfaces");
    expect(first.occluderTaps[0].x).toBeCloseTo(0.5, 2);
    // Most of the way through the shot the plane has slid right by nearly 0.1; the tap goes with it.
    expect(last.occluderTaps[0].x).toBeGreaterThan(0.58);
    expect(last.occluderTaps[0].y).toBeCloseTo(0.4, 6);
  });

  it("fades a pinned title shortened before its shot over its last 0.4 s", () => {
    // s1 ends at 4400 ms; its shot (the room) runs to 4900 ms.
    const plan = framePlan(legacy, FPS);
    const entry = plan.texts.find((e) => e.text.id === "s1")!;
    const op = (frame: number) => evalAt(legacy, "s1", entry.from + frame).opacity;
    expect(op(0)).toBe(1);
    expect(op(entry.durationInFrames - 12)).toBe(1);
    expect(op(entry.durationInFrames - 6)).toBeCloseTo(0.5, 9);
  });
});

describe("evaluateTitle: legacy snapshots", () => {
  it("has not moved", () => {
    const frames: Record<string, number[]> = { w1: [0, 40], p1: [75, 110, 140], s1: [75, 100, 125], t2: [147, 200], b1: [80] };
    const out = Object.fromEntries(Object.entries(frames).map(([id, list]) => [id, list.map((f) => round(evalAt(legacy, id, f)))]));
    expect(out).toMatchSnapshot();
  });
});

describe("sceneLayers", () => {
  const layers = (t: Timeline) => sceneLayers(t, FPS).map((l) => l.kind === "title" ? `title:${l.text.id}` : l.kind === "person" ? `person:${l.clipIndex}` : `object:${l.text.id}:${l.clipIndex}`);

  it("puts the presenter above the behind titles only, and a plain caption above every matte", () => {
    const t = reel([
      { id: "cap", text: "Caption", startMs: 0, endMs: 2000 },
      { id: "behind", text: "WELCOME", startMs: 0, endMs: 2000, behind: true },
      { id: "post", text: "VIEW", startMs: 2500, endMs: 4000, occluders: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(layers(t)).toEqual(["title:behind", "person:0", "title:post", "object:post:1", "title:cap"]);
  });

  it("draws a behind title's own objects above it and below the presenter", () => {
    const t = reel([{ id: "both", text: "BOTH", startMs: 0, endMs: 3000, behind: true, occluders: [{ x: 0.5, y: 0.5 }] }]);
    expect(layers(t)).toEqual(["title:both", "object:both:0", "object:both:1", "person:0", "person:1"]);
  });

  it("mounts no matte on a still and keeps one presenter matte per clip however many titles sit behind", () => {
    const t = reel([
      { id: "a", text: "A", startMs: 0, endMs: 1000, behind: true },
      { id: "b", text: "B", startMs: 1000, endMs: 2000, behind: true },
      { id: "c", text: "C", startMs: 5000, endMs: 6000, behind: true, occluders: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(layers(t)).toEqual(["title:a", "title:b", "title:c", "person:0"]);
  });

  it("draws the smoke reel's titles with the presenter matte right after its behind title", () => {
    // On main the matte came after every title; the pixels match only because no other title shares clip 0.
    expect(layers(legacy)).toEqual(["title:w1", "person:0", "title:p1", "title:s1", "title:t2", "title:b1"]);
  });

  it("puts a tapped title that is not behind above the presenter, below its own objects", () => {
    const t = reel([
      { id: "behind", text: "WELCOME", startMs: 0, endMs: 2000, behind: true },
      { id: "tapped", text: "VIEW", startMs: 0, endMs: 2000, occluders: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(layers(t)).toEqual(["title:behind", "person:0", "title:tapped", "object:tapped:0"]);
  });

  it("lets the group beat saved order: a plain caption saved first still draws over a behind title", () => {
    const t = reel([
      { id: "cap", text: "Caption", startMs: 0, endMs: 2000 },
      { id: "tapped", text: "VIEW", startMs: 0, endMs: 2000, occluders: [{ x: 0.5, y: 0.5 }] },
      { id: "behind", text: "WELCOME", startMs: 0, endMs: 2000, behind: true },
    ]);
    expect(layers(t).filter((l) => l.startsWith("title"))).toEqual(["title:behind", "title:tapped", "title:cap"]);
    expect(stackTitles(t.texts).map((text) => text.id)).toEqual(["behind", "tapped", "cap"]);
  });
});
