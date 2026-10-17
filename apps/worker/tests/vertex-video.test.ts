import { afterEach, describe, expect, it, vi } from "vitest";
const { awsOptions } = vi.hoisted(() => ({ awsOptions: vi.fn() }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class { async getAccessToken() { return "test-token"; } },
  AwsClient: class { constructor(options: unknown) { awsOptions(options); } async getAccessToken() { return { token: "federated-token" }; } },
}));
import { federatedVideoAuth, VertexVideo, vertexVideoParameters } from "../src/vertex-video";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("Vertex video", () => {
  it("sends real first and last frames as provider inputs, keeping the fixed spend parameters", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ name: "operations/bridge" }));
    vi.stubGlobal("fetch", fetcher);
    const first = { bytesBase64Encoded: "first-frame", mimeType: "image/jpeg" };
    const last = { bytesBase64Encoded: "last-frame", mimeType: "image/jpeg" };
    await new VertexVideo("test-project").submit("veo-3.1-fast-generate-001", "Connect these shots", first, last);
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
