import { describe, expect, it } from "vitest";
import { bestShift, describeMotion, motionFlags, motionProfile, pickMatchingFrame, type Gray } from "../src";

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

  it("picks the frame that best matches the next shot's first frame", () => {
    const candidates = [frame(0, 0), frame(0, 4), frame(0, 8), frame(0, 12)].map((gray, i) => ({ t: 3000 + i * 42, gray }));
    const match = pickMatchingFrame(candidates, frame(0, 9));
    expect(match).toMatchObject({ t: 3084, close: true });
    expect(pickMatchingFrame(candidates, frame(0, 9, 2))?.close).toBe(false);
  });
});
