/** Server-only structured editing answers. Claude is selected when configured,
 * directly or through Google Cloud (Vertex AI, ADR 0072); the existing OpenAI
 * transport remains available for explicit rollback. */

// Type-only: the worker loads this module through its durable AI steps (ADR 0049) and its image carries
// only the worker's dependencies. The Vertex SDK is loaded on first use, inside `vertexClient`.
import type { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { AuthClient } from "google-auth-library";
import { assertAiOn } from "./ai-gate";
import { defaultGoogleAuth, federatedGoogleAuth } from "./google-federation";
import { beforeProviderRequest, providerAnswered, providerSignal } from "./provider-gate";

export const DEFAULT_AI_MODEL = "gpt-6-luna";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

function configuredKey(name: string): string | undefined {
  const key = process.env[name]?.trim();
  return key && key !== "unset" ? key : undefined;
}

export type AiProvider = "anthropic" | "openai" | "vertex";

/** Where the Claude on Vertex requests go: the global endpoint unless a region is set (ADR 0072). */
export const DEFAULT_VERTEX_CLAUDE_REGION = "global";

/**
 * The provider for "ask for a change": set explicitly with AI_PROVIDER, or
 * Claude direct when its key is there, else OpenAI. Vertex is never chosen
 * implicitly: billing through Google is a deliberate switch and its rollback
 * is `AI_PROVIDER=anthropic`.
 */
export function aiProvider(): AiProvider {
  const provider = process.env.AI_PROVIDER?.trim();
  if (provider === "anthropic" || provider === "openai" || provider === "vertex") return provider;
  if (provider) throw new AiError("Unknown AI provider configuration.", false);
  return configuredKey("ANTHROPIC_API_KEY") ? "anthropic" : "openai";
}

export function aiModel(): string {
  return aiProvider() === "openai"
    ? process.env.OPENAI_MODEL || DEFAULT_AI_MODEL
    : process.env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_MODEL;
}

/**
 * Claude on Google Cloud needs the project and a way to get a Google token:
 * the workload identity federation the worker already uses for Veo (both
 * variables), or application default credentials for local development.
 * Returns null when any of that is missing, so the feature fails closed.
 */
export function vertexConfig(): { projectId: string; region: string; federation: { audience: string; email: string } | null } | null {
  const projectId = configuredKey("GOOGLE_CLOUD_PROJECT");
  if (!projectId) return null;
  const region = configuredKey("VERTEX_CLAUDE_REGION") ?? DEFAULT_VERTEX_CLAUDE_REGION;
  const audience = configuredKey("GOOGLE_WORKLOAD_IDENTITY_AUDIENCE");
  const email = configuredKey("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  if (audience && email) return { projectId, region, federation: { audience, email } };
  if (!audience && !email && configuredKey("GOOGLE_APPLICATION_CREDENTIALS")) return { projectId, region, federation: null };
  return null;
}

function viaOpenRouter(): boolean {
  return (process.env.OPENAI_API_KEY ?? "").startsWith("sk-or-");
}

/** Where the Responses endpoint is: OpenAI, or OpenRouter for its keys. */
export function aiBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL || (viaOpenRouter() ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1")).replace(/\/$/, "");
}

/** The model id the provider expects: OpenRouter wants the "openai/" prefix. */
function providerModel(model: string): string {
  return viaOpenRouter() && !model.includes("/") ? `openai/${model}` : model;
}

export function isAiConfigured(): boolean {
  const provider = aiProvider();
  if (provider === "vertex") return vertexConfig() !== null;
  return Boolean(configuredKey(provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"));
}

export function isFakeAi(): boolean {
  return process.env.DEV_FAKE_AI === "true" && !isAiConfigured();
}

/** Asking for changes is offered when either the real model or the stand-in is there. */
export function isAiAvailable(): boolean {
  return isAiConfigured() || isFakeAi();
}

export type AiUsage = { inputTokens: number; cachedTokens: number; outputTokens: number; cacheWriteTokens?: number };

export class AiError extends Error {
  constructor(
    message: string,
    /** True when trying again later may help (rate limit, outage), false for a bad request. */
    public readonly transient: boolean,
  ) {
    super(message);
    this.name = "AiError";
  }
}

type ResponsesOutput = {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
};

/**
 * Asks the model for a JSON object that fits `schema` (strict structured
 * output). `instructions` is the fixed part and goes first so the provider
 * can cache it across calls; `input` is what changes.
 */
export async function structuredAnswer(options: {
  /** Whose AI switch and allowance this request is under (ADR 0079). Required, so no caller can forget the gate. */
  workspaceId: string;
  instructions: string;
  input: string;
  /** Pictures for the model to look at, as data: URLs, sent at low detail. */
  images?: string[];
  /** "high" when the model must read small detail (positions on a grid); costs more tokens. */
  imageDetail?: "low" | "high";
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): Promise<{ json: unknown; usage: AiUsage; model: string }> {
  // A workspace with AI generation off never reaches a provider: this is the one door every model call goes through.
  await assertAiOn(options.workspaceId);
  const provider = aiProvider();
  if (provider === "anthropic") return claudeAnswer(options);
  if (provider === "vertex") return vertexAnswer(options);
  const key = configuredKey("OPENAI_API_KEY");
  if (!key) throw new AiError("Asking for changes is not set up on this deployment.", false);
  const model = aiModel();
  const body: Record<string, unknown> = {
    model: providerModel(model),
    instructions: options.instructions,
    input: options.images?.length
      ? [
          {
            role: "user",
            content: [{ type: "input_text", text: options.input }, ...options.images.map((url) => ({ type: "input_image", image_url: url, detail: options.imageDetail ?? "low" }))],
          },
        ]
      : options.input,
    text: { format: { type: "json_schema", name: options.schemaName, schema: options.schema, strict: true } },
    max_output_tokens: options.maxOutputTokens ?? 1200,
    store: false,
  };
  // Sol and Astra reason before answering; a short think is plenty for an edit list.
  // Luna is sent no reasoning setting, in case it does not take one.
  if (/gpt-6(\.\d+)?-(sol|astra)/.test(model)) body.reasoning = { effort: "low" };

  await beforeProviderRequest();
  let response: Response;
  try {
    response = await fetch(`${aiBaseUrl()}/responses`, {
      method: "POST",
      // The last two headers are OpenRouter's attribution; OpenAI ignores them.
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "http-referer": "https://reelwalking.com", "x-title": "ReelWalk" },
      body: JSON.stringify(body),
      signal: providerSignal(options.signal ?? AbortSignal.timeout(60_000)),
    });
  } catch (error) {
    throw new AiError(`Could not reach the model: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  providerAnswered();
  const data = (await response.json().catch(() => ({}))) as ResponsesOutput;
  if (!response.ok) {
    const message = data.error?.message ?? `HTTP ${response.status}`;
    throw new AiError(`The model refused the request: ${message}`, response.status === 429 || response.status >= 500);
  }
  if (data.status && data.status !== "completed") {
    const partial = data.output?.find((item) => item.type === "message")?.content?.[0]?.text ?? "";
    console.error("ai: incomplete answer", data.incomplete_details?.reason, JSON.stringify(data.usage), partial.slice(0, 400));
    throw new AiError(`The model stopped early (${data.incomplete_details?.reason ?? data.status}).`, true);
  }
  const message = data.output?.find((item) => item.type === "message");
  const part = message?.content?.find((item) => item.type === "output_text" || item.type === "refusal");
  if (!part || part.type === "refusal") throw new AiError(part?.refusal ? `The model declined: ${part.refusal}` : "The model sent no answer.", false);
  let json: unknown;
  try {
    json = JSON.parse(part.text ?? "");
  } catch {
    throw new AiError("The model's answer was not valid JSON.", true);
  }
  return {
    json,
    model,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      cachedTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}

type AnswerOptions = Parameters<typeof structuredAnswer>[0];

/** Claude limits union-heavy schemas. Encode each operation's arguments as JSON,
 * then restore the existing plan shape for the caller's unchanged Zod validation. */
function editPlanWire(editSchema: Record<string, unknown>) {
  const properties = editSchema.properties as Record<string, Record<string, unknown>>;
  const items = properties.ops.items as Record<string, unknown>;
  const opProperties = items.properties as Record<string, unknown>;
  return {
    schema: { ...editSchema, properties: { ...properties, ops: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["op", "arguments"],
      properties: { op: opProperties.op, arguments: { type: "string", description: "A JSON object containing only the relevant non-null operation fields. For example: {\"clip\":1,\"speed\":1}" } },
    } } } },
    instructions: `Transport format: each ops item has op and arguments. arguments is a JSON-encoded object with the relevant fields from this operation schema; omit unused fields, which become null. Never put op inside arguments. The editor validates every decoded field before applying. Operation fields: ${JSON.stringify(opProperties)}`,
    decode(json: unknown): unknown {
      if (!json || typeof json !== "object" || !Array.isArray((json as { ops?: unknown }).ops)) throw new AiError("Claude sent an invalid edit plan.", false);
      const plan = json as { ops: Array<{ op?: unknown; arguments?: unknown }> };
      return { ...plan, ops: plan.ops.map(operation => {
        if (typeof operation.arguments !== "string") throw new AiError("Claude sent invalid operation arguments.", false);
        let args: unknown;
        try { args = JSON.parse(operation.arguments); } catch { throw new AiError("Claude sent invalid operation JSON.", false); }
        if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key === "op" || !Object.hasOwn(opProperties, key))) throw new AiError("Claude sent unknown operation fields.", false);
        return { ...Object.fromEntries((items.required as string[]).map(key => [key, null])), ...args, op: operation.op };
      }) };
    },
  };
}

/** The edit plan sits at the root of an edit request and under `edit` in a director review. */
function claudeEditWire(options: AnswerOptions) {
  if (options.schemaName === "reel_edit_plan") {
    const wire = editPlanWire(options.schema);
    return { schema: wire.schema, instructions: `${options.instructions}\n${wire.instructions}`, decode: wire.decode };
  }
  if (options.schemaName === "opus_director") {
    const properties = options.schema.properties as Record<string, Record<string, unknown>>;
    const wire = editPlanWire(properties.edit);
    return {
      schema: { ...options.schema, properties: { ...properties, edit: wire.schema } },
      instructions: `${options.instructions}\nThe edit object uses this transport. ${wire.instructions}`,
      decode(json: unknown): unknown {
        if (!json || typeof json !== "object") throw new AiError("Claude sent an invalid director review.", false);
        return { ...json, edit: wire.decode((json as { edit?: unknown }).edit) };
      },
    };
  }
  return null;
}

type ClaudeImage = { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } };
type ClaudeMessage = {
  stop_reason?: string | null; model?: string; content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
};

/** The one request both Claude routes send: system, a user turn with optional pictures, strict JSON output, medium effort. */
function claudeRequest(options: AnswerOptions, model: string) {
  const wire = claudeEditWire(options);
  // Only owned, preprocessed image data is accepted. Never make the provider fetch arbitrary URLs.
  const images: ClaudeImage[] = (options.images ?? []).map((url) => {
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match) throw new AiError("The editing image is not a supported image data URL.", false);
    return { type: "image", source: { type: "base64", media_type: match[1] as ClaudeImage["source"]["media_type"], data: match[2] } };
  });
  return {
    wire,
    body: {
      model,
      // Opus 5.5 always thinks; leave room for reasoning as well as the edit JSON.
      max_tokens: Math.min(32000, Math.max(4096, (options.maxOutputTokens ?? 1200) + 2048)),
      system: wire?.instructions ?? options.instructions,
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: options.input }, ...images] }],
      output_config: { effort: "medium" as const, format: { type: "json_schema" as const, schema: wire?.schema ?? options.schema } },
    },
  };
}

/** Reads the JSON answer and the token counts out of a Claude message, from either route. */
function decodeClaudeMessage(data: ClaudeMessage, wire: ReturnType<typeof claudeEditWire>, model: string): { json: unknown; usage: AiUsage; model: string } {
  if (data.stop_reason === "refusal") throw new AiError("Claude declined this edit request.", false);
  if (data.stop_reason === "max_tokens") throw new AiError("Claude ran out of room before finishing the plan.", false);
  if (data.stop_reason !== "end_turn") throw new AiError("Claude stopped before completing the edit plan.", false);
  const text = data.content?.filter(part => part.type === "text").map(part => part.text ?? "").join("");
  let json: unknown;
  try { json = JSON.parse(text ?? ""); } catch { throw new AiError("Claude's answer was not valid edit JSON.", false); }
  const usage = data.usage;
  const cachedTokens = usage?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  return { json: wire ? wire.decode(json) : json, model: data.model ?? model, usage: {
    inputTokens: (usage?.input_tokens ?? 0) + cachedTokens + cacheWriteTokens,
    outputTokens: usage?.output_tokens ?? 0, cachedTokens, cacheWriteTokens,
  } };
}

async function claudeAnswer(options: AnswerOptions): Promise<{ json: unknown; usage: AiUsage; model: string }> {
  const key = configuredKey("ANTHROPIC_API_KEY");
  if (!key) throw new AiError("Claude editing is not configured on this deployment.", false);
  const model = aiModel();
  const { wire, body } = claudeRequest(options, model);
  await beforeProviderRequest();
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: providerSignal(options.signal ?? AbortSignal.timeout(60_000)),
    });
  } catch {
    throw new AiError("Could not reach Claude.", true);
  }
  providerAnswered();
  const data = await response.json().catch(() => ({})) as ClaudeMessage;
  if (!response.ok) {
    // Do not echo provider error bodies: they can contain request content or credentials.
    throw new AiError(`Claude could not answer (HTTP ${response.status}).`, response.status === 429 || response.status >= 500);
  }
  return decodeClaudeMessage(data, wire, model);
}

// One client per configuration: the Google auth client inside it caches and refreshes the federated token.
const vertexClients = new Map<string, Promise<AnthropicVertex>>();

async function vertexClient(config: NonNullable<ReturnType<typeof vertexConfig>>): Promise<AnthropicVertex> {
  const key = JSON.stringify(config);
  let client = vertexClients.get(key);
  if (!client) {
    client = (async () => {
      let authClient: AuthClient;
      if (config.federation) {
        const { awsCredentials } = await import("./storage");
        authClient = federatedGoogleAuth(awsCredentials(), config.federation.audience, config.federation.email);
      } else {
        authClient = await defaultGoogleAuth();
      }
      // No SDK retries: inside a durable AI step an unanswered request must never be sent twice (ADR 0049);
      // the callers that may retry do so themselves after checking the gate.
      // The SDK types its authClient against google-auth-library 10; the app shares the worker's 11. Same AuthClient
      // surface (getRequestHeaders), so the cast is safe; a mismatch would fail the first call, not silently.
      type VertexAuthClient = NonNullable<NonNullable<ConstructorParameters<typeof AnthropicVertex>[0]>["authClient"]>;
      const { AnthropicVertex: VertexClient } = await import("@anthropic-ai/vertex-sdk");
      return new VertexClient({ projectId: config.projectId, region: config.region, authClient: authClient as unknown as VertexAuthClient, maxRetries: 0, timeout: 60_000 });
    })();
    vertexClients.set(key, client);
    client.catch(() => vertexClients.delete(key));
  }
  return client;
}

/** Why a Vertex call failed, as the app's error: retry later for rate limits, outages and dropped connections; not for a bad request. */
export function vertexError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  // Status codes only: SDK messages carry the provider body, which can echo request content.
  // The SDK's error classes are recognised by name along the prototype chain rather than by `instanceof`,
  // so this module never needs the SDK loaded (the worker's image does not carry it).
  const lineage = new Set<string>();
  for (let proto = error && typeof error === "object" ? Object.getPrototypeOf(error) : null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    if (typeof proto.constructor?.name === "string") lineage.add(proto.constructor.name);
  }
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
  if (lineage.has("RateLimitError") || lineage.has("InternalServerError")) return new AiError(`Claude on Google Cloud could not answer (HTTP ${status}).`, true);
  if (lineage.has("APIConnectionError")) return new AiError("Could not reach Claude on Google Cloud.", true);
  if (lineage.has("APIError")) return new AiError(`Claude on Google Cloud could not answer (HTTP ${status ?? "error"}).`, (status ?? 500) >= 500);
  if (error instanceof Error && error.name === "AbortError") return new AiError("Could not reach Claude on Google Cloud.", true);
  return new AiError("Claude on Google Cloud could not be reached with these Google credentials.", true);
}

/** Claude through Vertex AI (ADR 0072): the same request as `claudeAnswer`, sent by the official client with a Google token. */
async function vertexAnswer(options: AnswerOptions): Promise<{ json: unknown; usage: AiUsage; model: string }> {
  const config = vertexConfig();
  if (!config) throw new AiError("Claude on Google Cloud is not configured on this deployment.", false);
  const model = aiModel();
  const { wire, body } = claudeRequest(options, model);
  await beforeProviderRequest();
  let data: ClaudeMessage;
  try {
    const client = await vertexClient(config);
    data = await client.messages.create(body, { signal: providerSignal(options.signal ?? AbortSignal.timeout(60_000)) });
  } catch (error) {
    // The SDK answered (with an error) or gave up: either way the request is no longer in doubt.
    providerAnswered();
    throw vertexError(error);
  }
  providerAnswered();
  return decodeClaudeMessage(data, wire, model);
}

// ── Tool turns (ADR 0095) ────────────────────────────────────────

/** A content block of a Claude message, kept as sent and as answered (thinking blocks go back unchanged). */
export type ToolTurnBlock = { type: string } & Record<string, unknown>;
export type ToolTurnMessage = { role: "user" | "assistant"; content: ToolTurnBlock[] };
export type ToolTurnTool = { name: string; description: string; input_schema: Record<string, unknown> };
export type ToolTurn = { content: ToolTurnBlock[]; stopReason: string; usage: AiUsage; model: string };
export type ToolTurnOptions = {
  /** Whose AI switch this request is under (ADR 0079). */
  workspaceId: string;
  system: string;
  tools: ToolTurnTool[];
  /** The whole conversation so far, append-only. */
  messages: ToolTurnMessage[];
  /** "none" asks for the final answer without another tool call. */
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  signal?: AbortSignal;
};

/**
 * One turn of a Claude tool-use conversation (the reel notes agent, ADR
 * 0095), through the same provider, gate and AI switch as `structuredAnswer`.
 * Claude only: the OpenAI transport has no tool loop here. The system prompt
 * and the tools are one cache breakpoint; the growing conversation is cached
 * automatically, so each turn pays fresh input only for what was added.
 */
export async function claudeToolTurn(options: ToolTurnOptions): Promise<ToolTurn> {
  await assertAiOn(options.workspaceId);
  const provider = aiProvider();
  if (provider === "openai") throw new AiError("Notes need Claude, which is not configured on this deployment.", false);
  const model = aiModel();
  const body = {
    model,
    max_tokens: options.maxTokens ?? 16000,
    system: [{ type: "text" as const, text: options.system, cache_control: { type: "ephemeral" as const } }],
    tools: options.tools,
    tool_choice: { type: options.toolChoice ?? "auto" },
    messages: options.messages,
    cache_control: { type: "ephemeral" as const },
    output_config: { effort: "medium" as const },
  };
  const signal = providerSignal(options.signal ?? AbortSignal.timeout(180_000));
  await beforeProviderRequest();
  let data: Omit<ClaudeMessage, "content"> & { content?: ToolTurnBlock[] };
  if (provider === "vertex") {
    const config = vertexConfig();
    if (!config) throw new AiError("Claude on Google Cloud is not configured on this deployment.", false);
    try {
      const client = await vertexClient(config);
      data = (await client.messages.create(body as never, { signal })) as unknown as typeof data;
    } catch (error) {
      providerAnswered();
      throw vertexError(error);
    }
  } else {
    const key = configuredKey("ANTHROPIC_API_KEY");
    if (!key) throw new AiError("Claude editing is not configured on this deployment.", false);
    let response: Response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new AiError("Could not reach Claude.", true);
    }
    data = (await response.json().catch(() => ({}))) as typeof data;
    if (!response.ok) {
      providerAnswered();
      // Do not echo provider error bodies: they can contain request content or credentials.
      throw new AiError(`Claude could not answer (HTTP ${response.status}).`, response.status === 429 || response.status >= 500);
    }
  }
  providerAnswered();
  if (data.stop_reason === "refusal") throw new AiError("Claude declined this note.", false);
  const usage = data.usage;
  const cachedTokens = usage?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  return {
    content: data.content ?? [],
    stopReason: data.stop_reason ?? "end_turn",
    model: data.model ?? model,
    usage: { inputTokens: (usage?.input_tokens ?? 0) + cachedTokens + cacheWriteTokens, outputTokens: usage?.output_tokens ?? 0, cachedTokens, cacheWriteTokens },
  };
}

/** Token counts of several calls added up. */
export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, cachedTokens: a.cachedTokens + b.cachedTokens, outputTokens: a.outputTokens + b.outputTokens, cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) };
}

/**
 * Google's list prices for Claude at the global endpoint equal Anthropic's;
 * its regional endpoints (us-east5, europe-west1, ...) are listed 10% higher
 * (cloud.google.com/vertex-ai/generative-ai/pricing, read 2026-10-23).
 */
export function vertexPriceFactor(region: string): number {
  return region === "global" ? 1 : 1.1;
}

/** What a call cost in dollars, from the model's list price, for logs and the admin page. */
export function usageCostUsd(model: string, usage: AiUsage, options: { provider?: AiProvider; vertexRegion?: string } = {}): number {
  const prices: Record<string, { input: number; cached: number; output: number; cacheWrite?: number }> = {
    "claude-opus-5-5": { input: 4, cached: 0.2, cacheWrite: 5, output: 20 },
    "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
    "gpt-6-sol": { input: 2, cached: 0.2, output: 10 },
    "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  };
  const price = prices[model.replace(/^openai\//, "")] ?? prices[DEFAULT_AI_MODEL];
  const fresh = Math.max(0, usage.inputTokens - usage.cachedTokens - (usage.cacheWriteTokens ?? 0));
  const factor = options.provider === "vertex" ? vertexPriceFactor(options.vertexRegion ?? vertexConfig()?.region ?? DEFAULT_VERTEX_CLAUDE_REGION) : 1;
  return factor * (fresh * price.input + usage.cachedTokens * price.cached + usage.outputTokens * price.output + (usage.cacheWriteTokens ?? 0) * (price.cacheWrite ?? price.input)) / 1_000_000;
}
