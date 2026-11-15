import { expect, it } from "vitest";
import { cameraKeyframeGenerateSchema, cameraKeyframePrompt, cameraKeyframeVideoPrompt, guidedKeyframeError, guidedPairEndInput } from "../src/camera-keyframe";
const legacy = { role: "end" as const, source: { assetId: "original", atMs: 0 as const }, move: "shift-right" as const, distanceM: 3, durationSeconds: 4 as const };
const startId = "4ec2359d-c4af-490b-b5ec-36a88f499605", endId = "8238259d-c4af-490b-b5ec-36a88f499605";
const cinematic = { version: 1 as const, lensMm: "source" as const, whiteBalanceKelvin: "source" as const };
it("preserves exact legacy parsed shape and prompt bytes", () => {
  const request = { action: "generate", requestId: startId, ...legacy };
  expect(cameraKeyframeGenerateSchema.parse(request)).toEqual(request);
  expect(cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).strip().parse(request)).toEqual(legacy);
  expect(cameraKeyframePrompt(legacy)).toBe("Create one photorealistic portrait 9:16 architectural video keyframe from image 1, the source view. This is the ending view after the planned camera move below. Camera intent: translate to the camera's right, keeping a level lens and the property in view, approximately 3 metres over 4 seconds. These are approximate creative directions, not surveyed or reconstructed geometry. Keep the source property's architecture, materials, furniture and landscaping consistent. Preserve the source lighting unless the user's additional instruction explicitly requests a time-of-day or lighting change. Preserve tile grids, rooflines, openings, proportions and visible objects. Natural photographic finish; no extra edge enhancement. Do not add buildings or invented landmarks. Reveal only plausible immediate surroundings. No text, people, logos or watermarks.");
  expect(cameraKeyframeVideoPrompt(legacy)).toBe("One continuous smooth camera move from the supplied Start frame to the supplied End frame: translate to the camera's right, keeping a level lens and the property in view, approximately 3 metres over 4 seconds. Distance is approximate creative intent, not surveyed geometry. Preserve the source property's architecture, proportions, materials and objects. Preserve lighting unless explicitly requested otherwise below. Natural photographic finish; no extra edge enhancement. No morphing, teleporting, cuts or invented buildings.");
});
it("limits guided metadata to one Start and a distinct fixed End request", () => {
  const input = { ...legacy, role: "start" as const, cinematography: cinematic, guidedPair: { version: 1 as const, id: startId, endRequestId: endId } };
  expect(guidedKeyframeError(input, startId)).toBeNull();
  expect(guidedKeyframeError({ ...input, role: "end" }, startId)).toContain("begin with a Start");
  expect(guidedKeyframeError({ ...input, guidedPair: { ...input.guidedPair, endRequestId: startId } }, startId)).toContain("distinct");
  expect(guidedKeyframeError({ ...input, cinematography: undefined }, startId)).toContain("recipe");
  const end = guidedPairEndInput(cameraKeyframeGenerateSchema.parse({ action: "generate", requestId: startId, ...input }), "retained-start");
  expect(end).toEqual({ ...legacy, continuity: { assetId: "retained-start", atMs: 0 }, cinematography: cinematic });
  expect(end).not.toHaveProperty("requestId"); expect(end).not.toHaveProperty("guidedPair");
  expect(cameraKeyframePrompt(end)).toContain("Image 2 is the prepared Start");
  expect(cameraKeyframePrompt(end)).not.toContain("accepted Start");
});
