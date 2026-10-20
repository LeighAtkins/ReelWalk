import { describe, expect, it } from "vitest";
import {
  cameraMoveAt, clipMomentAtSource, clipPicture, clipSchema, compositionScale, compositionToSource, compositionToViewport, emptyTimeline, fitRects, framePlan,
  mapPoints, MOTIONS, onScreenAt, parseTimeline, pictureCanvasTransform, pictureRects, placementVersion, planeFrame, planeMotion, sourceToComposition,
  stageRect, STILL_PLANE, textSchema, viewportToComposition, type ClipPicture, type PictureFit,
} from "../src";

/** The implementation that lived in packages/render/src/reel/presentation.ts before ADR 0047, kept verbatim as the reference. */
function legacyFitRects(sourceWidth: number, sourceHeight: number, width: number, height: number, fit: "cover" | "contain") {
  const scale = fit === "cover" ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight);
  const dw = sourceWidth * scale, dh = sourceHeight * scale;
  if (fit === "cover") {
    const sw = width / scale, sh = height / scale;
    return { sx: (sourceWidth - sw) / 2, sy: (sourceHeight - sh) / 2, sw, sh, dx: 0, dy: 0, dw: width, dh: height };
  }
  return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: (width - dw) / 2, dy: (height - dh) / 2, dw, dh };
}

/**
 * An independent model of what the browser shows: the composition's CSS
 * (object-fit, then `scale(s) translateX(x%)` about the centre) applied to a
 * source pixel step by step, in composition px.
 */
function cssModel(picture: ClipPicture, px: number, py: number): [number, number] {
  const W = picture.frame.width, H = picture.frame.height;
  const k = picture.fit === "cover" ? Math.max(W / picture.sourceWidth, H / picture.sourceHeight) : Math.min(W / picture.sourceWidth, H / picture.sourceHeight);
  // object-fit centres the scaled picture in the element.
  const ex = (W - picture.sourceWidth * k) / 2 + px * k, ey = (H - picture.sourceHeight * k) / 2 + py * k;
  // transform: scale(s) translateX(t) with origin at the centre; functions apply right to left to the point.
  const tx = ex + picture.shiftX * W, ty = ey;
  return [(W / 2 + picture.scale * (tx - W / 2)) / W, (H / 2 + picture.scale * (ty - H / 2)) / H];
}

const SOURCES = [
  { name: "landscape 1920×1080", width: 1920, height: 1080 },
  { name: "portrait 1080×1920", width: 1080, height: 1920 },
  { name: "portrait 720×1280", width: 720, height: 1280 },
  { name: "square 1000×1000", width: 1000, height: 1000 },
  { name: "4K landscape 3840×2160", width: 3840, height: 2160 },
  { name: "tall 1080×2400", width: 1080, height: 2400 },
];
const FITS: PictureFit[] = ["cover", "contain"];
const ZOOMS = [1, 1.37, 2];
const PROGRESS = [0, 0.3, 1];

describe("fitRects (moved to core)", () => {
  it("matches the old render implementation exactly over many sizes", () => {
    for (const s of SOURCES) for (const fit of FITS) for (const [w, h] of [[1080, 1920], [360, 640], [352, 743], [968, 1882], [1, 1]]) {
      expect(fitRects(s.width, s.height, w, h, fit)).toEqual(legacyFitRects(s.width, s.height, w, h, fit));
    }
  });

  it("render still exports the same function", async () => {
    const render = await import("../../render/src/reel/presentation");
    expect(render.fitRects).toBe(fitRects);
  });
});

