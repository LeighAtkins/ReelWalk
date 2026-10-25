import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@reelwalk/db";
import { challengeFor } from "./oauth-core";
import { authorizationServerMetadata, checkAuthorizeRequest, completeAuthorization, handleRegister, handleRevoke, handleToken, protectedResourceMetadata, resourceMetadataUrl } from "./oauth-http";
import { approve } from "./oauth-store";
import type { FakeDb } from "./test-db";

vi.mock("@reelwalk/db", async () => {
  const { createFakeDb } = await import("./test-db");
  return { prisma: createFakeDb() };
});
const throttle = vi.hoisted(() => ({ over: false }));
vi.mock("../throttle", () => ({ overLimit: async () => throttle.over, countAttempt: async () => undefined }));

const db = prisma as unknown as FakeDb;
const ORIGIN = "https://reelwalking.com";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

beforeEach(() => {
  db.reset();
  db.seedUser("user_1");
  throttle.over = false;
  vi.stubEnv("APP_URL", ORIGIN);
});

const post = (path: string, body: string, type = "application/x-www-form-urlencoded") =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": type, "x-forwarded-for": "203.0.113.9" }, body });
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

async function register(over: Record<string, unknown> = {}) {
  const response = await handleRegister(post("/oauth/register", JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], ...over }), "application/json"));
  return { response, body: await response.json() };
}

describe("metadata", () => {
  it("advertises S256-only, public clients, registration and the scopes", () => {
    const meta = authorizationServerMetadata(ORIGIN);
    expect(meta).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    expect(meta.scopes_supported).toEqual(["reels:read", "reels:write", "exports", "ai:generate"]);
  });

  it("names the MCP URL as the resource and this site as its authorization server", () => {
    expect(protectedResourceMetadata(ORIGIN)).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    expect(resourceMetadataUrl(ORIGIN)).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  });
});

