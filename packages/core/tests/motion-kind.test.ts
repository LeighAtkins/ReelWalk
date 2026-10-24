import { describe, expect, it } from "vitest";
import { classify, describeMotionKind, readMotion, sideReadOf, STILL_FW_PER_S, type Gray, type MotionKind } from "../src";

/**
 * Synthetic flows (ADR 0074): a smooth textured picture defined everywhere
 * (a few dozen gaussian blobs), sampled at the pixel centres after the camera
 * has moved by a known amount, so the truth is exact and there is no
 * resampling blur. The picture is what a flat stock clip looks like: soft
 * detail, no strong corners.
 */
const W = 96, H = 170;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function scene(seed = 5) {
  const r = rng(seed);
  const blobs = Array.from({ length: 140 }, () => ({ x: (r() - 0.5) * W * 2.4, y: (r() - 0.5) * H * 2.4, s: 1.8 + r() * 5, a: (r() - 0.5) * 220 }));
  return (x: number, y: number) => {
    let v = 128;
    for (const b of blobs) { const dx = x - b.x, dy = y - b.y; v += b.a * Math.exp(-(dx * dx + dy * dy) / (2 * b.s * b.s)); }
    return v;
  };
}

/** Camera motion a second: content velocity in frame widths, scale growth, roll in radians, and the point the picture expands from (frame widths from the centre). */
type Flow = { tx?: number; ty?: number; zoom?: number; roll?: number; focus?: [number, number] };

/** Frames at `times` ms of a camera moving at `flow`, with `noise` grey levels of noise. */
function frames(flow: Flow, times: number[], { noise = 0, seed = 5 }: { noise?: number; seed?: number } = {}) {
  const image = scene(seed);
  const noiseOf = rng(seed + 99);
  const [fx, fy] = flow.focus ?? [0, 0];
  return times.map((t) => {
    const seconds = t / 1000;
    const data = new Float32Array(W * H);
    // Content moves by (tx, ty), scales about the focus and turns: sample the picture at the inverse position.
    const scale = 1 + (flow.zoom ?? 0) * seconds, angle = (flow.roll ?? 0) * seconds;
    const shiftX = (flow.tx ?? 0) * seconds * W, shiftY = (flow.ty ?? 0) * seconds * W;
    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let px = x + 0.5 - W / 2 - fx * W - shiftX, py = y + 0.5 - H / 2 - fy * W - shiftY;
      px /= scale; py /= scale;
      const rx = px * cos - py * sin, ry = px * sin + py * cos;
      const v = image(rx + W / 2 + fx * W, ry + H / 2 + fy * W) + (noise ? (noiseOf() + noiseOf() + noiseOf() - 1.5) * 2 * noise : 0);
      data[y * W + x] = Math.min(255, Math.max(0, v));
    }
    return { t, gray: { data, width: W, height: H } as Gray };
  });
}

const WINDOW = [0, 230, 460];
const read = (flow: Flow, opts?: { noise?: number; seed?: number; times?: number[] }) => readMotion(frames(flow, opts?.times ?? WINDOW, opts))!;