describe("source px ↔ composition fraction", () => {
  it("agrees with an independent model of the CSS for every fit, zoom and camera move", () => {
    for (const s of SOURCES) for (const fit of FITS) for (const zoom of ZOOMS) for (const motion of MOTIONS) for (const progress of PROGRESS) {
      const picture = clipPicture({ fit, zoom, motion }, s, { progress, seconds: progress * 3 });
      for (const [fx, fy] of [[0, 0], [1, 1], [0.5, 0.5], [0.13, 0.91], [0.77, 0.21]]) {
        const px = fx * s.width, py = fy * s.height;
        const [u, v] = sourceToComposition(picture, px, py);
        const [mu, mv] = cssModel(picture, px, py);
        expect(u).toBeCloseTo(mu, 9);
        expect(v).toBeCloseTo(mv, 9);
      }
    }
  });

  it("round-trips source → composition → source", () => {
    for (const s of SOURCES) for (const fit of FITS) for (const zoom of ZOOMS) for (const motion of MOTIONS) {
      const picture = clipPicture({ fit, zoom, motion }, s, { progress: 0.42, seconds: 1.1 });
      for (const [px, py] of [[0, 0], [s.width, s.height], [s.width * 0.31, s.height * 0.66]]) {
        const [u, v] = sourceToComposition(picture, px, py);
        const [bx, by] = compositionToSource(picture, u, v);
        expect(bx).toBeCloseTo(px, 6);
        expect(by).toBeCloseTo(py, 6);
      }
    }
  });

  it("puts landscape footage under Fill (cover) as a centred crop, not a stretch", () => {
    const picture = clipPicture({ fit: "cover", zoom: 1, motion: "none" }, { width: 1920, height: 1080 }, { progress: 0, seconds: 0 });
    // 1080 / (1920 / 1080) = 607.5 source px wide are shown, from x = 656.25.
    expect(sourceToComposition(picture, 656.25, 0)).toEqual([0, 0]);
    expect(sourceToComposition(picture, 656.25 + 607.5, 1080)).toEqual([1, 1]);
    expect(sourceToComposition(picture, 960, 540)).toEqual([0.5, 0.5]);
    // The old analysis stretched the whole source over the frame: composition x 0.25 read source x 480, which is off screen.
    const [sx] = compositionToSource(picture, 0.25, 0.5);
    expect(sx).toBeCloseTo(656.25 + 607.5 * 0.25, 9);
    expect(sx).not.toBeCloseTo(480, 0);
  });

  it("puts landscape footage under Fit (contain) between bands", () => {
    const picture = clipPicture({ fit: "contain", zoom: 1, motion: "none" }, { width: 1920, height: 1080 }, { progress: 0, seconds: 0 });
    const band = (1920 - 607.5) / 2 / 1920;
    const [u0, v0] = sourceToComposition(picture, 0, 0);
    expect(u0).toBeCloseTo(0, 12);
    expect(v0).toBeCloseTo(band, 12);
    const [u1, v1] = sourceToComposition(picture, 1920, 1080);
    expect(u1).toBeCloseTo(1, 12);
    expect(v1).toBeCloseTo(1 - band, 12);
    // A point in the band has no source pixel: it maps outside the picture.
    expect(compositionToSource(picture, 0.5, 0.1)[1]).toBeLessThan(0);
  });

  it("applies zoom about the centre and the pan's shift before scaling", () => {
    const zoomed = clipPicture({ fit: "cover", zoom: 2, motion: "none" }, { width: 1080, height: 1920 }, { progress: 0, seconds: 0 });
    expect(sourceToComposition(zoomed, 0, 0)).toEqual([-0.5, -0.5]);
    expect(sourceToComposition(zoomed, 540, 960)).toEqual([0.5, 0.5]);
    const pan = clipPicture({ fit: "cover", zoom: 1, motion: "pan" }, { width: 1080, height: 1920 }, { progress: 0, seconds: 0 });
    expect(pan.scale).toBeCloseTo(1.16, 12);
    expect(pan.shiftX).toBeCloseTo(-0.05, 12);
    const [u] = sourceToComposition(pan, 540, 960);
    expect(u).toBeCloseTo(0.5 + 1.16 * -0.05, 12);
  });

  it("takes zoom and move from cameraMoveAt", () => {
    for (const motion of MOTIONS) {
      const picture = clipPicture({ fit: "cover", zoom: 1.5, motion }, { width: 100, height: 100 }, { progress: 0.5, seconds: 0.1 });
      const move = cameraMoveAt(motion, 0.5, 0.1);
      expect(picture.scale).toBeCloseTo(1.5 * move.scale, 12);
      expect(picture.shiftX).toBeCloseTo(move.x / 100, 12);
    }
  });
});

