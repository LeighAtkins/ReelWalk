import { describe, expect, it } from "vitest";
import { boxFromCrop, refineCropRect } from "../src/identity";
import { seedBoxFromChecks } from "../src/take-face";

// ADR 0089 round 3: the gate's box looked for again in a square cut, and the seed the face track starts from.

describe("the gate's second look at the face", () => {
  // The round-2 pier take: the stored box [287, 380, 487, 620] sat in the sky above her head; her face was at y 0.51–0.62.
  const first = [287, 380, 487, 620];

  it("cuts a square three times the first box, centred on it, wide enough to hold the real face", () => {
    const rect = refineCropRect(first, 1080, 1920);
    expect(rect.size).toBe(1080);
    expect(rect.y).toBeLessThan(0.506 * 1920);
    expect(rect.y + rect.size).toBeGreaterThan(0.622 * 1920);
    expect(rect.x).toBe(0);
  });

  it("reads a box found in the square back onto the composite's grid", () => {
    const rect = { x: 0, y: 203, size: 1080 };
    // A face found at y 712–910 and x 418–622 of the square's grid.
    const box = boxFromCrop([712, 418, 910, 622], rect, 1080, 1920);
    expect(box[0]).toBeCloseTo(((203 + 0.712 * 1080) / 1920) * 1000, 0);
    expect(box[1]).toBeCloseTo(418, 0);
    expect(box[2]).toBeCloseTo(((203 + 0.91 * 1080) / 1920) * 1000, 0);
  });

  it("keeps a small face's square inside the image", () => {
    const rect = refineCropRect([10, 900, 60, 990], 1080, 1920);
    expect(rect.x + rect.size).toBeLessThanOrEqual(1080);
    expect(rect.y).toBeGreaterThanOrEqual(0);
  });
});

describe("seedBoxFromChecks", () => {
  it("starts from the refined box of the newest first-frame check, else its box, skipping rejected attempts", () => {
    const checks = [
      { end: "first", locate: [{ mode: "grid", box: [100, 100, 200, 200] }] },
      { end: "first", locate: [{ mode: "grid", box: [250, 440, 340, 560], rejected: "face-not-in-crop" }, { mode: "grid", box: [367, 400, 600, 600], refined: [400, 430, 520, 570] }] },
    ];
    expect(seedBoxFromChecks(checks)).toEqual([400, 430, 520, 570]);
    expect(seedBoxFromChecks([{ end: "first", locate: [{ mode: "grid", box: [367, 400, 600, 600] }] }])).toEqual([367, 400, 600, 600]);
    expect(seedBoxFromChecks([{ end: "last", locate: [{ mode: "grid", box: [367, 400, 600, 600] }] }])).toBeNull();
    expect(seedBoxFromChecks(null)).toBeNull();
  });
});
