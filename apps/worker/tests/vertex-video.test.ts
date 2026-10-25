import { afterEach, describe, expect, it, vi } from "vitest";
const { awsOptions } = vi.hoisted(() => ({ awsOptions: vi.fn() }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class { async getAccessToken() { return "test-token"; } },
  AwsClient: class { constructor(options: unknown) { awsOptions(options); } async getAccessToken() { return { token: "federated-token" }; } },
}));
import { AI_DRAFT_MODEL, AI_VIDEO_MODEL } from "@reelwalk/core";
import { definitelyRejected, federatedVideoAuth, VertexError, VertexVideo, vertexVideoParameters } from "../src/vertex-video";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("Vertex video", () => {
  it("sends real first and last frames as provider inputs, keeping the fixed spend parameters", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ name: "operations/bridge" }));
    vi.stubGlobal("fetch", fetcher);
    const first = { bytesBase64Encoded: "first-frame", mimeType: "image/jpeg" };
    const last = { bytesBase64Encoded: "last-frame", mimeType: "image/jpeg" };
    await new VertexVideo("test-project").submit("veo-3.1-fast-generate-001", 8, "Connect these shots", first, last);
    const payload = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(payload.instances).toEqual([{ prompt: "Connect these shots", image: first, lastFrame: last }]);
    expect(payload.parameters).toMatchObject({ sampleCount: 1, durationSeconds: 8, resolution: "1080p" });
  });
  it("refreshes ECS credentials and forwards the session token for keyless Google exchange", async () => {
    vi.stubEnv("AWS_REGION", "us-east-2");
    const credentials = vi.fn().mockResolvedValueOnce({ accessKeyId: "first", secretAccessKey: "secret", sessionToken: "session" })
      .mockResolvedValueOnce({ accessKeyId: "refreshed", secretAccessKey: "new-secret", sessionToken: "new-session" });
    federatedVideoAuth(credentials, "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/test/providers/aws", "worker@test.iam.gserviceaccount.com");
    const options = awsOptions.mock.lastCall![0];
    expect(options.credential_source).toBeUndefined();
    expect(options.service_account_impersonation_url).toContain("worker@test.iam.gserviceaccount.com:generateAccessToken");
    expect(await options.aws_security_credentials_supplier.getAwsRegion()).toBe("us-east-2");
    expect(await options.aws_security_credentials_supplier.getAwsSecurityCredentials()).toEqual({ accessKeyId: "first", secretAccessKey: "secret", token: "session" });
    expect(await options.aws_security_credentials_supplier.getAwsSecurityCredentials()).toEqual({ accessKeyId: "refreshed", secretAccessKey: "new-secret", token: "new-session" });
  });
  it("requests exactly one silent 1080p portrait clip of the paid length", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ name: "projects/test/operations/one" }));
    vi.stubGlobal("fetch", fetcher);
    await new VertexVideo("test-project").submit("veo-3.1-fast-generate-001", 4, "A slow camera move");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({ parameters: {
      sampleCount: 1, durationSeconds: 4, generateAudio: false, resolution: "1080p", aspectRatio: "9:16",
    } });
    expect(vertexVideoParameters(8).durationSeconds).toBe(8);
    // Only lengths that have a credit price can reach the paid API.
    expect(() => vertexVideoParameters(6)).toThrow("Unsupported");
  });
  it("asks the draft model for 720p and the same seed as its final, keeping everything else the same", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ name: "projects/test/operations/draft" }));
    vi.stubGlobal("fetch", fetcher);
    const first = { bytesBase64Encoded: "first-frame", mimeType: "image/jpeg" };
    await new VertexVideo("test-project").submit(AI_DRAFT_MODEL, 4, "A slow camera move", first, undefined, false, 4242);
    expect(fetcher.mock.calls[0]![0]).toContain("/models/veo-3.1-lite-generate-001:predictLongRunning");
    const draft = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(draft.instances).toEqual([{ prompt: "A slow camera move", image: first }]);
    expect(draft.parameters).toEqual({ aspectRatio: "9:16", durationSeconds: 4, sampleCount: 1, resolution: "720p", generateAudio: false, personGeneration: "allow_adult", seed: 4242 });
    await new VertexVideo("test-project").submit(AI_VIDEO_MODEL, 4, "A slow camera move", first, undefined, false, 4242);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).parameters).toEqual({ ...draft.parameters, resolution: "1080p" });
    // A take with no seed sends none: the provider chooses, as before.
    await new VertexVideo("test-project").submit(AI_VIDEO_MODEL, 4, "A room");
    expect(JSON.parse(fetcher.mock.calls[2]![1].body).parameters).not.toHaveProperty("seed");
    expect(vertexVideoParameters(8, false, { model: AI_DRAFT_MODEL }).resolution).toBe("720p");
  });
  it("refunds a draft the provider refuses outright, like any take", () => {
    expect(definitelyRejected(new VertexError("Google video service returned HTTP 404 (NOT_FOUND).", 404, "NOT_FOUND"))).toBe(true);
    expect(definitelyRejected(new VertexError("Google video service returned HTTP 503.", 503))).toBe(false);
  });
  it("does not retry an ambiguous paid submission", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("timeout")); vi.stubGlobal("fetch", fetcher);
    await expect(new VertexVideo("test-project").submit("veo-3.1-fast-generate-001", 4, "A room")).rejects.toThrow("timeout");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("returns a filtered result as a refundable failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ done: true, response: { raiMediaFilteredCount: 1, videos: [] } })));
    expect(await new VertexVideo("test-project").poll("veo-3.1-fast-generate-001", "operations/test")).toMatchObject({ done: true, error: expect.stringContaining("credit was returned") });
  });
});

describe("submit failure classification (ADR 0056)", () => {
  it("reads only Google's canonical code from an error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { status: "INVALID_ARGUMENT", message: "prompt contains private text" } }, { status: 400 })));
    const error = await new VertexVideo("test-project").submit("veo", 8, "Prompt").catch(e => e);
    expect(error).toBeInstanceOf(VertexError);
    expect(error).toMatchObject({ status: 400, reason: "INVALID_ARGUMENT" });
    expect(error.message).not.toContain("private");
  });
  it("calls only a 4xx with a rejection code a definite refusal", () => {
    expect(definitelyRejected(new VertexError("x", 400, "INVALID_ARGUMENT"))).toBe(true);
    expect(definitelyRejected(new VertexError("x", 429, "RESOURCE_EXHAUSTED"))).toBe(true);
    expect(definitelyRejected(new VertexError("x", 400))).toBe(false);
    expect(definitelyRejected(new VertexError("x", 408, "DEADLINE_EXCEEDED"))).toBe(false);
    expect(definitelyRejected(new VertexError("x", 503, "UNAVAILABLE"))).toBe(false);
    expect(definitelyRejected(new DOMException("timed out", "TimeoutError"))).toBe(false);
  });
});
