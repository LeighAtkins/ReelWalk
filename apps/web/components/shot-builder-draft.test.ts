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
  });
  it("does not restore URLs, invented approvals or unsupported camera inputs", () => {
    for (const invalid of [{ ...draft, photo: "https://foreign.example/image.jpg" }, { ...draft, approved: true }, { ...draft, chosenSeconds: 30 }, { ...draft, distanceM: 300 }, { ...draft, firstMs: -1 }]) {
      expect(shotBuilderDraftSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
