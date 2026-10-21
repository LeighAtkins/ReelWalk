import { describe, expect, it } from "vitest";
import { IDENTITY_MIN_CONFIDENCE, faceCropArguments, faceCropRect, identityDecision, readIdentityVerdict } from "../src/identity";

describe("identity gate decision table (ADR 0056)", () => {
  const verdict = (samePerson: boolean, confidence: number) => ({ samePerson, confidence, faceHeightPx: 200 });
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
  ] as const)("attempt %i with %o is %s", (attempt, input, expected) => {
    expect(identityDecision(attempt, input)).toBe(expected);
  });

  it("measures the face height from the box, not the model's own pixel count", () => {
    expect(readIdentityVerdict({ samePerson: true, confidence: 0.8, faceHeightPx: 999, faceBox: [300, 400, 400, 500] })).toEqual({ samePerson: true, confidence: 0.8, faceHeightPx: 192 });
    expect(readIdentityVerdict({ samePerson: false, confidence: 0.2, faceHeightPx: 61.6, faceBox: null })).toEqual({ samePerson: false, confidence: 0.2, faceHeightPx: 62 });
    expect(() => readIdentityVerdict({ samePerson: "yes", confidence: 2 })).toThrow();
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
