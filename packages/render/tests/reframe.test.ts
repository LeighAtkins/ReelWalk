import { describe, expect, it } from "vitest";
import { clipMomentAtSource, clipPicture, emptyTimeline, parseTimeline, sourceToComposition, type Clip } from "@reelwalk/core";
import { clipPresentation } from "../src/reel/presentation";

/**
 * The reframe (ADR 0086) in the shared composition: the picture slides so the 9:16 crop follows the subject, outermost
 * of the clip's transforms, and the editor's frame service maps points through the same slide.
 */
describe("reframe in the composition", () => {
  const base = { id: "c", assetId: "a", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 4000 } as const;
  const clip = (extra: Partial<Clip> = {}): Clip => parseTimeline({ ...emptyTimeline(), clips: [{ ...base, ...extra }] }).clips[0];
  const reframe = { aspect: 16 / 9, keys: [{ t: 0, x: 0.3 }, { t: 10000, x: 0.3 }] };

  it("draws a saved clip without a reframe exactly as before", () => {
    expect(clipPresentation(clip(), 0, 30, 90).transform).toBeUndefined();
    expect(clipPresentation(clip({ zoom: 1.2 }), 0, 30, 90).transform).toBe("scale(1.2) translateX(0%)");
  });
  it("slides the picture so the crop centre is mid-frame, outside the zoom", () => {
    const transform = clipPresentation(clip({ reframe, zoom: 1.2 }), 10, 30, 90).transform!;
    expect(transform.startsWith("translateX(")).toBe(true);
    expect(transform).toContain("scale(1.2)");
    const shift = parseFloat(/translateX\(([-\d.]+)%\)/.exec(transform)![1]);
    expect(shift).toBeCloseTo((0.5 - 0.3) * ((16 / 9) / (9 / 16)) * 100, 1);
    // The frame service puts the crop centre in the middle of the reel too.
    const c = clip({ reframe });
    const picture = clipPicture(c, { width: 1920, height: 1080 }, clipMomentAtSource(c, 2000));
    expect(sourceToComposition(picture, 0.3 * 1920, 540)[0]).toBeCloseTo(0.5, 3);
  });
  it("leaves a contain-fitted clip alone", () => {
    expect(clipPresentation(clip({ reframe, fit: "contain" }), 10, 30, 90).transform).toBeUndefined();
  });
});
