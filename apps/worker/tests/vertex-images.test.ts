import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("google-auth-library", () => ({
  GoogleAuth: class { async getAccessToken() { return "test-token"; } },
  AwsClient: class { async getAccessToken() { return { token: "federated-token" }; } },
}));
import { composeParts, composePrompt, imageFromResponse, jsonFromResponse, VertexImages } from "../src/vertex-images";

afterEach(() => { vi.unstubAllGlobals(); });

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

describe("presenter kit compose (ADR 0056)", () => {
  const scene = { bytesBase64Encoded: "scene", mimeType: "image/png" };
  const body = { bytesBase64Encoded: "body", mimeType: "image/png" };
  const face = { bytesBase64Encoded: "face", mimeType: "image/png" };
  it("sends three PNG images, scene then full-length then face, and names the face as the identity", () => {
    const parts = composeParts("first", "Beside the island bench, waist above it.", scene, body, face, { framing: "medium" });
    expect(parts).toHaveLength(4);
    expect(parts.slice(1).map(part => (part as { inlineData: { mimeType: string; data: string } }).inlineData)).toEqual([
      { mimeType: "image/png", data: "scene" }, { mimeType: "image/png", data: "body" }, { mimeType: "image/png", data: "face" },
    ]);
    const text = (parts[0] as { text: string }).text;
    expect(text).toContain("match the face in the third image exactly (eyes, nose, mouth, hairline, hair length and colour)");
    expect(text).toContain("medium shot");
    expect(text).toContain("at least 180 px tall");
  });
  it("keeps the two-image request for an older frame-only presenter, and strengthens identity on a retry", () => {
    expect(composeParts("first", "In the doorway, head below the lintel.", scene, body)).toHaveLength(3);
    expect(composePrompt("first", "In the doorway.", { face: true, stronger: true })).toContain("Identity is the priority");
    expect(composePrompt("first", "In the doorway.", { face: true })).not.toContain("Identity is the priority");
    expect(composePrompt("first", "A small figure at the gate.", { framing: "wide" })).toContain("Wide framing");
  });
  it("reads a JSON answer, with or without a code fence", () => {
    const answer = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
    expect(jsonFromResponse(answer('{"faceBox":[1,2,3,4]}'))).toEqual({ faceBox: [1, 2, 3, 4] });
    expect(jsonFromResponse(answer('```json\n{"faceBox":null}\n```'))).toEqual({ faceBox: null });
    expect(() => jsonFromResponse({})).toThrow("no answer");
  });
  it("asks a text model whether the composite is her, with the composite first and the kit's face second", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ samePerson: true, confidence: 0.77, faceHeightPx: 50, faceBox: [200, 400, 300, 500] }) }] } }] }));
    vi.stubGlobal("fetch", fetcher);
    const verdict = await new VertexImages("test-project").checkIdentity({ bytesBase64Encoded: "composite", mimeType: "image/jpeg" }, face);
    expect(verdict).toEqual({ samePerson: true, confidence: 0.77, faceHeightPx: 192 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toContain("gemini-2.5-flash:generateContent");
    const payload = JSON.parse(init.body);
    expect(payload.generationConfig).toMatchObject({ responseMimeType: "application/json", temperature: 0 });
    expect(payload.contents[0].parts.slice(1).map((part: { inlineData: { data: string } }) => part.inlineData.data)).toEqual(["composite", "face"]);
  });
  it("finds the face box in a portrait, or null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: '{"faceBox":null}' }] } }] })));
    expect(await new VertexImages("test-project").findFace(face)).toBeNull();
  });
});
