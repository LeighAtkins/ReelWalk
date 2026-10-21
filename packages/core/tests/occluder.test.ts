import { describe, expect, it } from "vitest";
import { clipSourceSeconds, parseTimeline, tapReference, tapSourceMs } from "../src";

const quad = [0.2, 0.2, 0.6, 0.2, 0.6, 0.5, 0.2, 0.5];
const shifted = quad.map((v, i) => (i % 2 === 0 ? v + 0.1 : v));

function timeline(occluders: { x: number; y: number; atMs?: number }[]) {
  return parseTimeline({
    version: 1,
    clips: [{ id: "c1", assetId: "room", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 3000, transitionIn: "cut" }],
    texts: [{ id: "t1", text: "VIEW", startMs: 0, endMs: 2000, occluders,
      pin: { assetId: "room", fromMs: 1000, toMs: 3000, quad }, path: [{ t: 0, x: 0, y: 0, q: quad }, { t: 1, x: 0.1, y: 0, q: shifted }] }],
    music: null,
  });
}

describe("tap reference frames (ADR 0051)", () => {
  it("keeps a tap's time through the schema and still accepts taps without one", () => {
    const parsed = timeline([{ x: 0.4, y: 0.3, atMs: 2000 }, { x: 0.3, y: 0.3 }]);
    expect(parsed.texts[0].occluders).toEqual([{ x: 0.4, y: 0.3, atMs: 2000 }, { x: 0.3, y: 0.3 }]);
  });

  it("reads the pinned source time on screen, and gives the tap back where the finger was", () => {
    const t = timeline([{ x: 0.4, y: 0.3, atMs: 2000 }, { x: 0.3, y: 0.3 }]);
    const text = t.texts[0];
    expect(tapSourceMs(t, text, 1000)).toBe(2000);
    expect(tapSourceMs(t, { ...text, pin: undefined }, 1000)).toBeNull();
    // Halfway through the pin the wall has moved 0.05 right: the stored point is carried there.
    const ref = tapReference(text, text.occluders![0])!;
    expect(ref.sourceMs).toBe(2000);
    expect(ref.x).toBeCloseTo(0.45, 6);
    expect(ref.y).toBeCloseTo(0.3, 6);
    // An older tap has no reference: nothing is invented for it.
    expect(tapReference(text, text.occluders![1])).toBeNull();
  });

  it("names the exact source time of the frame on screen, never the frame before (review of PR #190)", () => {
    const t = timeline([]);
    const text = t.texts[0];
    // Reel frame 31 shows source 1000 + 31/30 s = 2033.33 ms; rounding to 2033 named frame 30's picture.
    const at = tapSourceMs(t, text, 1033.4)!;
    expect(at).toBe(clipSourceSeconds(t.clips[0], 31) * 1000);
    expect(at).toBeGreaterThan(2033.33);
    expect(at / 1000).toBeCloseTo(clipSourceSeconds(t.clips[0], 31), 12);
  });

  it("keeps tap times inside the pin's window, so a seek never asks past the file", () => {
    const t = timeline([{ x: 0.4, y: 0.3, atMs: 5000 }, { x: 0.4, y: 0.3, atMs: 10 }]);
    const text = { ...t.texts[0], pin: { ...t.texts[0].pin!, toMs: 2900 } };
    expect(tapSourceMs(t, text, 1966)).toBe(2900);
    expect(tapReference(text, text.occluders![0])!.sourceMs).toBe(2900);
    expect(tapReference(text, text.occluders![1])!.sourceMs).toBe(1000);
  });
});
