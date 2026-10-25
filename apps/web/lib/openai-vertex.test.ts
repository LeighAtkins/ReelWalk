/** Claude through Google Cloud (ADR 0072): provider selection, configuration detection, the request the
 * official client is given, error mapping and pricing. The Vertex client and the Google auth are mocked;
 * nothing here reaches a network. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { AI_EDIT_PLAN_JSON_SCHEMA, aiEditPlanSchema } from "@reelwalk/core";

const vertex = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown>>,
  create: vi.fn<(body: unknown, options: unknown) => Promise<unknown>>(),
}));
vi.mock("@anthropic-ai/vertex-sdk", () => ({
  AnthropicVertex: class {
    messages = { create: vertex.create };
    constructor(options: Record<string, unknown>) { vertex.constructed.push(options); }
  },
}));
const auth = vi.hoisted(() => ({ federated: vi.fn(), adc: vi.fn() }));
vi.mock("./google-federation", () => ({
  federatedGoogleAuth: (...args: unknown[]) => { auth.federated(...args); return { kind: "federated" }; },
  defaultGoogleAuth: async () => { auth.adc(); return { kind: "adc" }; },
}));
// The workspace AI switch has its own tests (ai-off.test.ts); here every workspace has AI on.
vi.mock("./ai-gate", () => ({ assertAiOn: async () => undefined }));
vi.mock("./storage", () => ({ awsCredentials: () => async () => ({ accessKeyId: "AKIA-test", secretAccessKey: "test", sessionToken: "t" }) }));

import { aiModel, aiProvider, isAiConfigured, structuredAnswer, usageCostUsd, vertexConfig, vertexError, vertexPriceFactor } from "./openai";

const env = { ...process.env };
const originalFetch = globalThis.fetch;
let project = 0;
/** A fresh project id per test so the module's per-configuration client cache does not carry over. */
function configure(extra: Record<string, string | undefined> = {}) {
  for (const key of ["AI_PROVIDER", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "OPENAI_API_KEY", "GOOGLE_CLOUD_PROJECT", "VERTEX_CLAUDE_REGION", "GOOGLE_WORKLOAD_IDENTITY_AUDIENCE", "GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_APPLICATION_CREDENTIALS"]) delete process.env[key];
  Object.assign(process.env, {
    AI_PROVIDER: "vertex", GOOGLE_CLOUD_PROJECT: `test-project-${++project}`,
    GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/aws", GOOGLE_SERVICE_ACCOUNT_EMAIL: "video@test.iam.gserviceaccount.com",
    ...extra,
  });
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete process.env[key];
}
const options = { workspaceId: "ws1", instructions: "Edit this reel safely.", input: "Keep natural speed.", schemaName: "reel_edit_plan", schema: AI_EDIT_PLAN_JSON_SCHEMA as unknown as Record<string, unknown> };
const blank = Object.fromEntries(AI_EDIT_PLAN_JSON_SCHEMA.properties.ops.items.required.map((key) => [key, null]));
const plan = { ops: [{ ...blank, op: "speed", clip: 1, speed: 1 }], note: "Natural speed preserved.", questions: [], caption: null };
const message = (overrides: Record<string, unknown> = {}) => ({
  model: "claude-opus-5-5", stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify({ ...plan, ops: [{ op: "speed", arguments: JSON.stringify({ clip: 1, speed: 1 }) }] }) }],
  usage: { input_tokens: 100, output_tokens: 80, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
  ...overrides,
});

beforeEach(() => {
  vertex.constructed.length = 0; vertex.create.mockReset(); auth.federated.mockReset(); auth.adc.mockReset();
  // The direct Anthropic route must never be used while Vertex is selected.
  globalThis.fetch = async () => { throw new Error("fetch must not be called"); };
});
afterEach(() => { process.env = { ...env }; globalThis.fetch = originalFetch; });

describe("provider selection", () => {
  it("is explicit: AI_PROVIDER=vertex selects Vertex and keeps the Claude model setting", () => {
    configure({ ANTHROPIC_MODEL: "claude-sonnet-5-5" });
    expect(aiProvider()).toBe("vertex");
    expect(aiModel()).toBe("claude-sonnet-5-5");
    delete process.env.ANTHROPIC_MODEL;
    expect(aiModel()).toBe("claude-opus-5-5");
  });
  it("is never chosen implicitly: without AI_PROVIDER a Claude key means direct, otherwise OpenAI", () => {
    configure({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: "test-only" });
    expect(aiProvider()).toBe("anthropic");
    delete process.env.ANTHROPIC_API_KEY;
    expect(aiProvider()).toBe("openai");
    process.env.AI_PROVIDER = "bedrock";
    expect(() => aiProvider()).toThrow(/Unknown AI provider/);
  });
});

