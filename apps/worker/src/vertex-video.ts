import { AwsClient, GoogleAuth } from "google-auth-library";
import { aiVideoResolution } from "@reelwalk/core";

export type AwsCredentials = () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;

// The Google library's built-in AWS metadata flow supports EC2, not ECS.
// Reuse the AWS SDK's refreshing task-role provider instead of storing a key.
export function federatedVideoAuth(credentials: AwsCredentials, audience: string, email: string) {
  return new AwsClient({
    audience,
    subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${email}:generateAccessToken`,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    aws_security_credentials_supplier: {
      getAwsRegion: async () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-2",
      getAwsSecurityCredentials: async () => {
        const value = await credentials();
        return { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey, token: value.sessionToken };
      },
    },
  });
}

export class VertexError extends Error {
  /** Google's canonical error code from the response (e.g. "INVALID_ARGUMENT"), when it sent one; the body itself is never kept. */
  constructor(message: string, public readonly status: number, public readonly reason?: string) { super(message); }
}

/** Canonical codes that mean Google refused the request outright, so no operation can exist (ADR 0056). */
const REJECTED = new Set(["INVALID_ARGUMENT", "FAILED_PRECONDITION", "PERMISSION_DENIED", "UNAUTHENTICATED", "NOT_FOUND", "RESOURCE_EXHAUSTED", "OUT_OF_RANGE"]);
/** True only for a definite refusal: an HTTP 4xx (not a timeout) whose body names a rejection code. */
export function definitelyRejected(error: unknown): boolean {
  return error instanceof VertexError && error.status >= 400 && error.status < 500 && error.status !== 408
    && error.reason !== undefined && REJECTED.has(error.reason);
}

/**
 * What a take is asked for. The resolution follows the model (ADR 0076): the draft model is asked for 720p, every other 1080p.
 * A `seed` (0 to 2^32 − 1) is sent only when the studio's take carries one, so a draft and its final ask for the same one.
 */
export function vertexVideoParameters(durationSeconds: number, generateAudio = false, options: { model?: string; seed?: number } = {}) {
  if (![4, 8].includes(durationSeconds)) throw new Error("Unsupported AI clip length.");
  return {
    aspectRatio: "9:16", durationSeconds, sampleCount: 1, resolution: aiVideoResolution(options.model ?? ""), generateAudio, personGeneration: "allow_adult",
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  };
}

/** A bearer-token source for Vertex: workload identity through the task role when configured, otherwise application default credentials. */
export function vertexAuth(credentials?: AwsCredentials): () => Promise<string | null | undefined> {
  const audience = process.env.GOOGLE_WORKLOAD_IDENTITY_AUDIENCE;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (audience || email) {
    if (!audience || !email || !credentials) throw new Error("Incomplete Google workload identity configuration.");
    const auth = federatedVideoAuth(credentials, audience, email);
    return async () => (await auth.getAccessToken()).token;
  }
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return () => auth.getAccessToken();
}

export class VertexVideo {
  private readonly getToken: () => Promise<string | null | undefined>;
  constructor(private readonly project = process.env.GOOGLE_CLOUD_PROJECT!, private readonly location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1", credentials?: AwsCredentials) {
    this.getToken = vertexAuth(credentials);
  }

  private async request(model: string, method: string, body: unknown) {
    // Deliberately no retry on predictLongRunning: repeating a timed-out POST
    // can charge twice. Polling is read-only and can be resumed safely.
    const token = await this.getToken();
    if (!token) throw new Error("Google credentials could not be refreshed.");
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${model}:${method}`;
    const response = await fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      // Never persist provider bodies: they may contain request data or credentials. Only the canonical code is read.
      const reason = await response.json().then((body: { error?: { status?: unknown } }) => typeof body?.error?.status === "string" ? body.error.status : undefined, () => undefined);
      throw new VertexError(`Google video service returned HTTP ${response.status}${reason ? ` (${reason})` : ""}.`, response.status, reason);
    }
    return response.json();
  }

  async submit(model: string, durationSeconds: number, prompt: string, image?: { bytesBase64Encoded: string; mimeType: string }, lastFrame?: { bytesBase64Encoded: string; mimeType: string }, generateAudio = false, seed?: number) {
    const result = await this.request(model, "predictLongRunning", {
      instances: [{ prompt, ...(image ? { image } : {}), ...(lastFrame ? { lastFrame } : {}) }], parameters: vertexVideoParameters(durationSeconds, generateAudio, { model, seed }),
    });
    if (typeof result.name !== "string") throw new Error("Google did not return a video operation.");
    return result.name as string;
  }

  async poll(model: string, operationName: string): Promise<{ done: boolean; video?: Buffer; error?: string }> {
    const result = await this.request(model, "fetchPredictOperation", { operationName });
    if (!result.done) return { done: false };
    if (result.error) return { done: true, error: "Google could not generate this shot. Your credit was returned." };
    const video = result.response?.videos?.[0];
    if (!video?.bytesBase64Encoded || video.mimeType !== "video/mp4") {
      return { done: true, error: "No video was returned. Try a different prompt; your credit was returned." };
    }
    const buffer = Buffer.from(video.bytesBase64Encoded, "base64");
    if (buffer.length < 100 || buffer.length > 100 * 1024 * 1024) return { done: true, error: "The video was unreadable. Your credit was returned." };
    return { done: true, video: buffer };
  }
}