describe("motion classification (ADR 0074)", () => {
  it("recovers a translation to a few percent, in frame widths a second", () => {
    const m = read({ tx: 0.3, ty: -0.1 });
    expect(m.kind).toBe("pan-x");
    expect(m.tx).toBeCloseTo(0.3, 1);
    expect(m.ty).toBeCloseTo(-0.1, 1);
    expect(Math.abs(m.zoom)).toBeLessThan(0.05);
    expect(Math.abs(m.rotate)).toBeLessThan(0.05);
  });

  it("calls a pan sideways or a tilt by its larger component, either way", () => {
    expect(read({ tx: -0.25 })).toMatchObject({ kind: "pan-x" });
    expect(read({ ty: 0.2 })).toMatchObject({ kind: "pan-y" });
    expect(read({ ty: -0.2 })).toMatchObject({ kind: "pan-y" });
  });

  it("calls an expansion a push in and a contraction a pull out, with the sign of the zoom rate", () => {
    const inward = read({ zoom: 0.2 });
    expect(inward.kind).toBe("zoom-in");
    expect(inward.zoom).toBeCloseTo(0.2, 1);
    const outward = read({ zoom: -0.2 });
    expect(outward.kind).toBe("zoom-out");
    expect(outward.zoom).toBeCloseTo(-0.2, 1);
  });

  it("calls a rotation a rotation, with the sign of the roll", () => {
    const clockwise = read({ roll: 0.3 });
    expect(clockwise.kind).toBe("rotate");
    expect(clockwise.rotate).toBeCloseTo(0.3, 1);
    expect(read({ roll: -0.3 }).rotate).toBeCloseTo(-0.3, 1);
  });

  it("reads slow footage (0.05 to 0.2 frame widths a second) as moving, not still", () => {
    const cases: [string, Flow, MotionKind][] = [];
    for (const speed of [0.05, 0.1, 0.2]) {
      cases.push([`pan-x ${speed}`, { tx: speed }, "pan-x"], [`pan-x ${speed} left`, { tx: -speed }, "pan-x"], [`pan-y ${speed}`, { ty: speed }, "pan-y"]);
      // The edge of the frame moves at zoom × 0.5 frame widths a second; the same edge speed is zoom = 2 × speed.
      cases.push([`push in ${speed}`, { zoom: 2 * speed }, "zoom-in"], [`pull out ${speed}`, { zoom: -2 * speed }, "zoom-out"], [`roll ${speed}`, { roll: 2 * speed }, "rotate"]);
    }
    for (const [label, flow, kind] of cases) expect(read(flow, { noise: 2 }), label).toMatchObject({ kind });
  });

  it("gets the rate of a slow drift right, where whole-pixel block matching sees nothing", () => {
    // 0.05 frame widths a second over 0.46 s is 0.023 widths: 2.2 px at 96 px wide, 1.1 px at 48.
    const m = read({ tx: 0.05 }, { noise: 2 });
    expect(m.kind).toBe("pan-x");
    expect(m.tx).toBeGreaterThan(0.04);
    expect(m.tx).toBeLessThan(0.06);
  });

  it("reads a still shot as still, with noise, and a wobble under the threshold", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) expect(read({}, { noise: 3, seed })).toMatchObject({ kind: "still" });
    // 0.006 frame widths a second is under a third of the threshold.
    expect(read({ tx: 0.006, ty: -0.004 }, { noise: 2 })).toMatchObject({ kind: "still" });
    expect(STILL_FW_PER_S).toBeGreaterThan(0.01);
    expect(STILL_FW_PER_S).toBeLessThanOrEqual(0.025);
  });

  it("follows a fast pan across a long window (the steps between neighbours start the long estimate)", () => {
    const m = read({ tx: -0.9 }, { times: [0, 120, 240, 360, 480], noise: 1 });
    expect(m.kind).toBe("pan-x");
    expect(m.tx).toBeCloseTo(-0.9, 1);
  });

  it("finds where a dolly expands from, and only for a zoom", () => {
    // The vanishing point is a sixth of a frame width left of centre and a little above it.
    const focus: [number, number] = [-1 / 6, -0.1];
    const m = read({ zoom: 0.3, focus });
    expect(m.kind).toBe("zoom-in");
    expect(m.focus).not.toBeNull();
    expect(m.focus!.x).toBeCloseTo(0.5 + focus[0], 1);
    expect(m.focus!.y).toBeCloseTo(0.5 + (focus[1] * W) / H, 1);
    expect(read({ tx: 0.2 }).focus).toBeNull();
    expect(read({}, { noise: 2 }).focus).toBeNull();
  });

  it("is a zoom, not a pan, when the vanishing point is off centre (the whole picture slides a little as well)", () => {
    expect(read({ zoom: 0.25, focus: [-0.3, 0] })).toMatchObject({ kind: "zoom-in" });
    expect(read({ zoom: -0.25, focus: [0.25, 0.1] })).toMatchObject({ kind: "zoom-out" });
  });

  it("is a pan when it slides far more than it expands", () => {
    expect(read({ tx: 0.4, zoom: 0.1 })).toMatchObject({ kind: "pan-x" });
  });

  it("is not thrown by a person walking through the shot (the camera is what is measured)", () => {
    const base = frames({ zoom: 0.25 }, WINDOW, { noise: 1 });
    // A bright block crossing the middle of the frame, 18 px between samples.
    const withPerson = base.map((frame, i) => {
      const data = new Float32Array(frame.gray.data);
      for (let y = 60; y < 120; y++) for (let x = 20 + i * 18; x < 44 + i * 18; x++) data[y * W + x] = 240;
      return { ...frame, gray: { ...frame.gray, data } };
    });
    expect(readMotion(withPerson)).toMatchObject({ kind: "zoom-in" });
  });

  it("returns null for too few frames, mismatched sizes or a window too short to measure", () => {
    expect(readMotion(frames({ tx: 0.2 }, [0]))).toBeNull();
    expect(readMotion(frames({ tx: 0.2 }, [0, 20]))).toBeNull();
    const mixed = [...frames({ tx: 0.2 }, [0]), { t: 400, gray: { data: new Float32Array(48 * 85), width: 48, height: 85 } }];
    expect(readMotion(mixed)).toBeNull();
  });

  it("reports no confidence, and reads as still, for a picture with no detail", () => {
    const flat = (t: number) => ({ t, gray: { data: new Float32Array(W * H).fill(120), width: W, height: H } as Gray });
    expect(readMotion([flat(0), flat(250), flat(500)])).toMatchObject({ kind: "still", confidence: 0 });
  });

  it("classifies from rates directly: the dominant edge speed wins, a zoom is favoured over a slide it explains, stillness below the threshold", () => {
    expect(classify({ tx: 0.1, ty: 0, zoom: 0, rotate: 0 }).kind).toBe("pan-x");
    expect(classify({ tx: 0, ty: 0.05, zoom: 0.05, rotate: 0 }).kind).toBe("pan-y");
    expect(classify({ tx: 0.02, ty: 0, zoom: 0.1, rotate: 0 }).kind).toBe("zoom-in");
    expect(classify({ tx: 0, ty: 0, zoom: 0, rotate: 0.2 }).kind).toBe("rotate");
    expect(classify({ tx: 0.01, ty: 0.01, zoom: 0.01, rotate: 0.01 }).kind).toBe("still");
    // A zoom of rate k puts the edge at k/2: just over the threshold is moving, just under is still.
    expect(classify({ tx: 0, ty: 0, zoom: 2 * STILL_FW_PER_S * 1.05, rotate: 0 }).kind).toBe("zoom-in");
    expect(classify({ tx: 0, ty: 0, zoom: 2 * STILL_FW_PER_S * 0.95, rotate: 0 }).kind).toBe("still");
  });

  it("names each kind in plain words and keeps only a zoom's focus on a side", () => {
    expect(describeMotionKind("zoom-in")).toBe("forward move");
    expect(describeMotionKind("zoom-out")).toBe("backward move");
    expect(describeMotionKind("pan-x")).toBe("sideways pan");
    expect(describeMotionKind("still")).toBe("no clear movement");
    expect(sideReadOf(classify({ tx: 0, ty: 0, zoom: 0.3, rotate: 0 }))).toEqual({ kind: "zoom-in", focus: { x: 0.5, y: 0.5 } });
    expect(sideReadOf(classify({ tx: 0.3, ty: 0, zoom: 0, rotate: 0 }))).toEqual({ kind: "pan-x" });
  });
});
