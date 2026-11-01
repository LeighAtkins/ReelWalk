import { VertexError } from "./vertex-video";

/**
 * Gemini Omni Flash on the Gemini API's Interactions endpoint (ADR 0105). One take is one interaction:
 *
 *   POST /v1beta/interactions  { model, input: [start image?, end image?, text], response_format: { type: "video",
 *        aspect_ratio: "9:16", resolution }, background: true, store: true, previous_interaction_id? }
 *   GET  /v1beta/interactions/{id}  until status "completed", the video in a model_output step as base64.
 *
 * The first image part is the start frame and a second one the end frame; `previous_interaction_id` extends an earlier
 * take with its footage as context (store must stay true so a take can be extended later). There is no duration field:
 * the length is asked for in the prompt, and the take is measured when it arrives. Resolution is fixed when the take is
 * made (no upscaling an earlier take), so a final is a new take. Authenticated with the deployment's Gemini API key;
 * Vertex offers this model only on provisioned throughput, not pay-as-you-go.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta";
/** Prefixed on the stored operation name, so the poller knows the provider. */
export const OMNI_OPERATION = "omni:";

export type OmniImage = { bytesBase64Encoded: string; mimeType: string };

/** The key, or "" when absent: an empty Terraform value is stored in Parameter Store as "unset". */
export function omniKey(): string {
  const key = process.env.GEMINI_API_KEY ?? "";
  return key === "unset" ? "" : key;
}

export function omniConfigured(): boolean {
  return omniKey() !== "";
}

/** The interaction's request body (exported for tests). */
export function omniRequest(input: { model: string; prompt: string; resolution: "360p" | "720p" | "1080p"; durationSeconds: number; image?: OmniImage; lastFrame?: OmniImage; previousInteractionId?: string }) {
  const text = `${input.prompt} The clip is about ${input.durationSeconds} seconds long, vertical 9:16.`;
  const images = input.previousInteractionId ? [] : [input.image, input.lastFrame].filter((i): i is OmniImage => Boolean(i));
  return {
    model: input.model,
    input: images.length ? [...images.map((i) => ({ type: "image", data: i.bytesBase64Encoded, mime_type: i.mimeType })), { type: "text", text }] : text,
    response_format: { type: "video", aspect_ratio: "9:16", resolution: input.resolution },
    background: true,
    store: true,
    ...(input.previousInteractionId ? { previous_interaction_id: input.previousInteractionId } : {}),
  };
}

/** The finished video in an interaction, wherever the response puts it: a step's content with type "video" and data or uri. */
export function videoOf(interaction: unknown): { data?: string; uri?: string; mimeType?: string } | null {
  const seen = new Set<unknown>();
  const visit = (node: unknown): { data?: string; uri?: string; mimeType?: string } | null => {
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    const o = node as Record<string, unknown>;
    if (o.type === "video" && (typeof o.data === "string" || typeof o.uri === "string")) {
      return { ...(typeof o.data === "string" ? { data: o.data } : {}), ...(typeof o.uri === "string" ? { uri: o.uri } : {}), ...(typeof o.mime_type === "string" ? { mimeType: o.mime_type } : {}) };
    }
    for (const value of Object.values(o)) {
      const found = visit(value);
      if (found) return found;
    }
    return null;
  };
  return visit(interaction);
}

export class OmniVideo {
  constructor(private readonly key = omniKey()) {}

  private async call(method: "GET" | "POST", path: string, body?: unknown) {
    if (!this.key) throw new Error("Gemini Omni is not configured (GEMINI_API_KEY).");
    const response = await fetch(`${BASE}${path}`, {
      method, headers: { "x-goog-api-key": this.key, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // Deliberately no retry on the POST: repeating a timed-out create can charge twice (as for Veo).
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      // Never persist provider bodies; only the canonical status is read.
      const reason = await response.json().then((b: { error?: { status?: unknown } }) => typeof b?.error?.status === "string" ? b.error.status : undefined, () => undefined);
      throw new VertexError(`Gemini returned HTTP ${response.status}${reason ? ` (${reason})` : ""}.`, response.status, reason);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  /** Starts a take; returns the stored operation name (`omni:<interaction id>`). */
  async submit(input: Parameters<typeof omniRequest>[0]): Promise<string> {
    const result = await this.call("POST", "/interactions", omniRequest(input));
    if (typeof result.id !== "string") throw new Error("Gemini did not return an interaction.");
    return `${OMNI_OPERATION}${result.id}`;
  }

  async poll(operationName: string): Promise<{ done: boolean; video?: Buffer; error?: string }> {
    const id = operationName.slice(OMNI_OPERATION.length);
    const result = await this.call("GET", `/interactions/${encodeURIComponent(id)}`);
    const status = String(result.status ?? "");
    if (status === "failed" || status === "cancelled" || status === "incomplete") {
      return { done: true, error: "No video was returned. Try a different prompt; your credit was returned." };
    }
    if (status !== "completed") return { done: false };
    const video = videoOf(result);
    let buffer: Buffer | null = null;
    if (video?.data) buffer = Buffer.from(video.data, "base64");
    else if (video?.uri) {
      const file = await fetch(video.uri, { headers: { "x-goog-api-key": this.key }, signal: AbortSignal.timeout(120_000) });
      if (file.ok) buffer = Buffer.from(await file.arrayBuffer());
    }
    if (!buffer) {
      console.warn(`omni-video: no video in interaction ${id} (blocked or empty)`);
      return { done: true, error: "No video was returned. Try a different prompt; your credit was returned." };
    }
    if (buffer.length < 100 || buffer.length > 100 * 1024 * 1024) return { done: true, error: "The video was unreadable. Your credit was returned." };
    return { done: true, video: buffer };
  }
}
