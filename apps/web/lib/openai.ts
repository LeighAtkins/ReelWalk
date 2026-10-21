/** Server-only structured editing answers. Claude is selected when configured;
 * the existing OpenAI transport remains available for explicit rollback. */

import { beforeProviderRequest, providerAnswered, providerSignal } from "./provider-gate";

export const DEFAULT_AI_MODEL = "gpt-6-luna";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

function configuredKey(name: string): string | undefined {
  const key = process.env[name]?.trim();
  return key && key !== "unset" ? key : undefined;
}

export function aiProvider(): "anthropic" | "openai" {
  const provider = process.env.AI_PROVIDER?.trim();
  if (provider && provider !== "anthropic" && provider !== "openai") throw new AiError("Unknown AI provider configuration.", false);
  return provider === "anthropic" || provider === "openai" ? provider : (configuredKey("ANTHROPIC_API_KEY") ? "anthropic" : "openai");
}

export function aiModel(): string {
  return aiProvider() === "anthropic"
    ? process.env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_MODEL
    : process.env.OPENAI_MODEL || DEFAULT_AI_MODEL;
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
  return Boolean(configuredKey(aiProvider() === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"));
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
  if (aiProvider() === "anthropic") return claudeAnswer(options);
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

async function claudeAnswer(options: AnswerOptions): Promise<{ json: unknown; usage: AiUsage; model: string }> {
  const key = configuredKey("ANTHROPIC_API_KEY");
  if (!key) throw new AiError("Claude editing is not configured on this deployment.", false);
  const model = aiModel();
  const wire = claudeEditWire(options);
  // Only owned, preprocessed image data is accepted. Never make the provider fetch arbitrary URLs.
  const images = (options.images ?? []).map((url) => {
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match) throw new AiError("The editing image is not a supported image data URL.", false);
    return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  });
  await beforeProviderRequest();
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        // Opus 5.5 always thinks; leave room for reasoning as well as the edit JSON.
        max_tokens: Math.min(32000, Math.max(4096, (options.maxOutputTokens ?? 1200) + 2048)),
        system: wire?.instructions ?? options.instructions,
        messages: [{ role: "user", content: [{ type: "text", text: options.input }, ...images] }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: wire?.schema ?? options.schema } },
      }),
      signal: providerSignal(options.signal ?? AbortSignal.timeout(60_000)),
    });
  } catch {
    throw new AiError("Could not reach Claude.", true);
  }
  providerAnswered();
  const data = await response.json().catch(() => ({})) as {
    stop_reason?: string; model?: string; content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  if (!response.ok) {
    // Do not echo provider error bodies: they can contain request content or credentials.
    throw new AiError(`Claude could not answer (HTTP ${response.status}).`, response.status === 429 || response.status >= 500);
  }
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

/** What a call cost in dollars, from the model's list price, for logs and the admin page. */
export function usageCostUsd(model: string, usage: AiUsage): number {
  const prices: Record<string, { input: number; cached: number; output: number; cacheWrite?: number }> = {
    "claude-opus-5-5": { input: 4, cached: 0.2, cacheWrite: 5, output: 20 },
    "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
    "gpt-6-sol": { input: 2, cached: 0.2, output: 10 },
    "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  };
  const price = prices[model.replace(/^openai\//, "")] ?? prices[DEFAULT_AI_MODEL];
  const fresh = Math.max(0, usage.inputTokens - usage.cachedTokens - (usage.cacheWriteTokens ?? 0));
  return (fresh * price.input + usage.cachedTokens * price.cached + usage.outputTokens * price.output + (usage.cacheWriteTokens ?? 0) * (price.cacheWrite ?? price.input)) / 1_000_000;
}
