import { afterEach, describe, expect, it, vi } from "vitest";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:util", () => ({ promisify: () => execute }));
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
  const answer = (value: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
  const composite = { bytesBase64Encoded: Buffer.from("composite").toString("base64"), mimeType: "image/jpeg" };
  it("finds her face in the composite, crops it, and compares the crop (not the frame) with the kit's face", async () => {
    execute.mockResolvedValue({ stdout: Buffer.concat([Buffer.from([0x89, 0x50]), Buffer.alloc(200)]) });
    const fetcher = vi.fn().mockResolvedValueOnce(answer({ faceBox: [200, 400, 300, 500] })).mockResolvedValueOnce(answer({ samePerson: true, confidence: 0.77 }));
    vi.stubGlobal("fetch", fetcher);
    const verdict = await new VertexImages("test-project").checkIdentity(composite, face);
    expect(verdict).toEqual({ samePerson: true, confidence: 0.77, faceHeightPx: 192 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toContain("gemini-2.5-flash:generateContent");
    const payload = JSON.parse(init.body);
    expect(payload.generationConfig).toMatchObject({ responseMimeType: "application/json", temperature: 0 });
    const images = payload.contents[0].parts.slice(1).map((part: { inlineData: { data: string; mimeType: string } }) => part.inlineData);
    expect(images[0].mimeType).toBe("image/png"); expect(images[0].data).not.toBe(composite.bytesBase64Encoded);
    expect(images[1].data).toBe("face");
    // The crop is the face square from the 1080×1920 composite, at 768×768.
    expect(execute.mock.calls[0][1].join(" ")).toMatch(/crop=\d+:\d+:\d+:\d+,scale=768:768/);
  });
  it.each([
    ["no face", { faceBox: null }, { faceHeightPx: null, reason: "no-face" }],
    ["a zero-area box", { faceBox: [300, 400, 300, 500] }, { faceHeightPx: null, reason: "no-face" }],
    ["a face too small to judge", { faceBox: [300, 400, 330, 420] }, { faceHeightPx: 58, reason: "face-too-small" }],
  ])("never compares, and never passes, with %s", async (_label, found, expected) => {
    const fetcher = vi.fn().mockResolvedValueOnce(answer(found)).mockResolvedValueOnce(answer({ samePerson: true, confidence: 0.99 }));
    vi.stubGlobal("fetch", fetcher);
    const verdict = await new VertexImages("test-project").checkIdentity(composite, face);
    expect(verdict).toEqual({ samePerson: false, confidence: 0, ...expected });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("finds the face box in a portrait, or null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: '{"faceBox":null}' }] } }] })));
    expect(await new VertexImages("test-project").findFace(face)).toBeNull();
  });
});
