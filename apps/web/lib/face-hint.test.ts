import { describe, expect, it } from "vitest";
import { faceHintFromChecks } from "./face-hint";

// ADR 0089 round 3: the gate's refined box wins over its first box, and the worker's face track comes with it.
describe("faceHintFromChecks", () => {
  it("prefers the refined box and reads a valid face track", () => {
    const hint = faceHintFromChecks([
      { end: "first", locate: [{ mode: "grid", box: [287, 380, 487, 620], refined: [506, 418, 622, 622] }] },
      { end: "track", fps: 10, samples: [{ ms: 0, x0: 0.42, y0: 0.5, x1: 0.62, y1: 0.62 }, { ms: 100, x0: 0.43, y0: 0.5, x1: 0.63, y1: 0.62 }] },
    ])!;
    expect(hint.box).toEqual({ x0: 0.418, y0: 0.506, x1: 0.622, y1: 0.622 });
    expect(hint.track).toHaveLength(2);
  });

  it("keeps the first box when there is no refined one, and drops a broken track", () => {
    const hint = faceHintFromChecks([
      { end: "first", locate: [{ mode: "grid", box: [287, 380, 487, 620] }] },
      { end: "track", samples: [{ ms: 100, x0: 0.4, y0: 0.5, x1: 0.6, y1: 0.6 }, { ms: 0, x0: 0.4, y0: 0.5, x1: 0.6, y1: 0.6 }] },
    ])!;
    expect(hint.box!.y0).toBeCloseTo(0.287, 6);
    expect(hint.track).toBeUndefined();
  });
});
