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
  constructor(message: string, public readonly status: number, public readonly reason?: string, public readonly billingDisabled = false) { super(message); }
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
  private activeProject: string;
  private readonly fallbackProject = process.env.GOOGLE_CLOUD_FALLBACK_PROJECT?.trim() || undefined;
  constructor(private readonly project = process.env.GOOGLE_CLOUD_PROJECT!, private readonly location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1", credentials?: AwsCredentials) {
    this.getToken = vertexAuth(credentials);
    this.activeProject = project;
  }

  private async request(model: string, method: string, body: unknown, project = this.project, location = this.location) {
    // Deliberately no retry on predictLongRunning: repeating a timed-out POST
    // can charge twice. Polling is read-only and can be resumed safely.
    const token = await this.getToken();
    if (!token) throw new Error("Google credentials could not be refreshed.");
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:${method}`;
    const response = await fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      // Never persist provider bodies: they may contain request data or credentials. Only the canonical code is read.
      const error = await response.json().then((body: { error?: { status?: unknown; details?: { "@type"?: string; domain?: string; reason?: string }[] } }) => body.error, () => undefined);
      const reason = typeof error?.status === "string" ? error.status : undefined;
      // Only Google's structured billing refusal permits a second paid POST. Quota, IAM,
      // safety, timeouts and server errors never switch projects or duplicate a submission.
      const billingDisabled = response.status === 403 && reason === "PERMISSION_DENIED" && Array.isArray(error?.details)
        && error.details.some(detail => detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" && detail.domain === "googleapis.com" && detail.reason === "BILLING_DISABLED");
      throw new VertexError(`Google video service returned HTTP ${response.status}${reason ? ` (${reason})` : ""}.`, response.status, reason, billingDisabled);
    }
    return response.json();
  }

  async submit(model: string, durationSeconds: number, prompt: string, image?: { bytesBase64Encoded: string; mimeType: string }, lastFrame?: { bytesBase64Encoded: string; mimeType: string }, generateAudio = false, seed?: number) {
    const body = {
      instances: [{ prompt, ...(image ? { image } : {}), ...(lastFrame ? { lastFrame } : {}) }], parameters: vertexVideoParameters(durationSeconds, generateAudio, { model, seed }),
    };
    let result;
    try {
      result = await this.request(model, "predictLongRunning", body, this.activeProject);
    } catch (error) {
      if (!(error instanceof VertexError) || !error.billingDisabled || !this.fallbackProject || this.activeProject === this.fallbackProject) throw error;
      // The first project definitively refused before making an operation. At most one fallback.
      result = await this.request(model, "predictLongRunning", body, this.fallbackProject);
      this.activeProject = this.fallbackProject;
    }
    if (typeof result.name !== "string") throw new Error("Google did not return a video operation.");
    return result.name as string;
  }

  async poll(model: string, operationName: string): Promise<{ done: boolean; video?: Buffer; error?: string }> {
    // Persisted Google operation names carry their billing project across process restarts.
    const route = /^projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^/]+)\/operations\/[^/]+$/.exec(operationName);
    if (route && (![this.project, this.fallbackProject].includes(route[1]) || route[2] !== this.location || route[3] !== model)) throw new Error("Unexpected Google video operation route.");
    const result = await this.request(model, "fetchPredictOperation", { operationName }, route?.[1] ?? this.project, route?.[2] ?? this.location);
    if (!result.done) return { done: false };
    if (result.error) return { done: true, error: "Google could not generate this shot. Your credit was returned." };
    const video = result.response?.videos?.[0];
    if (!video?.bytesBase64Encoded || video.mimeType !== "video/mp4") {
      // Google's own filter codes say why (a safety filter on people, audio or the prompt); they carry no request data.
      const filtered = result.response?.raiMediaFilteredReasons;
      console.warn(`vertex-video: no video in ${operationName.split("/").pop()}: filtered ${result.response?.raiMediaFilteredCount ?? "?"}${Array.isArray(filtered) ? `, ${filtered.join(" | ")}` : ""}`);
      return { done: true, error: "No video was returned. Try a different prompt; your credit was returned." };
    }
    const buffer = Buffer.from(video.bytesBase64Encoded, "base64");
    if (buffer.length < 100 || buffer.length > 100 * 1024 * 1024) return { done: true, error: "The video was unreadable. Your credit was returned." };
    return { done: true, video: buffer };
  }
}
