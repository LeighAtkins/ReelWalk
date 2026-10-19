import { describe, expect, it } from "vitest";
import { composePrompt, imageFromResponse } from "../src/vertex-images";

describe("composed keyframes", () => {
  it("pins scale and identity in the instruction and says which end of the shot it is", () => {
    const first = composePrompt("first", "Standing in the open front doorway, hand on the frame.");
    expect(first).toContain("keep its camera position");
    expect(first).toContain("Standing in the open front doorway");
    expect(first).toContain("never larger than a doorway");
    expect(first).toContain("first frame of the shot");
    expect(composePrompt("last", "Seated on the sofa.")).toContain("last frame of the shot");
  });

  it("finds the inline image in a generateContent response", () => {
    expect(imageFromResponse({ candidates: [{ content: { parts: [{ text: "Here" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }] } }] })).toEqual({ bytesBase64Encoded: "QUJD", mimeType: "image/png" });
    expect(imageFromResponse({ candidates: [{ content: { parts: [{ text: "Sorry" }] } }] })).toBeNull();
    expect(imageFromResponse({})).toBeNull();
  });
});
