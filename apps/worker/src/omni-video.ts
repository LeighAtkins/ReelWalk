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
 * made (no upscaling an earlier take), so a final is a new take. Signed with the deployment's Gemini authorization key,
 * bound to the worker's service account (ADR 0105); Vertex offers this model only on provisioned throughput.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta";
/** Prefixed on the stored operation name, so the poller knows the provider. */
export const OMNI_OPERATION = "omni:";

export type OmniImage = { bytesBase64Encoded: string; mimeType: string };

/** A request that never left the worker (no credentials to sign it): certainly nothing was made or charged. */
export class OmniNotSent extends Error {}

/**
 * Google's codes from an error body, never its text: the canonical status and the details' reasons (SERVICE_DISABLED,
 * ACCESS_TOKEN_SCOPE_INSUFFICIENT, IAM_PERMISSION_DENIED…), which say what to fix. Exported for tests.
 */
export function errorCodes(body: unknown): { status?: string; reasons: string[] } {
  const error = (body as { error?: { status?: unknown; details?: unknown } } | null)?.error;
  const status = typeof error?.status === "string" ? error.status : undefined;
  const reasons = Array.isArray(error?.details)
    ? error.details.map((d) => (d && typeof d === "object" ? (d as { reason?: unknown }).reason : undefined)).filter((r): r is string => typeof r === "string" && /^[A-Z_]{3,60}$/.test(r))
    : [];
  return { ...(status ? { status } : {}), reasons };
}

/**
 * Whether a failed create certainly made nothing. Unlike Veo's (which needs a named rejection code), any 4xx but a
 * timeout is a refusal here: the Interactions endpoint has answered 403 with no canonical status, and an interaction
 * that was refused was never created. A request that never left is a refusal too.
 */
export function omniRefused(error: unknown): boolean {
  if (error instanceof OmniNotSent) return true;
  return error instanceof VertexError && error.status >= 400 && error.status < 500 && error.status !== 408;
}

/** The key, or "" when absent: an empty Terraform value is stored in Parameter Store as "unset". */
export function omniKey(): string {
  const key = process.env.GEMINI_API_KEY ?? "";
  return key === "unset" ? "" : key;
}

export function omniConfigured(): boolean {
  return omniKey() !== "";
}

/**
 * How a request is signed: with the authorization key when there is one (the way that works), else with the worker's
 * own Google token billed to GOOGLE_CLOUD_PROJECT. Google refuses service-account tokens for the Gemini API ("Access to
 * Gemini API is restricted with service accounts", measured 2026-11-01, ADR 0105), so the fallback only ever reaches a
 * clear 403 refusal; it stays for credentials Google may still accept, such as a user's in local development.
 */
export async function omniHeaders(key: string, token?: () => Promise<string | null | undefined>): Promise<Record<string, string>> {
  if (key) return { "x-goog-api-key": key };
  const bearer = token ? await token().catch((error: unknown) => { throw new OmniNotSent(`Google credentials could not be refreshed (${error instanceof Error ? error.message : "unknown"}).`); }) : null;
  if (!bearer) throw new OmniNotSent("Gemini Omni has no API key and no Google credentials.");
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  return { Authorization: `Bearer ${bearer}`, ...(project ? { "x-goog-user-project": project } : {}) };
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
  constructor(private readonly key = omniKey(), private readonly token?: () => Promise<string | null | undefined>) {}

  private async call(method: "GET" | "POST", path: string, body?: unknown) {
    const auth = await omniHeaders(this.key, this.token);
    const response = await fetch(`${BASE}${path}`, {
      method, headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // Deliberately no retry on the POST: repeating a timed-out create can charge twice (as for Veo).
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      // Never persist provider bodies; only the canonical status is read.
      const codes = await response.json().then(errorCodes, () => ({ reasons: ["NON_JSON_BODY"] } as { status?: string; reasons: string[] }));
      const named = [codes.status, ...codes.reasons].filter(Boolean).join(", ");
      throw new VertexError(`Gemini returned HTTP ${response.status}${named ? ` (${named})` : ""}.`, response.status, codes.status);
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
      const file = await fetch(video.uri, { headers: await omniHeaders(this.key, this.token), signal: AbortSignal.timeout(120_000) });
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
