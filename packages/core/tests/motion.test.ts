import { describe, expect, it } from "vitest";
import { bestShift, describeMotion, homography, matrix3d, motionFlags, motionProfile, pickMatchingFrame, smoothKeyframes, trackPatch, type Gray, type Quad } from "../src";

/** A textured frame (a fixed noise pattern, like a wall or floor) shifted by (sx, sy); another `seed` is a different picture. */
function frame(sx: number, sy: number, seed = 1, width = 24, height = 40): Gray {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const n = Math.sin((x - sx) * 12.9898 + (y - sy) * 78.233 + seed * 37.719) * 43758.5453;
    data[y * width + x] = (n - Math.floor(n)) * 255;
  }
  return { data, width, height };
}

describe("measured motion", () => {
  it("finds the shift between two frames", () => {
    const shift = bestShift(frame(0, 0), frame(2, 5));
    expect(shift).toMatchObject({ dx: 2, dy: 5 });
    expect(shift.change).toBeLessThan(0.005);
  });

  it("flags a vertical reversal and an abrupt frame change", () => {
    const frames = [frame(0, 0), frame(0, 5), frame(0, 10), frame(0, 5), frame(0, 0)].map((gray, i) => ({ t: i * 250, gray }));
    const samples = motionProfile(frames);
    expect(samples.map((s) => s.dy)).toEqual([5, 5, -5, -5]);
    expect(motionFlags(samples)).toEqual([{ atMs: 500, what: "vertical reversal" }]);
    const cut = motionProfile([{ t: 0, gray: frame(0, 0) }, { t: 250, gray: frame(0, 0, 2) }]);
    expect(motionFlags(cut)).toEqual([{ atMs: 250, what: "frame change" }]);
    expect(describeMotion(samples)).toContain("vertical reversal at 0.50 s");
  });

  it("ignores jitter under the deadband", () => {
    const frames = [frame(0, 0), frame(0, 1), frame(0, 0), frame(0, 1)].map((gray, i) => ({ t: i * 250, gray }));
    expect(motionFlags(motionProfile(frames))).toEqual([]);
  });

  it("follows a patch between frames and says when it is lost", () => {
    const followed = trackPatch(frame(0, 0, 1, 48, 80), frame(3, -4, 1, 48, 80), 20, 40, { radius: 6, range: 8 });
    expect(followed.x).toBeCloseTo(23, 0); expect(followed.y).toBeCloseTo(36, 0); expect(followed.lost).toBe(false);
    // A fractional start keeps its fraction: the displacement is what is measured.
    expect(trackPatch(frame(0, 0, 1, 48, 80), frame(3, -4, 1, 48, 80), 20.3, 40.3, { radius: 6, range: 8 }).x).toBeCloseTo(23.3, 0);
    expect(trackPatch(frame(0, 0, 1, 48, 80), frame(0, 0, 2, 48, 80), 20, 40, { radius: 6, range: 8 }).lost).toBe(true);
  });

  it("smooths tracker jitter without lagging the motion", () => {
    const ramp = Array.from({ length: 11 }, (_, i) => ({ t: i / 10, x: i * 0.02 + (i % 2 ? 0.004 : -0.004), y: 0 }));
    const smooth = smoothKeyframes(ramp);
    const jitter = (pts: { x: number }[]) => pts.slice(1, -1).reduce((sum, p, i) => sum + Math.abs(p.x - (pts[i].x + pts[i + 2].x) / 2), 0);
    expect(jitter(smooth)).toBeLessThan(jitter(ramp) / 3);
    expect(smooth[10].x).toBeCloseTo(ramp[10].x, 2);
    expect(smooth[5].x).toBeCloseTo(0.1, 2);
  });

  it("solves the homography that takes one quad to another, including perspective", () => {
    const apply = (h: number[], x: number, y: number) => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
    const src: Quad = [0, 0, 100, 0, 100, 40, 0, 40];
    const dst: Quad = [10, 20, 95, 12, 98, 60, 6, 48];
    const h = homography(src, dst)!;
    for (let i = 0; i < 4; i++) { const [u, v] = apply(h, src[i * 2], src[i * 2 + 1]); expect(u).toBeCloseTo(dst[i * 2], 6); expect(v).toBeCloseTo(dst[i * 2 + 1], 6); }
    expect(homography(src, src)!.map(v => Number(v.toFixed(6)))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(homography(src, [0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(matrix3d([1, 0, 5, 0, 1, 7, 0, 0, 1])).toBe("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 7, 0, 1)");
  });

  it("picks the frame that best matches the next shot's first frame", () => {
    const candidates = [frame(0, 0), frame(0, 4), frame(0, 8), frame(0, 12)].map((gray, i) => ({ t: 3000 + i * 42, gray }));
    const match = pickMatchingFrame(candidates, frame(0, 9));
    expect(match).toMatchObject({ t: 3084, close: true });
    expect(pickMatchingFrame(candidates, frame(0, 9, 2))?.close).toBe(false);
  });
});
