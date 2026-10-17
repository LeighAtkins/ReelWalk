import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("google-auth-library", () => ({ GoogleAuth: class { async getAccessToken() { return "test-token"; } } }));
import { VertexVideo, vertexVideoParameters } from "../src/vertex-video";

afterEach(() => vi.unstubAllGlobals());
describe("Vertex video", () => {
  it("always requests exactly one silent eight-second 1080p portrait clip", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ name: "projects/test/operations/one" }));
    vi.stubGlobal("fetch", fetcher);
    await new VertexVideo("test-project").submit("veo-3.1-fast-generate-001", "A slow camera move");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({ parameters: {
      sampleCount: 1, durationSeconds: 8, generateAudio: false, resolution: "1080p", aspectRatio: "9:16",
    } });
    expect(vertexVideoParameters().sampleCount).toBe(1);
  });
  it("does not retry an ambiguous paid submission", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("timeout")); vi.stubGlobal("fetch", fetcher);
    await expect(new VertexVideo("test-project").submit("veo-3.1-fast-generate-001", "A room")).rejects.toThrow("timeout");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("returns a filtered result as a refundable failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ done: true, response: { raiMediaFilteredCount: 1, videos: [] } })));
    expect(await new VertexVideo("test-project").poll("veo-3.1-fast-generate-001", "operations/test")).toMatchObject({ done: true, error: expect.stringContaining("credit was returned") });
  });
});
