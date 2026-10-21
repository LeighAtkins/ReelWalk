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
    expect(composePrompt("first", "At the gate.", { framing: "medium", closer: true })).toContain("Closer: her head about a quarter of the way down, face at least 220 px tall.");
  });
  it("reads a JSON answer, with or without a code fence", () => {
    const answer = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
    expect(jsonFromResponse(answer('{"faceBox":[1,2,3,4]}'))).toEqual({ faceBox: [1, 2, 3, 4] });
    expect(jsonFromResponse(answer('```json\n{"faceBox":null}\n```'))).toEqual({ faceBox: null });
    expect(() => jsonFromResponse({})).toThrow("no answer");
  });
  const answer = (value: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
  const composite = { bytesBase64Encoded: Buffer.from("composite").toString("base64"), mimeType: "image/jpeg" };
  const herFace = { box_2d: [367, 495, 419, 579], left_eye: [380, 520], right_eye: [380, 555], mouth: [405, 538] };
  const match = { faceVisible: true, samePerson: true, confidence: 0.77, eyesAndMouthRendered: true };
  const png = () => execute.mockResolvedValue({ stdout: Buffer.concat([Buffer.from([0x89, 0x50]), Buffer.alloc(200)]) });
  it("locates her face in Gemini's box_2d format, crops it, compares the crop with the kit's face, and records the locate", async () => {
    png();
    const fetcher = vi.fn().mockResolvedValueOnce(answer({ box_2d: [300, 400, 400, 500] })).mockResolvedValueOnce(answer(match));
    vi.stubGlobal("fetch", fetcher);
    const verdict = await new VertexImages("test-project").checkIdentity(composite, face);
    expect(verdict).toEqual({ samePerson: true, confidence: 0.77, eyesAndMouthRendered: true, faceHeightPx: 192,
      locate: [{ mode: "grid", box: [300, 400, 400, 500], crop: { x: 275, y: 432, size: 422 }, faceHeightPx: 192 }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const locate = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(locate.contents[0].parts[0].text).toContain("box_2d");
    expect(locate.generationConfig.responseSchema).toBeUndefined(); // Gemini's own detection format, not a forced schema
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toContain("gemini-2.5-flash:generateContent");
    const payload = JSON.parse(init.body);
    expect(payload.generationConfig).toMatchObject({ responseMimeType: "application/json", temperature: 0 });
    expect(payload.generationConfig.responseSchema.required).toEqual(["faceVisible", "samePerson", "confidence", "eyesAndMouthRendered"]);
    expect(payload.contents[0].parts[0].text).toContain("both eyes open with visible iris and whites");
    const images = payload.contents[0].parts.slice(1).map((part: { inlineData: { data: string; mimeType: string } }) => part.inlineData);
    expect(images[0].mimeType).toBe("image/png"); expect(images[0].data).not.toBe(composite.bytesBase64Encoded);
    expect(images[1].data).toBe("face");
    expect(execute.mock.calls[0][1].join(" ")).toContain("crop=422:422:275:432,scale=768:768");
  });
  it("a crop that shows no face is a missed locate, not a different person: it locates again in pixels", async () => {
    png();
    // cmvi32byk: a box that is face-shaped but lands on her coat (pixels read as the grid), then the pixel answer.
    const fetcher = vi.fn()
      .mockResolvedValueOnce(answer({ box_2d: [705, 535, 805, 625] }))
      .mockResolvedValueOnce(answer({ faceVisible: false, samePerson: false, confidence: 0.05, eyesAndMouthRendered: false }))
      .mockResolvedValueOnce(answer({ box_px: [610, 510, 860, 640] }))
      .mockResolvedValueOnce(answer({ ...match, confidence: 0.9 }));
    vi.stubGlobal("fetch", fetcher);
    const verdict = await new VertexImages("test-project").checkIdentity(composite, face);
    expect(verdict).toMatchObject({ samePerson: true, confidence: 0.9, faceHeightPx: 250 });
    expect(verdict.locate).toEqual([
      expect.objectContaining({ mode: "grid", box: [705, 535, 805, 625], rejected: "face-not-in-crop" }),
      expect.objectContaining({ mode: "pixels", faceHeightPx: 250 }),
    ]);
    expect(JSON.parse(fetcher.mock.calls[2]![1].body).contents[0].parts[0].text).toContain("1080 pixels wide and 1920 pixels tall");
  });
  it("never scores identity when neither locate lands on a face", async () => {
    png();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(answer({ box_2d: [495, 367, 579, 419] })) // x/y swapped: a sliver, refused without a compare
      .mockResolvedValueOnce(answer({ box_px: [1210, 415, 1632, 837] }))
      .mockResolvedValueOnce(answer({ faceVisible: false, samePerson: false, confidence: 0.05, eyesAndMouthRendered: false }));
    vi.stubGlobal("fetch", fetcher);
    const verdict = await new VertexImages("test-project").checkIdentity(composite, face);
    expect(verdict).toMatchObject({ samePerson: false, confidence: 0, faceHeightPx: null, reason: "locate-failed" });
    expect(verdict.locate!.map(attempt => attempt.rejected)).toEqual(["implausible-box", "face-not-in-crop"]);
  });
  it.each([
    ["no face", { box_2d: null }, { faceHeightPx: null, reason: "no-face" }, 2],
    ["a zero-area box", { box_2d: [300, 400, 300, 500] }, { faceHeightPx: null, reason: "locate-failed" }, 2],
    ["a face too small to judge", { box_2d: [300, 400, 330, 445] }, { faceHeightPx: 58, reason: "face-too-small" }, 1],
  ])("never compares, and never passes, with %s", async (_label, found, expected, calls) => {
    const fetcher = vi.fn().mockImplementation(async () => answer(found));
    vi.stubGlobal("fetch", fetcher);
    const verdict = await new VertexImages("test-project").checkIdentity(composite, face);
    expect(verdict).toMatchObject({ samePerson: false, confidence: 0, ...expected });
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it("holds a speaking take to 220 px", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => answer(herFace)));
    const verdict = await new VertexImages("test-project").checkIdentity(composite, face, { minFacePx: 220 });
    expect(verdict).toMatchObject({ reason: "face-too-small", faceHeightPx: 100 });
  });
  it("finds the face box in a portrait, falling back to pixels, or null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => answer({ box_2d: null })));
    expect((await new VertexImages("test-project").findFace(face, { width: 960, height: 960 })).box).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(answer({ box_2d: [100, 400, 900, 420] })).mockResolvedValueOnce(answer({ box_px: [180, 300, 600, 640] })));
    const found = await new VertexImages("test-project").findFace(face, { width: 960, height: 960 });
    expect(found.box!.map(Math.round)).toEqual([188, 313, 625, 667]);
    expect(found.locate[0]).toMatchObject({ mode: "grid", rejected: "implausible-box" });
  });
});
