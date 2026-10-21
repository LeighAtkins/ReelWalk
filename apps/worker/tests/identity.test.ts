import { describe, expect, it } from "vitest";
import { IDENTITY_MIN_CONFIDENCE, MIN_GATE_FACE_PX, MIN_SPEAKING_FACE_PX, faceCropArguments, faceCropRect, faceHeightFromBox, identityDecision, minFacePx, plausibleFace, readLocate, unjudgeable } from "../src/identity";

describe("identity gate decision table (ADR 0056)", () => {
  const verdict = (samePerson: boolean, confidence: number) => ({ samePerson, confidence, faceHeightPx: 200, eyesAndMouthRendered: true });
  it.each([
    [1, verdict(true, 0.9), "pass"],
    [1, verdict(true, IDENTITY_MIN_CONFIDENCE), "pass"],
    [1, verdict(true, 0.59), "recompose"],
    [1, verdict(false, 0.95), "recompose"],
    [1, null, "recompose"],
    [2, verdict(true, 0.7), "pass"],
    [2, verdict(true, 0.4), "reject"],
    [2, verdict(false, 0.8), "reject"],
    [2, null, "reject"],
    // Review: a confident "same person" with no measured face, or a face too small to judge, is never a pass.
    [1, { samePerson: true, confidence: 0.99, faceHeightPx: null, eyesAndMouthRendered: true }, "recompose"],
    [2, { samePerson: true, confidence: 0.99, faceHeightPx: null, eyesAndMouthRendered: true }, "reject"],
    [2, { samePerson: true, confidence: 0.99, faceHeightPx: MIN_GATE_FACE_PX - 1, eyesAndMouthRendered: true }, "reject"],
    [1, { samePerson: true, confidence: 0.9, faceHeightPx: MIN_GATE_FACE_PX, eyesAndMouthRendered: true }, "pass"],
    // cmvi0jk8h: a confident match whose eyes and mouth were not rendered is never a pass, nor one that does not say.
    [1, { samePerson: true, confidence: 0.98, faceHeightPx: 200, eyesAndMouthRendered: false }, "recompose"],
    [2, { samePerson: true, confidence: 0.98, faceHeightPx: 200 }, "reject"],
  ] as const)("attempt %i with %o is %s", (attempt, input, expected) => {
    expect(identityDecision(attempt, input)).toBe(expected);
  });

  it("needs a 220 px face for a speaking take", () => {
    expect(minFacePx(true)).toBe(MIN_SPEAKING_FACE_PX); expect(MIN_SPEAKING_FACE_PX).toBe(220); expect(minFacePx(false)).toBe(MIN_GATE_FACE_PX);
    const face = (faceHeightPx: number) => ({ samePerson: true, confidence: 0.9, faceHeightPx, eyesAndMouthRendered: true });
    expect(identityDecision(2, face(219), minFacePx(true))).toBe("reject");
    expect(identityDecision(2, face(220), minFacePx(true))).toBe("pass");
    expect(identityDecision(2, face(160), minFacePx(false))).toBe("pass");
    expect(unjudgeable(160, MIN_SPEAKING_FACE_PX)).toMatchObject({ reason: "face-too-small" });
  });

  it("measures the face from a valid, non-empty box only", () => {
    expect(faceHeightFromBox([300, 400, 400, 500])).toBe(192);
    expect(faceHeightFromBox(null)).toBeNull();
    expect(faceHeightFromBox([300, 400, 300, 500])).toBeNull(); // zero height
    expect(faceHeightFromBox([300, 400, 400, 400])).toBeNull(); // zero width
    expect(faceHeightFromBox([400, 400, 300, 500])).toBeNull(); // inverted
    expect(faceHeightFromBox([300, 400, 400])).toBeNull();
  });
  it("calls a missing or tiny face a miss before any comparison", () => {
    expect(unjudgeable(null)).toEqual({ samePerson: false, confidence: 0, faceHeightPx: null, reason: "no-face" });
    expect(unjudgeable(65)).toEqual({ samePerson: false, confidence: 0, faceHeightPx: 65, reason: "face-too-small" });
    expect(unjudgeable(MIN_GATE_FACE_PX)).toBeNull();
  });
});