describe("dynamic client registration", () => {
  it("registers a public client and says so", async () => {
    const { response, body } = await register();
    expect(response.status).toBe(201);
    expect(body).toMatchObject({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", response_types: ["code"] });
    expect(body.client_id).toMatch(/^rwc_/);
    expect(body.client_secret).toBeUndefined();
    expect(db.tables.oAuthClient).toHaveLength(1);
  });

  it("refuses unsafe redirect URIs and missing ones", async () => {
    for (const uri of ["http://evil.example/cb", "javascript:alert(1)", "https://x.example/cb#f"]) {
      const { response, body } = await register({ redirect_uris: [uri] });
      expect(response.status).toBe(400);
      expect(body.error).toBe("invalid_redirect_uri");
    }
    expect((await register({ redirect_uris: [] })).response.status).toBe(400);
    expect((await register({ redirect_uris: undefined })).response.status).toBe(400);
    expect(db.tables.oAuthClient).toHaveLength(0);
  });

  it("refuses grant types it does not do, bad JSON and oversized bodies", async () => {
    expect((await register({ grant_types: ["client_credentials"] })).response.status).toBe(400);
    expect((await handleRegister(post("/oauth/register", "{nope", "application/json"))).status).toBe(400);
    expect((await handleRegister(post("/oauth/register", JSON.stringify({ redirect_uris: [REDIRECT], client_name: "x".repeat(40_000) }), "application/json"))).status).toBe(413);
  });

  it("is rate limited", async () => {
    throttle.over = true;
    const { response } = await register();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
  });
});

describe("authorization request", () => {
  async function client() {
    return (await register()).body.client_id as string;
  }
  const request = (clientId: string, over: Record<string, string | undefined> = {}) => ({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challengeFor(VERIFIER),
    code_challenge_method: "S256",
    state: "xyz",
    ...over,
  });

  it("shows consent for a registered app with a PKCE challenge, defaulting the scopes", async () => {
    const id = await client();
    const check = await checkAuthorizeRequest(request(id), ORIGIN);
    expect(check).toMatchObject({ kind: "consent", clientName: "Claude", state: "xyz", requested: ["reels:read", "reels:write", "exports"] });
  });

  it("uses the scopes the app asked for, and bounces unknown ones", async () => {
    const id = await client();
    expect(await checkAuthorizeRequest(request(id, { scope: "reels:read ai:generate" }), ORIGIN)).toMatchObject({ kind: "consent", requested: ["reels:read", "ai:generate"] });
    expect(await checkAuthorizeRequest(request(id, { scope: "reels:read instagram:post" }), ORIGIN)).toMatchObject({ kind: "bounce", error: "invalid_scope" });
  });

  it("never redirects to a URI the app did not register or for an unknown app", async () => {
    const id = await client();
    expect(await checkAuthorizeRequest(request(id, { redirect_uri: "https://evil.example/cb" }), ORIGIN)).toMatchObject({ kind: "reject" });
    expect(await checkAuthorizeRequest(request("rwc_unknown"), ORIGIN)).toMatchObject({ kind: "reject" });
    expect(await checkAuthorizeRequest({ response_type: "code" }, ORIGIN)).toMatchObject({ kind: "reject" });
  });

  it("requires PKCE S256 and the right resource and response_type", async () => {
    const id = await client();
    expect(await checkAuthorizeRequest(request(id, { code_challenge: undefined }), ORIGIN)).toMatchObject({ kind: "bounce", error: "invalid_request" });
    expect(await checkAuthorizeRequest(request(id, { code_challenge_method: "plain" }), ORIGIN)).toMatchObject({ kind: "bounce", error: "invalid_request" });
    expect(await checkAuthorizeRequest(request(id, { response_type: "token" }), ORIGIN)).toMatchObject({ kind: "bounce", error: "unsupported_response_type" });
    expect(await checkAuthorizeRequest(request(id, { resource: "https://evil.example/mcp" }), ORIGIN)).toMatchObject({ kind: "bounce", error: "invalid_target" });
    expect(await checkAuthorizeRequest(request(id, { resource: `${ORIGIN}/mcp` }), ORIGIN)).toMatchObject({ kind: "consent" });
  });

  it("answers with a code and the state when allowed, only for the scopes that were ticked and asked for", async () => {
    const id = await client();
    const check = await checkAuthorizeRequest(request(id, { scope: "reels:read reels:write" }), ORIGIN);
    if (check.kind !== "consent") throw new Error("expected consent");
    const target = new URL(await completeAuthorization(check, "user_1", ["reels:read", "exports"], ORIGIN));
    expect(target.origin + target.pathname).toBe(REDIRECT);
    expect(target.searchParams.get("state")).toBe("xyz");
    expect(target.searchParams.get("iss")).toBe(ORIGIN);
    expect(target.searchParams.get("code")).toMatch(/^rwc_/);
    expect(db.tables.oAuthGrant[0].scopes).toEqual(["reels:read"]);
  });

  it("answers access_denied when nothing is ticked or the person cancels", async () => {
    const id = await client();
    const check = await checkAuthorizeRequest(request(id), ORIGIN);
    if (check.kind !== "consent") throw new Error("expected consent");
    const target = new URL(await completeAuthorization(check, "user_1", [], ORIGIN));
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("code")).toBeNull();
    expect(db.tables.oAuthGrant).toHaveLength(0);
  });
});

describe("token endpoint", () => {
  async function code() {
    const { body } = await register();
    const authorization = await approve({ userId: "user_1", clientId: body.client_id, scopes: ["reels:read"], redirectUri: REDIRECT, codeChallenge: challengeFor(VERIFIER), origin: ORIGIN });
    return { clientId: body.client_id as string, code: authorization };
  }

  it("issues tokens for a code with the verifier, with no-store headers", async () => {
    const { clientId, code: authorizationCode } = await code();
    const response = await handleToken(post("/oauth/token", form({ grant_type: "authorization_code", code: authorizationCode, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: `${ORIGIN}/mcp` })));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "reels:read" });
  });

  it("answers invalid_grant for a wrong verifier and invalid_client for an unknown app", async () => {
    const { clientId, code: authorizationCode } = await code();
    const wrong = await handleToken(post("/oauth/token", form({ grant_type: "authorization_code", code: authorizationCode, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "y".repeat(50) })));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    const unknown = await handleToken(post("/oauth/token", form({ grant_type: "authorization_code", code: authorizationCode, client_id: "rwc_nope", redirect_uri: REDIRECT, code_verifier: VERIFIER })));
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: "invalid_client" });
    expect((await handleToken(post("/oauth/token", form({ grant_type: "authorization_code", code: authorizationCode })))).status).toBe(401);
  });

  it("refuses unsupported grants and another site's resource", async () => {
    const { clientId } = await code();
    const unsupported = await handleToken(post("/oauth/token", form({ grant_type: "password", client_id: clientId })));
    expect(await unsupported.json()).toMatchObject({ error: "unsupported_grant_type" });
    const resource = await handleToken(post("/oauth/token", form({ grant_type: "refresh_token", refresh_token: "rwr_x", client_id: clientId, resource: "https://evil.example/mcp" })));
    expect(await resource.json()).toMatchObject({ error: "invalid_request" });
  });

  it("refreshes, and a spent refresh token is refused", async () => {
    const { clientId, code: authorizationCode } = await code();
    const first = await (await handleToken(post("/oauth/token", form({ grant_type: "authorization_code", code: authorizationCode, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER })))).json();
    const refreshed = await handleToken(post("/oauth/token", form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId })));
    expect(refreshed.status).toBe(200);
    const replay = await handleToken(post("/oauth/token", form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId })));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("is rate limited, and revocation always answers 200", async () => {
    const { clientId } = await code();
    expect((await handleRevoke(post("/oauth/revoke", form({ token: "rwa_unknown", client_id: clientId })))).status).toBe(200);
    expect((await handleRevoke(post("/oauth/revoke", form({ token: "rwa_unknown" })))).status).toBe(400);
    throttle.over = true;
    expect((await handleToken(post("/oauth/token", form({ grant_type: "refresh_token" })))).status).toBe(429);
  });
});
