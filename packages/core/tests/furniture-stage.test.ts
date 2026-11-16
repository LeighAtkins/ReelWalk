import { expect, it } from "vitest";
import { furnitureStagePixels, furnitureStagePrompt, furnitureStageSchema } from "../src/furniture-stage";
import { cameraKeyframePrompt, cameraKeyframeVideoPrompt, guidedKeyframeError } from "../src/camera-keyframe";

const stage = furnitureStageSchema.parse({ version: 1, style: "warm-minimal", region: { x: .25, y: .5, width: .5, height: .25 } });
const input = { role: "end" as const, source: { assetId: "source", atMs: 0 as const }, move: "push-in" as const, distanceM: .5, durationSeconds: 4 as const, furnitureStage: stage };
it("bounds the entire edited area and maps it to portrait pixels", () => {
  expect(furnitureStagePixels(stage, 1080, 1920)).toEqual({ left: 270, top: 960, width: 540, height: 480 });
  expect(furnitureStageSchema.safeParse({ ...stage, region: { ...stage.region, width: 1 } }).success).toBe(false);
  expect(furnitureStageSchema.safeParse({ ...stage, region: { ...stage.region, x: NaN } }).success).toBe(false);
});
it("has a furniture-specific prompt without conflicting camera or furniture-preservation instructions", () => {
  const prompt = cameraKeyframePrompt(input);
  expect(prompt).toBe(furnitureStagePrompt(stage));
  expect(prompt).toContain("SAME camera position");
  expect(prompt).toContain("movable furniture");
  expect(prompt).toContain("Retain every fixed architectural element");
  expect(prompt).not.toContain("Camera intent:");
});
it("never admits a hidden second image for a furniture concept", () => {
  expect(guidedKeyframeError(input, "request")).toBeNull();
  expect(guidedKeyframeError({ ...input, role: "start" }, "request")).toMatch(/one image request/);
  expect(guidedKeyframeError({ ...input, continuity: input.source }, "request")).toMatch(/one image request/);
});
it("Start-only cinematography does not tell Veo to land on a nonexistent End", () => {
  const text = cameraKeyframeVideoPrompt({ ...input, furnitureStage: undefined, cinematography: { version: 1, lensMm: "source", whiteBalanceKelvin: "source" } }, false);
  expect(text).toContain("Start frame's");
  expect(text).not.toContain("End frame");
});