describe("face crop", () => {
  it("cuts a square around the face that takes in the hair, inside the image", () => {
    // A 941×1672 full-length still with her face about 100 px tall.
    const rect = faceCropRect([355, 480, 415, 560], 941, 1672);
    expect(rect.faceHeightPx).toBe(100);
    expect(rect.size).toBeGreaterThanOrEqual(2 * 100);
    expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.size).toBeLessThanOrEqual(941); expect(rect.y + rect.size).toBeLessThanOrEqual(1672);
    // The face sits inside the crop, a little below centre so the top of the hair is in.
    const faceTop = 0.355 * 1672, faceBottom = 0.415 * 1672;
    expect(rect.y).toBeLessThan(faceTop); expect(rect.y + rect.size).toBeGreaterThan(faceBottom);
    expect(faceTop - rect.y).toBeGreaterThan(rect.y + rect.size - faceBottom);
  });
  it("clamps a face at the edge of the photo", () => {
    const rect = faceCropRect([0, 900, 300, 1000], 1000, 1000);
    expect(rect).toMatchObject({ x: 1000 - rect.size, y: 0 });
    expect(rect.size).toBeLessThanOrEqual(1000);
  });
  it("writes a 768×768 RGB PNG", () => {
    const args = faceCropArguments("/tmp/p.png", { x: 10, y: 20, size: 300 });
    expect(args.join(" ")).toContain("crop=300:300:10:20,scale=768:768");
    expect(args).toEqual(expect.arrayContaining(["png", "rgb24"]));
    expect(args).not.toContain("yuvj420p");
  });
});

describe("locating her face (the cmvi32byk false reject)", () => {
  const frame = { width: 1080, height: 1920 };
  // Measured by eye on cmvi32byk000701ademkws6ou-first.jpg: hairline 705, chin 805, ears 535 and 625 px.
  const herFace = [367, 495, 419, 579];
  it("reads Gemini's box_2d, the old faceBox, a one-element list, or a box in stated pixels onto the 0–1000 grid", () => {
    expect(readLocate({ box_2d: herFace, left_eye: [380, 520], right_eye: [380, 555], mouth: [405, 538] }, frame)).toEqual({ box: herFace, landmarks: { leftEye: [380, 520], rightEye: [380, 555], mouth: [405, 538] } });
    expect(readLocate({ faceBox: herFace }, frame).box).toEqual(herFace);
    expect(readLocate([{ box_2d: herFace }], frame).box).toEqual(herFace);
    expect(readLocate({ box_px: [705, 535, 805, 625] }, frame).box!.map(Math.round)).toEqual([367, 495, 419, 579]);
    expect(readLocate({ box_2d: null }, frame).box).toBeNull();
  });
  it("accepts her real face box and crops a square that contains it", () => {
    expect(plausibleFace({ box: herFace, landmarks: { leftEye: [380, 520], rightEye: [380, 555], mouth: [405, 538] } }, frame)).toBe(true);
    const rect = faceCropRect(herFace, 1080, 1920);
    expect(rect).toEqual({ x: 470, y: 630, size: 220, faceHeightPx: 100 });
    expect(rect.x).toBeLessThan(535); expect(rect.x + rect.size).toBeGreaterThan(625);
    expect(rect.y).toBeLessThan(705); expect(rect.y + rect.size).toBeGreaterThan(805);
  });
  it("refuses boxes that cannot be a face: an x/y swap, landmarks outside the box, eyes below the mouth, off the grid", () => {
    expect(plausibleFace({ box: [495, 367, 579, 419], landmarks: {} }, frame)).toBe(false); // swapped: a 161×56 px sliver
    expect(plausibleFace({ box: herFace, landmarks: { mouth: [700, 538] } }, frame)).toBe(false);
    expect(plausibleFace({ box: herFace, landmarks: { leftEye: [410, 520], mouth: [385, 538] } }, frame)).toBe(false);
    expect(plausibleFace({ box: [705, 535, 1805, 625], landmarks: {} }, frame)).toBe(false);
    expect(plausibleFace({ box: null, landmarks: {} }, frame)).toBe(false);
  });
});
