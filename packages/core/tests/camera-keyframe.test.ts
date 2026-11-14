import { describe, expect, it } from "vitest";
import { CAMERA_KEYFRAME_MODEL, cameraKeyframeGenerateSchema, cameraKeyframePrompt, cameraKeyframeVideoPrompt } from "../src/camera-keyframe";

const request = { action: "generate", requestId: "4ec2359d-c4af-490b-b5ec-36a88f499605", role: "end", source: { assetId: "alternate-photo", atMs: 0 }, continuity: { assetId: "chosen-start", atMs: 0 }, move: "shift-right", distanceM: 3, durationSeconds: 4 };
describe("camera keyframe contract", () => {
  it("accepts distinct owned photo IDs and fixes the selected Pro model", () => {
    expect(cameraKeyframeGenerateSchema.parse(request)).toEqual(request);
    expect(CAMERA_KEYFRAME_MODEL).toBe("gemini-3-pro-image");
    expect(cameraKeyframeGenerateSchema.safeParse({ ...request, source: { assetId: "x", atMs: 1000 } }).success).toBe(false);
    expect(cameraKeyframeGenerateSchema.safeParse({ ...request, url: "https://untrusted.test/image.jpg" }).success).toBe(false);
    expect(cameraKeyframeGenerateSchema.safeParse({ ...request, model: "another-model" }).success).toBe(false);
  });
  it("bounds distance and duration and refuses unrecognised movement", () => {
    for (const patch of [{ distanceM: 0 }, { distanceM: 100 }, { durationSeconds: 6 }, { move: "teleport" }]) expect(cameraKeyframeGenerateSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  });
  it("uses the same approximate rightward intent for image and video", () => {
    const input = cameraKeyframeGenerateSchema.parse(request);
    for (const prompt of [cameraKeyframePrompt(input), cameraKeyframeVideoPrompt(input)]) {
      expect(prompt).toContain("camera's right"); expect(prompt).toContain("approximately 3 metres over 4 seconds");
      expect(prompt).toContain("not surveyed"); expect(prompt).toContain("no extra edge enhancement");
    }
    expect(cameraKeyframePrompt(input)).toContain("Image 2 is the accepted Start and the origin of the camera move");
    expect(cameraKeyframePrompt(input)).toContain("do not apply a second camera move to Image 1");
    expect(cameraKeyframePrompt({ ...input, role: "start" })).toContain("retain the source camera position");
  });
  it("does not refer to an End frame when the user chooses Start-only video", () => {
    const input = cameraKeyframeGenerateSchema.parse(request);
    expect(cameraKeyframeVideoPrompt(input, false)).not.toContain("supplied End frame");
    expect(cameraKeyframeVideoPrompt(input, true)).toContain("supplied End frame");
    expect(cameraKeyframePrompt({ ...input, prompt: "Make it dusk" })).toContain("unless the user's additional instruction explicitly requests");
  });
});
