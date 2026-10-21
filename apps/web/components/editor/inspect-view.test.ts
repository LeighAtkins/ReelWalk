import { describe, expect, it } from "vitest";
import { clipPicture, sourceToComposition } from "@reelwalk/core";
import {
  FULL_VIEW, INITIAL_INSPECT, clampView, compositionToStage, doubleTapView, drawSourceView, faceHintFromChecks, faceView, inspectFileName, inspectReducer,
  panBy, pinchView, smoothAt, stageToComposition, stepFrameMs, toggleSmoothing, visibleRect, visibleSourceRect, viewMatrix, wheelView, zoomAbout, zoomCap, zoomLabel,
  type InspectContext, type InspectView,
} from "./inspect-view";

const STAGE = { width: 324, height: 576 };
const still = { progress: 0, seconds: 0 };

describe("the inspect view", () => {
  it("never leaves the frame: zoom is held to 1×–8× and the centre so the edges stay inside", () => {
    expect(clampView({ zoom: 20, cx: 0.5, cy: 0.5 }).zoom).toBe(8);
    expect(clampView({ zoom: 0.3, cx: 0.1, cy: 0.9 })).toEqual(FULL_VIEW);
    const v = clampView({ zoom: 4, cx: -1, cy: 2 });
    expect(v).toEqual({ zoom: 4, cx: 0.125, cy: 0.875 });
    const r = visibleRect(v);
    expect(r.u).toBeCloseTo(0); expect(r.v + r.height).toBeCloseTo(1);
  });

  it("zooms about a point: the composition point under the finger stays under it", () => {
    const at: [number, number] = [100, 200];
    const before = stageToComposition(FULL_VIEW, ...at, STAGE);
    const view = zoomAbout(FULL_VIEW, 3, ...at, STAGE);
    expect(view.zoom).toBe(3);
    const [x, y] = compositionToStage(view, ...before, STAGE);
    expect(x).toBeCloseTo(at[0]); expect(y).toBeCloseTo(at[1]);
  });

  it("zooming about a point near an edge is clamped rather than showing past the frame", () => {
    // Zooming out from the top-left corner about the bottom-right of the stage would show past the top left.
    const view = zoomAbout({ zoom: 4, cx: 0.125, cy: 0.125 }, 2, STAGE.width, STAGE.height, STAGE);
    expect(view).toEqual({ zoom: 2, cx: 0.25, cy: 0.25 });
  });

  it("pans with the finger, and stops at the frame's edge", () => {
    const z = { zoom: 4, cx: 0.5, cy: 0.5 };
    const moved = panBy(z, 81, 0, STAGE);
    // 81 px of a 324 px stage at 4× is 1/16 of the composition, the picture moving right.
    expect(moved.cx).toBeCloseTo(0.5 - 1 / 16);
    expect(panBy(z, 10_000, -10_000, STAGE)).toEqual({ zoom: 4, cx: 0.125, cy: 0.875 });
    expect(panBy(FULL_VIEW, 50, 50, STAGE)).toEqual(FULL_VIEW);
  });

  it("pinches: zoom scales with the spread, the midpoint keeps its point, and two fingers moving together pan", () => {
    const from: [[number, number], [number, number]] = [[137, 288], [187, 288]];
    const spread = pinchView(FULL_VIEW, from, [[62, 288], [262, 288]], STAGE);
    expect(spread.zoom).toBe(4);
    const [x, y] = compositionToStage(spread, ...stageToComposition(FULL_VIEW, 162, 288, STAGE), STAGE);
    expect(x).toBeCloseTo(162); expect(y).toBeCloseTo(288);
    const z: InspectView = { zoom: 4, cx: 0.5, cy: 0.5 };
    const panned = pinchView(z, from, [[117, 288], [167, 288]], STAGE);
    expect(panned.zoom).toBe(4);
    expect(panned.cx).toBeCloseTo(0.5 + 20 / 324 / 4);
    expect(pinchView(z, from, [[160, 288], [164, 288]], STAGE).zoom).toBe(1);
    expect(pinchView(z, from, [[0, 288], [324, 288]], STAGE).zoom).toBe(8);
  });

  it("double-tap toggles 1× and 3× at the tap point", () => {
    const in3 = doubleTapView(FULL_VIEW, 240, 120, STAGE);
    expect(in3.zoom).toBe(3);
    const [x, y] = compositionToStage(in3, ...stageToComposition(FULL_VIEW, 240, 120, STAGE), STAGE);
    expect(x).toBeCloseTo(240); expect(y).toBeCloseTo(120);
    expect(doubleTapView(in3, 10, 10, STAGE)).toEqual(FULL_VIEW);
    expect(doubleTapView({ zoom: 7, cx: 0.3, cy: 0.3 }, 10, 10, STAGE)).toEqual(FULL_VIEW);
  });

  it("wheel up zooms in about the cursor, wheel down zooms out", () => {
    const zin = wheelView(FULL_VIEW, -300, 100, 100, STAGE);
    expect(zin.zoom).toBeGreaterThan(1.3);
    expect(wheelView(zin, 300, 100, 100, STAGE).zoom).toBeLessThan(zin.zoom);
  });

  it("the CSS/canvas matrix lands each composition point where compositionToStage says", () => {
    const view: InspectView = { zoom: 5, cx: 0.4, cy: 0.62 };
    const [a, , , d, e, f] = viewMatrix(view, STAGE.width, STAGE.height);
    for (const [u, v] of [[0.4, 0.62], [0.35, 0.6], [0.44, 0.66]]) {
      const [x, y] = compositionToStage(view, u, v, STAGE);
      expect(a * u * STAGE.width + e).toBeCloseTo(x);
      expect(d * v * STAGE.height + f).toBeCloseTo(y);
    }
  });

  it("labels the zoom and picks pixels above 4× unless Smooth is chosen", () => {
    expect(zoomLabel(4)).toBe("4×"); expect(zoomLabel(2.54)).toBe("2.5×"); expect(zoomLabel(7.98)).toBe("8×");
    expect(smoothAt(4, "auto")).toBe(true); expect(smoothAt(4.5, "auto")).toBe(false);
    expect(smoothAt(8, "smooth")).toBe(true); expect(smoothAt(1, "pixels")).toBe(false);
    expect(toggleSmoothing(6, "auto")).toBe("smooth"); expect(toggleSmoothing(2, "auto")).toBe("pixels");
  });
});

