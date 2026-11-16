import { describe, expect, it } from "vitest";
import { shotBuilderDraftSchema, shotBuilderRecoveryKey } from "./shot-builder-draft";

const draft = { version: 1, photo: "asset:original", last: "asset:generated-end", startBase: "asset:original", endBase: "asset:second-photo", firstMs: 0, lastMs: 0,
  generatedStart: false, generatedEnd: true, useEndReference: true, direction: "shift-right", distanceM: 3, chosenSeconds: 4, frameNotes: "Keep oak furniture", prompt: "Move right",
  mode: "custom", move: "", quality: "final", style: "source", atmosphere: "auto", energy: "subtle", harmonize: false, polish: false, draft: false };
describe("shot choice recovery", () => {
  it("preserves distinct endpoint photos and the choices needed to regenerate an End", () => {
    expect(shotBuilderDraftSchema.parse(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    expect(shotBuilderRecoveryKey("reel-a", "shot-a")).not.toBe(shotBuilderRecoveryKey("reel-a", "shot-b"));
    expect(shotBuilderRecoveryKey("reel-a")).not.toBe(shotBuilderRecoveryKey("reel-b"));
    expect(JSON.stringify(shotBuilderDraftSchema.parse(draft))).toBe(JSON.stringify(draft));
  });
  it("does not restore URLs, invented approvals or unsupported camera inputs", () => {
    for (const invalid of [{ ...draft, photo: "https://foreign.example/image.jpg" }, { ...draft, approved: true }, { ...draft, chosenSeconds: 30 }, { ...draft, distanceM: 300 }, { ...draft, firstMs: -1 }]) {
      expect(shotBuilderDraftSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("retains extended approximate camera distances rather than clamping them back to ten", () => {
    expect(shotBuilderDraftSchema.parse({ ...draft, distanceM: 30.5 }).distanceM).toBe(30.5);
    expect(shotBuilderDraftSchema.parse({ ...draft, distanceM: 100 }).distanceM).toBe(100);
    expect(shotBuilderDraftSchema.safeParse({ ...draft, distanceM: 100.1 }).success).toBe(false);
  });
});

it("round trips bounded camera sketch and Start-only review without changing legacy draft bytes", () => {
  const choices = { ...draft, startOnly: true, reviewedStart: "exact-visible-choice", cameraSketch: { start: { x: -20, y: 20 }, end: { x: 20, y: 20 } } };
  expect(shotBuilderDraftSchema.parse(JSON.parse(JSON.stringify(choices)))).toEqual(choices);
  expect(shotBuilderDraftSchema.safeParse({ ...choices, cameraSketch: { start: { x: 51, y: 0 }, end: { x: 0, y: 0 } } }).success).toBe(false);
});

it("persists furniture source, bounded edit recipe and accepted concept provenance independently of camera movement", () => {
  const furnitureStage = { version: 1, style: "warm-minimal", region: { x: .1, y: .4, width: .8, height: .5 }, instructions: "Cream sofa" };
  const choices = { ...draft, furnitureSource: "asset:original", furnitureStage, furnitureSelection: { sourceAssetId: "original", assetId: "concept", inputKey: "exact-frozen-recipe" } };
  expect(shotBuilderDraftSchema.parse(JSON.parse(JSON.stringify(choices)))).toEqual(choices);
  expect(shotBuilderDraftSchema.safeParse({ ...choices, furnitureStage: { ...furnitureStage, region: { x: .9, y: 0, width: .3, height: 1 } } }).success).toBe(false);
});
