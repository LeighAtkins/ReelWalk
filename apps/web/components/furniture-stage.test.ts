import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_FURNITURE_STAGE, furnitureConceptInput, furnitureRegion } from "./furniture-stage";
import { FurnitureStagePanel } from "./furniture-stage-panel";
import { keyframeInputKey, keyframeMatches } from "./shot-keyframe-panel";

describe("bounded furniture concept workflow", () => {
  it("freezes one concept edit without guided continuation or a second frame", () => {
    const input = furnitureConceptInput("original-photo", DEFAULT_FURNITURE_STAGE);
    expect(input).toEqual({ role: "end", source: { assetId: "original-photo", atMs: 0 }, move: "push-in", distanceM: .5, durationSeconds: 4, furnitureStage: DEFAULT_FURNITURE_STAGE });
    expect(input).not.toHaveProperty("guidedPair"); expect(input).not.toHaveProperty("continuity");
  });
  it("draws rectangles in either direction and clamps to the complete cropped source", () => {
    expect(furnitureRegion({ x: .9, y: .8 }, { x: .2, y: .1 })).toEqual({ x: .2, y: .1, width: .7, height: .7000000000000001 });
    expect(furnitureRegion({ x: -1, y: -1 }, { x: 2, y: 2 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(furnitureRegion({ x: .5, y: .5 }, { x: .501, y: .6 })).toBeNull();
  });
  it("binds concept approval and recovery to original source, area, style and preferences", () => {
    const input = furnitureConceptInput("original", DEFAULT_FURNITURE_STAGE);
    for (const changed of [furnitureConceptInput("other", DEFAULT_FURNITURE_STAGE), furnitureConceptInput("original", { ...DEFAULT_FURNITURE_STAGE, style: "classic-luxury" }), furnitureConceptInput("original", { ...DEFAULT_FURNITURE_STAGE, instructions: "Blue sofa" }), furnitureConceptInput("original", { ...DEFAULT_FURNITURE_STAGE, region: { x: .2, y: .2, width: .5, height: .5 } })]) {
      expect(keyframeMatches({ input }, changed)).toBe(false); expect(keyframeInputKey(changed)).not.toBe(keyframeInputKey(input));
    }
  });
  it("shows source, crop/architecture disclosure, style, preferences and keyboard area controls before generation", () => {
    const html = renderToStaticMarkup(createElement(FurnitureStagePanel, { photos: [], source: "", stage: DEFAULT_FURNITURE_STAGE, disabled: false, recoveryKey: "shot-one", onSource() {}, onChange() {}, onUse() {}, onOriginal() {}, onAssets() {}, onBalance() {}, onBlocked() {} }));
    expect(html).toContain("Original photo"); expect(html).toContain("same centred 9:16 crop"); expect(html).toContain("Furniture preferences");
    expect(html).toContain("AI furniture concept"); expect(html).toContain("Generate furniture concept"); expect(html).not.toContain("Generate End image");
    expect(html.match(/type="range"/g)).toHaveLength(4); expect(html).toContain("1 credit");
  });
});