describe("inspect state", () => {
  it("switching layer keeps the view, so the same eye is compared in Final and Footage only", () => {
    const zoomed = inspectReducer(INITIAL_INSPECT, { type: "view", view: { zoom: 4, cx: 0.3, cy: 0.2 } });
    const footage = inspectReducer(zoomed, { type: "layer", layer: "footage" });
    expect(footage.layer).toBe("footage");
    expect(footage.view).toEqual(zoomed.view);
    expect(inspectReducer(footage, { type: "layer", layer: "final" }).view).toEqual(zoomed.view);
  });

  it("reset returns to the whole frame and keeps the layer; views are clamped on the way in", () => {
    const s = inspectReducer({ ...INITIAL_INSPECT, layer: "footage" }, { type: "view", view: { zoom: 12, cx: 0, cy: 0 } });
    expect(s.view).toEqual({ zoom: 8, cx: 1 / 16, cy: 1 / 16 });
    expect(inspectReducer(s, { type: "reset" })).toEqual({ ...INITIAL_INSPECT, layer: "footage" });
  });

  it("the smoothing button flips what is shown at the current zoom", () => {
    const at6 = inspectReducer(INITIAL_INSPECT, { type: "view", view: { zoom: 6, cx: 0.5, cy: 0.5 } });
    expect(smoothAt(6, at6.smoothing)).toBe(false);
    const flipped = inspectReducer(at6, { type: "smoothing" });
    expect(smoothAt(6, flipped.smoothing)).toBe(true);
  });

  it("frame steps move one frame on the reel's grid and stay inside it; the view is not part of a step", () => {
    const view = { zoom: 4, cx: 0.3, cy: 0.2 };
    const state = inspectReducer(INITIAL_INSPECT, { type: "view", view });
    expect(stepFrameMs(1000, 1, 4000, 30)).toBeCloseTo(1033.333, 2);
    expect(stepFrameMs(1033.3333, -1, 4000, 30)).toBeCloseTo(1000, 6);
    // From a position between frames, to the neighbour of the frame the Player shows (it rounds).
    expect(stepFrameMs(1010, 1, 4000, 30)).toBeCloseTo(1033.333, 2);
    expect(stepFrameMs(1020, 1, 4000, 30)).toBeCloseTo(1066.667, 2);
    expect(stepFrameMs(0, -1, 4000, 30)).toBe(0);
    expect(stepFrameMs(3990, 1, 4000, 30)).toBeCloseTo(3966.667, 2);
    // Stepping is a seek outside the state: nothing in the state changes.
    expect(state.view).toEqual(clampView(view));
  });
});

