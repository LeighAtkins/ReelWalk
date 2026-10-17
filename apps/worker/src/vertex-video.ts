import { GoogleAuth } from "google-auth-library";

export class VertexError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export function vertexVideoParameters() {
  return { aspectRatio: "9:16", durationSeconds: 8, sampleCount: 1, resolution: "1080p", generateAudio: false, personGeneration: "allow_adult" };
}

export class VertexVideo {
  private readonly auth: GoogleAuth;
  constructor(private readonly project = process.env.GOOGLE_CLOUD_PROJECT!, private readonly location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1") {
    const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    this.auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      ...(json && json !== "unset" ? { credentials: JSON.parse(json) } : {}),
    });
  }

  private async request(model: string, method: string, body: unknown) {
    // Deliberately no retry on predictLongRunning: repeating a timed-out POST
    // can charge twice. Polling is read-only and can be resumed safely.
    const token = await this.auth.getAccessToken();
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${model}:${method}`;
    const response = await fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      // Never persist provider bodies: they may contain request data or credentials.
      throw new VertexError(`Google video service returned HTTP ${response.status}.`, response.status);
    }
    return response.json();
  }

  async submit(model: string, prompt: string, image?: { bytesBase64Encoded: string; mimeType: string }) {
    const result = await this.request(model, "predictLongRunning", {
      instances: [{ prompt, ...(image ? { image } : {}) }], parameters: vertexVideoParameters(),
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