describe("the canvas transform draws what the composition shows", () => {
  it("maps each source pixel through the drawn rectangles to the same place as sourceToComposition", () => {
    for (const s of SOURCES) for (const fit of FITS) for (const motion of MOTIONS) for (const [W, H] of [[1080, 1920], [360, 640], [720, 1280]]) {
      const picture = clipPicture({ fit, zoom: 1.2, motion }, s, { progress: 0.7, seconds: 2 });
      const r = pictureRects(picture);
      const k = W / picture.frame.width;
      const [a, , , d, e, f] = pictureCanvasTransform(picture, W, H);
      for (const [px, py] of [[r.sx, r.sy], [r.sx + r.sw, r.sy + r.sh], [s.width * 0.4, s.height * 0.6]]) {
        // drawImage(source, sx, sy, sw, sh, dx·k, dy·k, dw·k, dh·k) under the transform.
        const cx = (r.dx + ((px - r.sx) * r.dw) / r.sw) * k, cy = (r.dy + ((py - r.sy) * r.dh) / r.sh) * k;
        const [u, v] = sourceToComposition(picture, px, py);
        expect((a * cx + e) / W).toBeCloseTo(u, 9);
        expect((d * cy + f) / H).toBeCloseTo(v, 9);
      }
    }
  });
});

describe("composition fraction ↔ viewport px", () => {
  it("finds the composition inside a box that is not 9:16 (full screen on a 412×915 phone)", () => {
    // Placing mode pads the box to 352×743: the Player draws 352×625.8 with bands above and below.
    const box = { left: 30, top: 76, width: 352, height: 743 };
    const stage = stageRect(box);
    expect(stage.width).toBeCloseTo(352, 9);
    expect(stage.height).toBeCloseTo(352 * 16 / 9, 9);
    expect(stage.top).toBeCloseTo(76 + (743 - 352 * 16 / 9) / 2, 9);
    expect(stage.left).toBe(30);
    // The old code read y by the box's own height: a corner at the picture's top edge was taken as 7.9% down.
    const [, v] = viewportToComposition(stage, 100, stage.top);
    expect(v).toBeCloseTo(0, 12);
    expect((stage.top - box.top) / box.height).toBeGreaterThan(0.07);
  });

  it("is pillarboxed in a wide box", () => {
    const stage = stageRect({ left: 0, top: 0, width: 1000, height: 900 });
    expect(stage.height).toBe(900);
    expect(stage.width).toBeCloseTo(900 * 9 / 16, 9);
    expect(stage.left).toBeCloseTo((1000 - 506.25) / 2, 9);
  });

  it("round-trips and scales", () => {
    const stage = stageRect({ left: 12, top: 40, width: 352, height: 743 });
    for (const [u, v] of [[0, 0], [1, 1], [0.25, 0.8], [-0.2, 1.3]]) {
      const [x, y] = compositionToViewport(stage, u, v);
      const [bu, bv] = viewportToComposition(stage, x, y);
      expect(bu).toBeCloseTo(u, 12);
      expect(bv).toBeCloseTo(v, 12);
    }
    expect(compositionScale(stage)).toBeCloseTo(352 / 1080, 12);
  });
});