/** A recording context that applies the transforms to points, as a 2D canvas does. */
function recorder() {
  let m = [1, 0, 0, 1, 0, 0];
  const mul = (a: number[], b: number[]) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const draws: { m: number[]; args: number[] }[] = [];
  const ctx = {
    fillStyle: "", imageSmoothingEnabled: true, imageSmoothingQuality: "low",
    setTransform: (...t: number[]) => { m = t; },
    transform: (...t: number[]) => { m = mul(m, t); },
    fillRect: () => undefined,
    drawImage: (...args: unknown[]) => { draws.push({ m: [...m], args: args.slice(1) as number[] }); },
  };
  return { ctx: ctx as unknown as InspectContext, draws, state: ctx };
}

/** Where source px (px, py) lands on the canvas for a recorded drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh). */
function landed(draw: { m: number[]; args: number[] }, px: number, py: number): [number, number] {
  const [sx, sy, sw, sh, dx, dy, dw, dh] = draw.args;
  const x = dx + ((px - sx) * dw) / sw, y = dy + ((py - sy) * dh) / sh;
  const m = draw.m;
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

describe("drawing the source frame", () => {
  const cases = [
    { name: "landscape under Fill", clip: { fit: "cover" as const, zoom: 1, motion: "none" as const }, source: { width: 1280, height: 720 } },
    { name: "landscape under Fit, zoomed", clip: { fit: "contain" as const, zoom: 1.3, motion: "none" as const }, source: { width: 1280, height: 720 } },
    { name: "a 9:16 take with a zoom-in", clip: { fit: "cover" as const, zoom: 1, motion: "zoom-in" as const }, source: { width: 720, height: 1280 } },
  ];
  for (const c of cases) {
    it(`puts every source pixel where the composition and the zoom say (${c.name})`, () => {
      const picture = clipPicture(c.clip, c.source, { progress: 0.5, seconds: 2 });
      const view: InspectView = { zoom: 4, cx: 0.45, cy: 0.4 };
      const { ctx, draws, state } = recorder();
      drawSourceView(ctx, {} as CanvasImageSource, picture, view, 648, 1152, false);
      expect(state.imageSmoothingEnabled).toBe(false);
      expect(draws).toHaveLength(1);
      for (const [px, py] of [[c.source.width / 2, c.source.height / 2], [c.source.width * 0.4, c.source.height * 0.45]]) {
        const [u, v] = sourceToComposition(picture, px, py);
        const [x, y] = compositionToStage(view, u, v, { width: 648, height: 1152 });
        const [lx, ly] = landed(draws[0], px, py);
        expect(lx).toBeCloseTo(x, 6); expect(ly).toBeCloseTo(y, 6);
      }
      // The visible source rect is the canvas's own corners taken back to source px.
      const r = visibleSourceRect(picture, view);
      const [ax, ay] = landed(draws[0], r.sx, r.sy), [bx, by] = landed(draws[0], r.sx + r.sw, r.sy + r.sh);
      expect(ax).toBeCloseTo(0, 6); expect(ay).toBeCloseTo(0, 6); expect(bx).toBeCloseTo(648, 6); expect(by).toBeCloseTo(1152, 6);
    });
  }

  it("reads only the visible region of the source, not the whole frame", () => {
    const picture = clipPicture({ fit: "cover", zoom: 1, motion: "none" }, { width: 3840, height: 2160 }, still);
    const { ctx, draws } = recorder();
    drawSourceView(ctx, {} as CanvasImageSource, picture, { zoom: 8, cx: 0.3, cy: 0.7 }, 972, 1728, false);
    const [sx, sy, sw, sh] = draws[0].args;
    const shown = visibleSourceRect(picture, { zoom: 8, cx: 0.3, cy: 0.7 });
    expect(sw).toBeLessThanOrEqual(shown.sw + 3); expect(sh).toBeLessThanOrEqual(shown.sh + 3);
    expect(sx).toBeLessThanOrEqual(shown.sx); expect(sx + sw).toBeGreaterThanOrEqual(shown.sx + shown.sw);
    expect(sy).toBeLessThanOrEqual(shown.sy); expect(sy + sh).toBeGreaterThanOrEqual(shown.sy + shown.sh);
    // 1215×2160 source px are under Fill at 1×; at 8× about 152×270 are read.
    expect(sw * sh).toBeLessThan((1215 * 2160) / 50);
  });

  it("caps Final at 4× on a 3× screen and leaves Footage only at 8×", () => {
    expect(zoomCap("final", 3)).toBe(4); expect(zoomCap("final", 2.625)).toBe(8); expect(zoomCap("footage", 3)).toBe(8);
    const at8 = inspectReducer({ ...INITIAL_INSPECT, layer: "footage" }, { type: "view", view: { zoom: 8, cx: 0.1, cy: 0.1 } });
    const final = inspectReducer(at8, { type: "layer", layer: "final", max: zoomCap("final", 3) });
    expect(final.view).toEqual({ zoom: 4, cx: 0.125, cy: 0.125 });
    expect(inspectReducer(final, { type: "view", view: { zoom: 6, cx: 0.5, cy: 0.5 }, max: 4 }).view.zoom).toBe(4);
  });

  it("at 4× under Fill a 1280×720 source shows a quarter of the 405 px it shows at 1×", () => {
    const picture = clipPicture({ fit: "cover", zoom: 1, motion: "none" }, { width: 1280, height: 720 }, still);
    expect(visibleSourceRect(picture, FULL_VIEW).sw).toBeCloseTo(405, 6);
    expect(visibleSourceRect(picture, { zoom: 4, cx: 0.5, cy: 0.5 }).sw).toBeCloseTo(405 / 4, 6);
  });
});

describe("the presenter's face", () => {
  it("reads the latest first-frame check: a box when stored, else the face height", () => {
    expect(faceHintFromChecks(null)).toBeNull();
    expect(faceHintFromChecks([{ end: "last", faceHeightPx: 300 }])).toBeNull();
    expect(faceHintFromChecks([{ end: "first", attempt: 1, samePerson: true, confidence: 0.82, faceHeightPx: 192 }]))
      .toEqual({ box: null, heightFraction: 0.1 });
    // As the gate stores it (ai-video.ts IdentityCheck): locate attempts with boxes on the 0–1000 grid, y first.
    const boxed = faceHintFromChecks([
      { end: "first", attempt: 1, faceHeightPx: 100, locate: [{ mode: "grid", box: [100, 100, 150, 150] }] },
      { end: "first", attempt: 2, faceHeightPx: 192, locate: [{ mode: "grid", box: [0, 0, 990, 990], rejected: "implausible-box" }, { mode: "pixels", box: [200, 400, 300, 600], faceHeightPx: 192 }] },
      { end: "last", attempt: 1, locate: [{ mode: "grid", box: [500, 500, 600, 600] }] },
    ]);
    expect(boxed?.box).toEqual({ x0: 0.4, y0: 0.2, x1: 0.6, y1: 0.3 });
    expect(boxed?.heightFraction).toBeCloseTo(0.1);
    // A face only too small to judge is still where she is; a box rejected as no face is not used.
    expect(faceHintFromChecks([{ end: "first", locate: [{ mode: "grid", box: [100, 450, 150, 550], rejected: "face-too-small" }] }])?.box).toEqual({ x0: 0.45, y0: 0.1, x1: 0.55, y1: 0.15 });
    expect(faceHintFromChecks([{ end: "first", faceHeightPx: 96, locate: [{ mode: "grid", box: [100, 450, 150, 550], rejected: "face-not-in-crop" }] }]))
      .toEqual({ box: null, heightFraction: 0.05 });
    // A top-level faceBox is not something the gate writes, so it is not read.
    expect(faceHintFromChecks([{ end: "first", faceBox: [200, 400, 300, 600] }])).toBeNull();
    expect(faceHintFromChecks([{ end: "first", faceHeightPx: null, reason: "no-face" }])).toBeNull();
  });

  it("zooms so the face fills 40% of the view, centred on the box", () => {
    const picture = clipPicture({ fit: "cover", zoom: 1, motion: "none" }, { width: 1080, height: 1920 }, still);
    const view = faceView({ box: { x0: 0.4, y0: 0.2, x1: 0.6, y1: 0.3 }, heightFraction: 0.1 }, picture);
    expect(view.zoom).toBeCloseTo(4);
    expect(view.cx).toBeCloseTo(0.5); expect(view.cy).toBeCloseTo(0.25);
  });

  it("falls back to the top-third centre, sized by the stored height or at 4×", () => {
    const picture = clipPicture({ fit: "cover", zoom: 1, motion: "none" }, { width: 720, height: 1280 }, still);
    const small = faceView({ box: null, heightFraction: 0.05 }, picture);
    expect(small.zoom).toBeCloseTo(8); expect(small.cx).toBeCloseTo(0.5); expect(small.cy).toBeCloseTo(0.25);
    expect(faceView(null, picture)).toEqual({ zoom: 4, cx: 0.5, cy: 0.25 });
  });
});

describe("the copied frame's file name", () => {
  it("carries the reel time, zoom and layer", () => {
    expect(inspectFileName(1233.3, 4, "footage")).toBe("reelwalk-inspect-0m01.233s-4x-footage.png");
    expect(inspectFileName(75_500, 2.5, "final")).toBe("reelwalk-inspect-1m15.500s-2.5x-final.png");
  });
});
