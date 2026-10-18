import { describe, expect, it } from "vitest";
import { clipSchema, clipSourceAvailability } from "../src";

const clip = clipSchema.parse({ id: "clip", assetId: "asset", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3400 });
describe("source trim capacity", () => {
  it("distinguishes a 3.4-second edit from its full eight-second source", () => {
    expect(clipSourceAvailability(clip, 8000)).toEqual({ usedMs: 3400, sourceMs: 8000, beforeMs: 0, afterMs: 4600, fullLengthMs: 8000 });
  });
  it("reports both handles and maximum reel time at the actual playback speed", () => {
    expect(clipSourceAvailability({ ...clip, sourceStartMs: 2000, sourceEndMs: 6000, speed: 2 }, 8000)).toEqual({ usedMs: 2000, sourceMs: 8000, beforeMs: 1000, afterMs: 1000, fullLengthMs: 4000 });
  });
  it.each([null, undefined, NaN, 0, 2000])("does not invent remaining footage from missing or inconsistent metadata: %s", length => {
    expect(clipSourceAvailability(clip, length)).toMatchObject({ sourceMs: null, afterMs: null, fullLengthMs: null });
  });
});
