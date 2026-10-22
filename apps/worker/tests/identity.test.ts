import { describe, expect, it } from "vitest";
import { IDENTITY_MIN_CONFIDENCE, MIN_GATE_FACE_PX, MIN_SPEAKING_FACE_PX, faceCropArguments, faceCropRect, faceHeightFromBox, identityDecision, identityRejectionMessage, minFacePx, plausibleFace, readLocate, speakingEnd, unjudgeable } from "../src/identity";

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

  it("holds a speaking take to 165 px, a little below the 180 px face of cmvi3jstp, whose take had good eyes and mouth", () => {
    expect(minFacePx(true)).toBe(MIN_SPEAKING_FACE_PX); expect(MIN_SPEAKING_FACE_PX).toBe(165); expect(minFacePx(false)).toBe(MIN_GATE_FACE_PX);
    const face = (faceHeightPx: number) => ({ samePerson: true, confidence: 0.9, faceHeightPx, eyesAndMouthRendered: true });
    expect(identityDecision(2, face(164), minFacePx(true))).toBe("reject");
    expect(identityDecision(2, face(180), minFacePx(true))).toBe("pass");
    expect(identityDecision(2, face(130), minFacePx(false))).toBe("pass");
    expect(unjudgeable(160, MIN_SPEAKING_FACE_PX)).toMatchObject({ reason: "face-too-small" });
  });
  it("applies the speaking floor to voiced ends, except a shouted Veo line over a wide or action shot", () => {
    expect(speakingEnd(null, "Beside the bench.")).toBe(false);
    expect(speakingEnd("lipsync", "Wide: at the gate.")).toBe(true);
    expect(speakingEnd("veo", "Beside the bench, waist above it.")).toBe(true);
    expect(speakingEnd("veo", "Wide: a small figure at the gate.")).toBe(false);
    expect(speakingEnd("veo", "Mid-action, leaping off the deck.")).toBe(false);
    expect(speakingEnd("veo", "Actionable widescreen")).toBe(true); // whole words only
  });
  it("says honestly why a take was refused", () => {
    const tail = "so the shot was not made. Your credit was returned.";
    expect(identityRejectionMessage("first", { samePerson: false, confidence: 0, faceHeightPx: null, reason: "locate-failed" }, 120, false))
      .toBe(`We couldn't find her face clearly in the start frame, ${tail}`);
    expect(identityRejectionMessage("last", { samePerson: false, confidence: 0, faceHeightPx: null, reason: "no-face" }, 120, false))
      .toBe(`We couldn't find her face clearly in the end frame, ${tail}`);
    expect(identityRejectionMessage("first", { samePerson: false, confidence: 0, faceHeightPx: 140, reason: "face-too-small" }, 165, true))
      .toBe(`Her face was too small to speak on camera (140 px; needs 165), ${tail}`);
    expect(identityRejectionMessage("first", { samePerson: false, confidence: 0, faceHeightPx: 100, reason: "face-too-small" }, 120, false))
      .toBe(`Her face was too small to recognise (100 px; needs 120), ${tail}`);
    expect(identityRejectionMessage("first", { samePerson: true, confidence: 0.98, faceHeightPx: 200, eyesAndMouthRendered: false }, 120, false))
      .toBe(`Her eyes or mouth weren't clearly drawn in the start frame, ${tail}`);
    expect(identityRejectionMessage("first", { samePerson: false, confidence: 0.31, faceHeightPx: 200, eyesAndMouthRendered: true }, 120, false))
      .toBe(`It didn't look like her (score 0.31), ${tail}`);
    expect(identityRejectionMessage("first", null, 120, false)).toBe(`We couldn't check her face in the start frame, ${tail}`);
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
  it("throws on malformed answers so the caller can record them as unparseable", () => {
    for (const probe of [{ box_2d: ["367", "495", "419", "579"] }, { box_2d: [367, 495, 419, 579, 600] }, { box_2d: [[367, 495], [419, 579]] }, null, "a face", 42]) {
      expect(() => readLocate(probe, frame)).toThrow();
    }
  });
  it("refuses a box normalised to 0–1 instead of 0–1000", () => {
    const located = readLocate({ box_2d: [0.367, 0.495, 0.419, 0.579] }, frame);
    expect(plausibleFace(located, frame)).toBe(false);
  });
  it("picks the largest plausible face when several are found", () => {
    const passerby = { box_2d: [100, 100, 120, 118] }, sliver = { box_2d: [100, 600, 400, 620] };
    expect(readLocate([passerby, { box_2d: herFace }, sliver], frame).box).toEqual(herFace);
    expect(readLocate([sliver], frame).box).toEqual(sliver.box_2d); // kept for the record, refused by plausibleFace
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
