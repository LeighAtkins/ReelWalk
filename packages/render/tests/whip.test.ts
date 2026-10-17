import { describe, expect, it } from "vitest";
import { whipGeometry } from "../src/reel/whip";

describe("camera-matched whip", () => {
  it("moves departing pixels opposite the camera and arrives from the same continuous direction", () => {
    for (const [direction, axis, sign] of [["right", "x", -1], ["left", "x", 1], ["up", "y", 1], ["down", "y", -1]] as const) {
      expect(Math.sign(whipGeometry(-1, direction)[axis])).toBe(sign);
      expect(Math.sign(whipGeometry(1, direction)[axis])).toBe(-sign);
    }
  });
  it("blurs only along the selected camera axis and returns to an untransformed image", () => {
    expect(whipGeometry(1, "up")).toMatchObject({ x: 0, blurX: 0, blurY: 28, scaleX: 1 });
    expect(whipGeometry(0, "left")).toMatchObject({ x: 0, y: 0, blurX: 0, blurY: 0, scaleX: 1, scaleY: 1 });
    expect(whipGeometry(-1)).toEqual(whipGeometry(-1, "right"));
  });
});
