import { describe, expect, it } from "vitest";
import { STUB_REEL } from "../src/constants";

describe("StubReel composition constants", () => {
  it("targets vertical 9:16 social video", () => {
    expect(STUB_REEL.width).toBe(1080);
    expect(STUB_REEL.height).toBe(1920);
    expect(STUB_REEL.durationInFrames / STUB_REEL.fps).toBe(5);
  });
});
