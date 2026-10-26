/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actingUser } from "./acting-user";
import { MAX_BODY_BYTES, handleMcp } from "./endpoint";
import type { AccessContext } from "./oauth-store";

const m = vi.hoisted(() => ({
  verify: vi.fn<(...args: any[]) => any>(),
  over: false,
  seenUser: undefined as string | undefined,
  count: vi.fn<(...args: any[]) => any>(),
}));
vi.mock("./oauth-store", () => ({ verifyAccessToken: m.verify }));
vi.mock("../throttle", () => ({ overLimit: async () => m.over, countAttempt: async () => undefined }));
vi.mock("@reelwalk/db", () => ({ prisma: { reel: { count: m.count, findMany: async () => [] } } }));
vi.mock("../reel-command", () => ({ loadReel: async () => null, applyReelCommand: async () => null, hookInputsFromLibrary: () => ({ sourceDurationsMs: {} }) }));
vi.mock("../save-reel", () => ({ saveReelFor: async () => null }));
vi.mock("../library", () => ({ toLibraryAssets: async () => [] }));
vi.mock("../reels", () => ({ readTimeline: (value: unknown) => value }));

const ORIGIN = "https://reelwalking.com";
const METADATA = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const context = (scopes: AccessContext["scopes"] = ["reels:read", "reels:write", "exports"]): AccessContext =>
  ({ token: "rwa_good", grantId: "g1", clientId: "c1", clientName: "Claude", scopes, expiresAt: Date.now() + 3600_000, user: { id: "u1", workspaceId: "ws1", email: "a@example.com", workspace: { id: "ws1" } } }) as unknown as AccessContext;

const call = (body: unknown, init: { token?: string | null; method?: string; headers?: Record<string, string>; raw?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "198.51.100.4", ...init.headers };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? "rwa_good"}`;
  const method = init.method ?? "POST";
  return handleMcp(new Request(`${ORIGIN}/mcp`, { method, headers, ...(method === "POST" ? { body: init.raw ?? JSON.stringify(body) } : {}) }));
};
const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_URL", ORIGIN);
  m.over = false;
  m.seenUser = undefined;
  m.verify.mockImplementation(async (token: string) => (token === "rwa_good" ? context() : null));
  m.count.mockImplementation(async () => {
    m.seenUser = actingUser()?.id;
    return 0;
  });
});

describe("authentication", () => {
  it("answers 401 with the protected-resource metadata when there is no token", async () => {
    const response = await call(rpc("tools/list"), { token: null });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate")!;
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${METADATA}"`);
    expect(challenge).toContain('scope="reels:read reels:write exports ai:generate"');
    expect(challenge).not.toContain("error=");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({ error: "unauthorized" });
  });

  it("answers 401 invalid_token for an unknown, expired or revoked token", async () => {
    const response = await call(rpc("tools/list"), { token: "rwa_revoked" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${METADATA}"`);
    expect(m.verify).toHaveBeenCalledWith("rwa_revoked", ORIGIN);
  });

  it("does not take a cookie, a query string or a different scheme for a token", async () => {
    const cookie = await call(rpc("tools/list"), { token: null, headers: { cookie: "rw_session=abc" } });
    expect(cookie.status).toBe(401);
    const basic = await call(rpc("tools/list"), { token: null, headers: { authorization: "Basic YTpi" } });
    expect(basic.status).toBe(401);
    expect(m.verify).not.toHaveBeenCalled();
  });

  it("slows a flood of bad tokens to 429", async () => {
    m.over = true;
    const response = await call(rpc("tools/list"), { token: "rwa_guess" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("answers the CORS preflight without a token", async () => {
    const response = await call(null, { method: "OPTIONS", token: null });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    expect(response.headers.get("access-control-expose-headers")).toMatch(/WWW-Authenticate/);
  });
});

describe("transport", () => {
  it("is POST only (stateless: no standalone stream, no session to delete)", async () => {
    const get = await call(null, { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toMatch(/POST/);
    expect((await call(null, { method: "DELETE" })).status).toBe(405);
  });

  it("refuses bodies that are not JSON or are over the cap", async () => {
    expect((await call(null, { raw: "{not json" })).status).toBe(400);
    const big = await call(null, { raw: JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) }) });
    expect(big.status).toBe(413);
    const declared = await call(null, { raw: "{}", headers: { "content-length": String(MAX_BODY_BYTES + 1) } });
    expect(declared.status).toBe(413);
  });

  it("initializes, naming the server and carrying the instructions", async () => {
    const response = await call(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const body = await response.json();
    expect(body.result.serverInfo).toMatchObject({ name: "reelwalk", title: "ReelWalk" });
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toMatch(/no boxed/i);
  });

  it("lists every tool with a JSON schema object for its input", async () => {
    const body = await (await call(rpc("tools/list"))).json();
    const names = body.result.tools.map((tool: any) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_reels", "get_reel", "create_reel", "search_stock", "add_media", "apply_commands", "get_frames", "get_checks", "get_audio_trace", "export_reel", "get_export"]));
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(40);
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
    }
    expect(body.result.tools.find((tool: any) => tool.name === "list_reels").annotations.readOnlyHint).toBe(true);
    expect(body.result.tools.find((tool: any) => tool.name === "apply_commands").annotations.readOnlyHint).toBe(false);
  });
});

describe("tools/call", () => {
  it("runs the tool as the connected person", async () => {
    const body = await (await call(rpc("tools/call", { name: "list_reels", arguments: {} }))).json();
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ ok: true, total: 0, reels: [] });
    expect(m.seenUser).toBe("u1");
  });

  it("refuses a tool the token has no scope for, as a tool error", async () => {
    m.verify.mockResolvedValue(context(["reels:read"]));
    const body = await (await call(rpc("tools/call", { name: "create_reel", arguments: {} }))).json();
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).missingScopes).toEqual(["reels:write"]);
  });

  it("rejects arguments that do not fit the schema", async () => {
    const body = await (await call(rpc("tools/call", { name: "list_reels", arguments: { limit: 5000 } }))).json();
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect(m.count).not.toHaveBeenCalled();
  });

  it("does not leak the acting user outside the request", async () => {
    await call(rpc("tools/call", { name: "list_reels", arguments: {} }));
    expect(actingUser()).toBeUndefined();
  });
});
