/**
 * The one call ReelWalk makes to OpenAI: a structured answer from the
 * Responses API (ADR 0020). Plain fetch, no SDK: one endpoint, one shape.
 *
 * OPENAI_API_KEY turns it on. OPENAI_MODEL picks the model; the default is
 * gpt-6-luna ($0.10 / $0.50 per million tokens), the cheapest; gpt-6.1-sol
 * ($2 / $10, cached input $0.10) is the step up if Luna misreads requests. With
 * no key, DEV_FAKE_AI=true makes the app answer from rules instead, so local
 * stacks and tests can exercise the whole path.
 */

export const DEFAULT_AI_MODEL = "gpt-6-luna";

export function aiModel(): string {
  return process.env.OPENAI_MODEL || DEFAULT_AI_MODEL;
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function isFakeAi(): boolean {
  return process.env.DEV_FAKE_AI === "true" && !isAiConfigured();
}

/** Asking for changes is offered when either the real model or the stand-in is there. */
export function isAiAvailable(): boolean {
  return isAiConfigured() || isFakeAi();
}

export type AiUsage = { inputTokens: number; cachedTokens: number; outputTokens: number };

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
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): Promise<{ json: unknown; usage: AiUsage; model: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new AiError("Asking for changes is not set up on this deployment.", false);
  const model = aiModel();
  const body: Record<string, unknown> = {
    model,
    instructions: options.instructions,
    input: options.input,
    text: { format: { type: "json_schema", name: options.schemaName, schema: options.schema, strict: true } },
    max_output_tokens: options.maxOutputTokens ?? 1200,
    store: false,
  };
  // Sol and Astra reason before answering; a short think is plenty for an edit list.
  // Luna is sent no reasoning setting, in case it does not take one.
  if (/^gpt-6(\.\d+)?-(sol|astra)/.test(model)) body.reasoning = { effort: "low" };

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new AiError(`Could not reach the model: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  const data = (await response.json().catch(() => ({}))) as ResponsesOutput;
  if (!response.ok) {
    const message = data.error?.message ?? `HTTP ${response.status}`;
    throw new AiError(`The model refused the request: ${message}`, response.status === 429 || response.status >= 500);
  }
  if (data.status && data.status !== "completed") {
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

/** What a call cost in dollars, from the model's list price, for logs and the admin page. */
export function usageCostUsd(model: string, usage: AiUsage): number {
  const prices: Record<string, { input: number; cached: number; output: number }> = {
    "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
    "gpt-6-sol": { input: 2, cached: 0.2, output: 10 },
    "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  };
  const price = prices[model] ?? prices[DEFAULT_AI_MODEL];
  const fresh = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (fresh * price.input + usage.cachedTokens * price.cached + usage.outputTokens * price.output) / 1_000_000;
}
