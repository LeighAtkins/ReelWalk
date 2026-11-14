import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/vertex-video", () => ({ vertexAuth: () => async () => "fixture-token" }));
import { keyframeTransport } from "../src/vertex-keyframes";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("exact Pro transport", () => {
  it("uses the Google global Pro endpoint once and returns raw errors without fallback", async () => {
    vi.stubEnv("AI_KEYFRAMES_ENABLED", "true"); vi.stubEnv("GOOGLE_CLOUD_PROJECT", "fixture-project");
    const fetch = vi.fn().mockResolvedValue(new Response("raw rejection", { status: 503 })); vi.stubGlobal("fetch", fetch);
    const result = await (await keyframeTransport()).submit("frozen request");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-3-pro-image:generateContent");
    expect(result).toEqual({ version: 1, status: 503, incomplete: false, bodyBase64: Buffer.from("raw rejection").toString("base64") });
  });
});