describe("planes", () => {
  const first = [0.2, 0.3, 0.7, 0.32, 0.72, 0.5, 0.18, 0.48];
  const now = [0.1, 0.35, 0.6, 0.33, 0.66, 0.55, 0.12, 0.56];

  it("carries stored points to this frame and back", () => {
    const motion = planeMotion(first, now);
    for (let i = 0; i < 4; i++) {
      const [x, y] = motion.toNow(first[i * 2], first[i * 2 + 1]);
      expect(x).toBeCloseTo(now[i * 2], 9);
      expect(y).toBeCloseTo(now[i * 2 + 1], 9);
    }
    const [u, v] = motion.toNow(0.4, 0.4);
    const [bu, bv] = motion.toFirst(u, v);
    expect(bu).toBeCloseTo(0.4, 9);
    expect(bv).toBeCloseTo(0.4, 9);
  });

  it("is still without a pin, on a missing frame, or with a degenerate quad", () => {
    expect(planeMotion(undefined, now)).toBe(STILL_PLANE);
    expect(planeMotion(first, null)).toBe(STILL_PLANE);
    expect(planeMotion([0, 0, 0, 0, 0, 0, 0, 0], now)).toBe(STILL_PLANE);
    expect(STILL_PLANE.toNow(0.3, 0.6)).toEqual([0.3, 0.6]);
  });

  it("maps flat point lists", () => {
    expect(mapPoints([1, 2, 3, 4], (u, v) => [u * 10, v + 1])).toEqual([10, 3, 30, 5]);
  });

  it("gives a quad's plane-local frame both ways", () => {
    const frame = planeFrame(first)!;
    expect(frame.toComposition(0, 0)[0]).toBeCloseTo(0.2, 9);
    expect(frame.toComposition(1, 1)[1]).toBeCloseTo(0.5, 9);
    const [s, t] = frame.toPlane(...frame.toComposition(0.25, 0.75));
    expect(s).toBeCloseTo(0.25, 9);
    expect(t).toBeCloseTo(0.75, 9);
    expect(planeFrame([0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });
});

describe("moments", () => {
  const a = clipSchema.parse({ id: "a", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 1010 });
  const b = clipSchema.parse({ id: "b", assetId: "y", kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 6000, speed: 2, motion: "zoom-in" });
  const timeline = parseTimeline({ ...emptyTimeline(), clips: [a, b] });

  it("reads the clip on screen off the frame-rounded plan, like the composition", () => {
    const plan = framePlan(timeline);
    const entry = plan.clips[1];
    for (const f of [entry.from, entry.from + 10, entry.from + entry.durationInFrames - 1]) {
      const at = onScreenAt(timeline, (f * 1000) / 30)!;
      expect(at.clip.id).toBe("b");
      // presentation.ts: progress = frame / (durationInFrames − 1)
      expect(at.moment.progress).toBeCloseTo((f - entry.from) / (entry.durationInFrames - 1), 6);
      expect(at.sourceMs).toBeCloseTo(2000 + ((f - entry.from) * 1000 / 30) * 2, 6);
    }
    expect(onScreenAt(timeline, 999_999)).toBeNull();
  });

  it("computes the same moment from the source time", () => {
    const m = clipMomentAtSource(b, 4000);
    // 2000 source ms at 2× is 1 s of clip = 30 frames of a 60-frame clip.
    expect(m.seconds).toBeCloseTo(1, 9);
    expect(m.progress).toBeCloseTo(30 / 59, 9);
    expect(clipMomentAtSource(b, 0).progress).toBe(0);
    expect(clipMomentAtSource(b, 99_999).progress).toBe(1);
  });
});

describe("placementVersion", () => {
  const clip = clipSchema.parse({ id: "c", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 });
  const text = textSchema.parse({ id: "t", text: "OCEAN", startMs: 0, endMs: 3000, x: 0.5, y: 0.4, surface: [0.2, 0.3, 0.7, 0.3, 0.7, 0.5, 0.2, 0.5] });
  const base = parseTimeline({ ...emptyTimeline(), clips: [clip], texts: [text] });
  const v = placementVersion(base, "t");

  it("is stable for an unchanged placement and ignores what tracking writes back", () => {
    expect(placementVersion(base, "t")).toBe(v);
    const tracked = { ...base, texts: [{ ...text, path: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0.1, y: 0 }] }] };
    expect(placementVersion(tracked, "t")).toBe(v);
  });

  it("changes when a corner moves, the shot is refitted or trimmed, or the text is gone", () => {
    expect(placementVersion({ ...base, texts: [{ ...text, surface: [0.21, 0.3, 0.7, 0.3, 0.7, 0.5, 0.2, 0.5] }] }, "t")).not.toBe(v);
    expect(placementVersion({ ...base, clips: [{ ...clip, fit: "contain" }] }, "t")).not.toBe(v);
    expect(placementVersion({ ...base, clips: [{ ...clip, sourceStartMs: 100 }] }, "t")).not.toBe(v);
    expect(placementVersion({ ...base, texts: [] }, "t")).toBe("");
  });
});