describe("configuration", () => {
  it("needs the project and the federation pair, with the global endpoint by default", () => {
    configure();
    expect(vertexConfig()).toEqual({ projectId: process.env.GOOGLE_CLOUD_PROJECT, region: "global", federation: { audience: process.env.GOOGLE_WORKLOAD_IDENTITY_AUDIENCE, email: "video@test.iam.gserviceaccount.com" } });
    expect(isAiConfigured()).toBe(true);
    process.env.VERTEX_CLAUDE_REGION = "us-east5";
    expect(vertexConfig()?.region).toBe("us-east5");
  });
  it("fails closed when the project, half the federation pair, or the SSM placeholder is all there is", () => {
    configure({ GOOGLE_CLOUD_PROJECT: undefined });
    expect(isAiConfigured()).toBe(false);
    configure({ GOOGLE_SERVICE_ACCOUNT_EMAIL: undefined });
    expect(isAiConfigured()).toBe(false);
    configure({ GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: "unset", GOOGLE_SERVICE_ACCOUNT_EMAIL: "unset" });
    expect(isAiConfigured()).toBe(false);
    configure({ GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: undefined, GOOGLE_SERVICE_ACCOUNT_EMAIL: undefined });
    expect(isAiConfigured()).toBe(false);
  });
  it("accepts application default credentials for local development, without any Anthropic key", () => {
    configure({ GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: undefined, GOOGLE_SERVICE_ACCOUNT_EMAIL: undefined, GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json" });
    expect(vertexConfig()?.federation).toBeNull();
    expect(isAiConfigured()).toBe(true);
  });
  it("refuses to send anything when unconfigured", async () => {
    configure({ GOOGLE_CLOUD_PROJECT: undefined });
    await expect(structuredAnswer(options)).rejects.toThrow(/not configured/);
    expect(vertex.create).not.toHaveBeenCalled();
  });
});

describe("request", () => {
  it("builds the official client from the project, region and federated auth, with no SDK retries", async () => {
    configure();
    vertex.create.mockResolvedValue(message());
    const answer = await structuredAnswer(options);
    expect(vertex.constructed).toHaveLength(1);
    expect(vertex.constructed[0]).toMatchObject({ projectId: process.env.GOOGLE_CLOUD_PROJECT, region: "global", maxRetries: 0, authClient: { kind: "federated" } });
    expect(auth.federated).toHaveBeenCalledWith(expect.any(Function), process.env.GOOGLE_WORKLOAD_IDENTITY_AUDIENCE, "video@test.iam.gserviceaccount.com");
    expect(auth.adc).not.toHaveBeenCalled();
    // The exchange reads the app's own AWS credentials, never a stored Google key.
    await expect((auth.federated.mock.calls[0][0] as () => Promise<unknown>)()).resolves.toMatchObject({ accessKeyId: "AKIA-test" });
    expect(answer.model).toBe("claude-opus-5-5");
    // A second call reuses the client, so the Google token is cached between requests.
    vertex.create.mockResolvedValue(message());
    await structuredAnswer(options);
    expect(vertex.constructed).toHaveLength(1);
  });
  it("sends the same request as the direct route: system, user text, strict JSON transport, medium effort", async () => {
    configure();
    vertex.create.mockResolvedValue(message());
    const answer = await structuredAnswer({ ...options, images: ["data:image/jpeg;base64,YWJj"] });
    const [body, requestOptions] = vertex.create.mock.calls[0] as [Record<string, unknown>, { signal?: AbortSignal }];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.max_tokens).toBe(4096);
    expect(String(body.system).startsWith(options.instructions)).toBe(true);
    expect((body.output_config as { effort: string }).effort).toBe("medium");
    expect((body.output_config as { format: { type: string; schema: { properties: { ops: { items: { required: string[] } } } } } }).format.type).toBe("json_schema");
    expect((body.output_config as { format: { schema: { properties: { ops: { items: { required: string[] } } } } } }).format.schema.properties.ops.items.required).toEqual(["op", "arguments"]);
    expect((body.messages as Array<{ role: string; content: unknown[] }>)[0]).toEqual({ role: "user", content: [{ type: "text", text: options.input }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "YWJj" } }] });
    expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
    expect(aiEditPlanSchema.parse(answer.json)).toEqual(plan);
    expect(answer.usage).toEqual({ inputTokens: 130, cachedTokens: 20, cacheWriteTokens: 10, outputTokens: 80 });
    await expect(structuredAnswer({ ...options, images: ["https://example.com/private.jpg"] })).rejects.toThrow(/image data URL/);
  });
  it("uses the region and ADC when so configured", async () => {
    configure({ VERTEX_CLAUDE_REGION: "us-east5", GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: undefined, GOOGLE_SERVICE_ACCOUNT_EMAIL: undefined, GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json" });
    vertex.create.mockResolvedValue(message());
    await structuredAnswer(options);
    expect(vertex.constructed[0]).toMatchObject({ region: "us-east5", authClient: { kind: "adc" } });
    expect(auth.federated).not.toHaveBeenCalled();
  });
  it("treats refusal, truncation and malformed JSON as final, not retryable", async () => {
    configure();
    for (const data of [message({ stop_reason: "refusal", content: [] }), message({ stop_reason: "max_tokens" }), message({ content: [{ type: "text", text: "not json" }] })]) {
      vertex.create.mockResolvedValueOnce(data);
      await expect(structuredAnswer(options)).rejects.toMatchObject({ name: "AiError", transient: false });
    }
  });
});

describe("errors", () => {
  const generate = (status: number) => Anthropic.APIError.generate(status, { error: { type: "error", message: "the secret request text" } }, "the secret request text", new Headers());
  it("maps rate limits, overloads, server errors and dropped connections to retry-later", () => {
    for (const error of [generate(429), generate(500), generate(529), new Anthropic.APIConnectionError({ message: "the secret request text" }), new Anthropic.APIConnectionTimeoutError()]) {
      const mapped = vertexError(error);
      expect(mapped.transient).toBe(true);
      expect(mapped.message).not.toContain("secret");
    }
    expect(vertexError(generate(429)).message).toContain("429");
  });
  it("maps bad requests, missing models and denied access to final errors without echoing the body", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const mapped = vertexError(generate(status));
      expect(mapped.transient).toBe(false);
      expect(mapped.message).toContain(String(status));
      expect(mapped.message).not.toContain("secret");
    }
  });
  it("surfaces an SDK failure through structuredAnswer as AiError, with the gate told the request is settled", async () => {
    configure();
    vertex.create.mockRejectedValueOnce(generate(503));
    await expect(structuredAnswer(options)).rejects.toMatchObject({ name: "AiError", transient: true });
    vertex.create.mockRejectedValueOnce(new Error("could not load the default credentials"));
    await expect(structuredAnswer(options)).rejects.toMatchObject({ name: "AiError", transient: true });
  });
});

describe("pricing", () => {
  const usage = { inputTokens: 130, cachedTokens: 20, cacheWriteTokens: 10, outputTokens: 80 };
  it("matches Anthropic's list price at the global endpoint and adds Google's 10% for a region", () => {
    const direct = usageCostUsd("claude-opus-5-5", usage);
    expect(direct).toBeCloseTo(0.002054, 9);
    expect(usageCostUsd("claude-opus-5-5", usage, { provider: "vertex", vertexRegion: "global" })).toBeCloseTo(direct, 9);
    expect(usageCostUsd("claude-opus-5-5", usage, { provider: "vertex", vertexRegion: "us-east5" })).toBeCloseTo(direct * 1.1, 9);
    expect(vertexPriceFactor("global")).toBe(1);
    expect(vertexPriceFactor("europe-west1")).toBe(1.1);
  });
  it("reads the configured region when none is passed", () => {
    configure({ VERTEX_CLAUDE_REGION: "us-east5" });
    expect(usageCostUsd("claude-opus-5-5", usage, { provider: "vertex" })).toBeCloseTo(0.002054 * 1.1, 9);
    configure();
    expect(usageCostUsd("claude-opus-5-5", usage, { provider: "vertex" })).toBeCloseTo(0.002054, 9);
  });
});
