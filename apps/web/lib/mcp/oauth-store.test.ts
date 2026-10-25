import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@reelwalk/db";
import { ACCESS_TTL_MS, REFRESH_TTL_MS, challengeFor, hashSecret } from "./oauth-core";
import { approve, exchangeCode, listGrants, refreshTokens, registerClient, revokeGrant, revokeToken, verifyAccessToken, type TokenResponse } from "./oauth-store";
import type { FakeDb } from "./test-db";

vi.mock("@reelwalk/db", async () => {
  const { createFakeDb } = await import("./test-db");
  return { prisma: createFakeDb() };
});

const db = prisma as unknown as FakeDb;
const ORIGIN = "https://reelwalking.com";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function connect(scopes: ("reels:read" | "reels:write" | "exports" | "ai:generate")[] = ["reels:read", "reels:write"]) {
  const client = await registerClient({ name: "Claude", redirectUris: [REDIRECT] });
  const code = await approve({ userId: "user_1", workspaceId: "ws_user_1", clientId: client.id, scopes, redirectUri: REDIRECT, codeChallenge: challengeFor(VERIFIER), origin: ORIGIN });
  return { client, code };
}

const exchange = (code: string, clientId: string, over: Partial<Parameters<typeof exchangeCode>[0]> = {}) =>
  exchangeCode({ code, clientId, redirectUri: REDIRECT, codeVerifier: VERIFIER, ...over });

async function tokens(scopes?: Parameters<typeof connect>[0]) {
  const { client, code } = await connect(scopes);
  const result = await exchange(code, client.id);
  if ("ok" in result) throw new Error(`exchange failed: ${result.description}`);
  return { client, tokens: result };
}

beforeEach(() => {
  db.reset();
  db.seedUser("user_1");
  db.seedUser("user_2");
});
afterEach(() => vi.useRealTimers());

describe("authorization code exchange", () => {
  it("trades a code and the right verifier for an access and a refresh token", async () => {
    const { tokens: issued } = await tokens();
    expect(issued).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "reels:read reels:write" });
    expect(issued.access_token).toMatch(/^rwa_/);
    expect(issued.refresh_token).toMatch(/^rwr_/);
  });

  it("stores only hashes of the code and of both tokens", async () => {
    const { code, client } = await connect();
    const result = (await exchange(code, client.id)) as TokenResponse;
    const stored = JSON.stringify(db.tables);
    for (const secret of [code, result.access_token, result.refresh_token]) expect(stored).not.toContain(secret);
    expect(db.tables.oAuthToken.map((row) => row.hash)).toContain(hashSecret(result.access_token));
  });

  it("refuses a wrong PKCE verifier, and the code is still good for the right one", async () => {
    const { code, client } = await connect();
    const bad = await exchange(code, client.id, { codeVerifier: "x".repeat(50) });
    expect(bad).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await exchange(code, client.id)).toHaveProperty("access_token");
  });

  it("refuses a missing verifier (PKCE is not optional)", async () => {
    const { code, client } = await connect();
    expect(await exchange(code, client.id, { codeVerifier: undefined })).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("refuses another redirect_uri, another client, an unknown code and an expired code", async () => {
    const { code, client } = await connect();
    expect(await exchange(code, client.id, { redirectUri: "https://evil.example/cb" })).toMatchObject({ ok: false, error: "invalid_grant" });
    const other = await registerClient({ name: "Other", redirectUris: [REDIRECT] });
    expect(await exchange(code, other.id)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await exchange("rwc_unknown", client.id)).toMatchObject({ ok: false, error: "invalid_grant" });
    db.tables.oAuthCode[0].expiresAt = new Date(Date.now() - 1000);
    expect(await exchange(code, client.id)).toMatchObject({ ok: false, error: "invalid_grant", description: expect.stringContaining("expired") });
  });

  it("a code replayed after use ends the grant and every token under it", async () => {
    const { code, client } = await connect();
    const first = (await exchange(code, client.id)) as TokenResponse;
    expect(await verifyAccessToken(first.access_token, ORIGIN)).not.toBeNull();
    expect(await exchange(code, client.id)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await verifyAccessToken(first.access_token, ORIGIN)).toBeNull();
    expect(await refreshTokens({ refreshToken: first.refresh_token, clientId: client.id, scope: undefined })).toMatchObject({ ok: false });
  });
});

describe("access tokens and scopes", () => {
  it("resolve to the person, the app and the scopes that were granted", async () => {
    const { tokens: issued, client } = await tokens(["reels:read", "exports"]);
    const context = await verifyAccessToken(issued.access_token, ORIGIN);
    expect(context).toMatchObject({ clientId: client.id, clientName: "Claude", scopes: ["reels:read", "exports"] });
    expect(context?.user.id).toBe("user_1");
    expect(context?.user.workspace.id).toBe("ws_user_1");
  });

  it("are refused when unknown, expired, a refresh token, or meant for another site", async () => {
    const { tokens: issued } = await tokens();
    expect(await verifyAccessToken("rwa_nope", ORIGIN)).toBeNull();
    expect(await verifyAccessToken("garbage", ORIGIN)).toBeNull();
    expect(await verifyAccessToken(issued.refresh_token, ORIGIN)).toBeNull();
    expect(await verifyAccessToken(issued.access_token, "https://other.example")).toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + ACCESS_TTL_MS + 1000);
    expect(await verifyAccessToken(issued.access_token, ORIGIN)).toBeNull();
  });

  it("the consent screen can only narrow: scopes are what was approved", async () => {
    const { tokens: issued } = await tokens(["reels:read"]);
    expect(issued.scope).toBe("reels:read");
    expect((await verifyAccessToken(issued.access_token, ORIGIN))?.scopes).toEqual(["reels:read"]);
  });
});

describe("refresh tokens", () => {
  it("rotate: a new pair comes back and the old refresh token is spent", async () => {
    const { tokens: first, client } = await tokens();
    const second = (await refreshTokens({ refreshToken: first.refresh_token, clientId: client.id, scope: undefined })) as TokenResponse;
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.scope).toBe("reels:read reels:write");
    expect(await verifyAccessToken(second.access_token, ORIGIN)).not.toBeNull();
  });

  it("presenting a spent refresh token ends the whole grant (theft)", async () => {
    const { tokens: first, client } = await tokens();
    const second = (await refreshTokens({ refreshToken: first.refresh_token, clientId: client.id, scope: undefined })) as TokenResponse;
    expect(await refreshTokens({ refreshToken: first.refresh_token, clientId: client.id, scope: undefined })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await verifyAccessToken(second.access_token, ORIGIN)).toBeNull();
    expect(await refreshTokens({ refreshToken: second.refresh_token, clientId: client.id, scope: undefined })).toMatchObject({ ok: false });
    expect(await listGrants("user_1")).toEqual([]);
  });

  it("can narrow scopes but never widen them", async () => {
    const { tokens: first, client } = await tokens(["reels:read", "reels:write"]);
    expect(await refreshTokens({ refreshToken: first.refresh_token, clientId: client.id, scope: ["reels:read", "exports"] })).toMatchObject({ ok: false, error: "invalid_scope" });
    const narrowed = (await refreshTokens({ refreshToken: first.refresh_token, clientId: client.id, scope: ["reels:read"] })) as TokenResponse;
    expect(narrowed.scope).toBe("reels:read");
  });

  it("are bound to their app and expire after 30 days", async () => {
    const { tokens: first, client } = await tokens();
    const other = await registerClient({ name: "Other", redirectUris: [REDIRECT] });
    expect(await refreshTokens({ refreshToken: first.refresh_token, clientId: other.id, scope: undefined })).toMatchObject({ ok: false, error: "invalid_grant" });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + REFRESH_TTL_MS + 1000);
    expect(await refreshTokens({ refreshToken: first.refresh_token, clientId: client.id, scope: undefined })).toMatchObject({ ok: false, description: expect.stringContaining("expired") });
  });

  it("an access token is not accepted as a refresh token", async () => {
    const { tokens: first, client } = await tokens();
    expect(await refreshTokens({ refreshToken: first.access_token, clientId: client.id, scope: undefined })).toMatchObject({ ok: false, error: "invalid_grant" });
  });
});

describe("revocation", () => {
  it("the account page's Disconnect kills the access and refresh tokens at once", async () => {
    const { tokens: issued, client } = await tokens();
    const [grant] = await listGrants("user_1");
    expect(grant).toMatchObject({ clientName: "Claude", scopes: ["reels:read", "reels:write"] });
    expect(await revokeGrant("user_1", grant.id)).toBe(true);
    expect(await verifyAccessToken(issued.access_token, ORIGIN)).toBeNull();
    expect(await refreshTokens({ refreshToken: issued.refresh_token, clientId: client.id, scope: undefined })).toMatchObject({ ok: false });
    expect(await listGrants("user_1")).toEqual([]);
  });

  it("one person cannot disconnect another person's app", async () => {
    const { tokens: issued } = await tokens();
    const [grant] = await listGrants("user_1");
    expect(await revokeGrant("user_2", grant.id)).toBe(false);
    expect(await verifyAccessToken(issued.access_token, ORIGIN)).not.toBeNull();
    expect(await listGrants("user_1")).toHaveLength(1);
  });

  it("reconnecting after a disconnect needs a fresh consent and works again", async () => {
    const { client, tokens: old } = await tokens();
    const [grant] = await listGrants("user_1");
    await revokeGrant("user_1", grant.id);
    const code = await approve({ userId: "user_1", workspaceId: "ws_user_1", clientId: client.id, scopes: ["reels:read"], redirectUri: REDIRECT, codeChallenge: challengeFor(VERIFIER), origin: ORIGIN });
    const fresh = (await exchange(code, client.id)) as TokenResponse;
    expect(await verifyAccessToken(old.access_token, ORIGIN)).toBeNull();
    expect((await verifyAccessToken(fresh.access_token, ORIGIN))?.scopes).toEqual(["reels:read"]);
  });

  it("RFC 7009: revoking a refresh token ends the grant, an access token only itself, an unknown token nothing", async () => {
    const { tokens: issued, client } = await tokens();
    await revokeToken("rwa_unknown", client.id);
    await revokeToken(issued.access_token, "someone-else");
    expect(await verifyAccessToken(issued.access_token, ORIGIN)).not.toBeNull();
    await revokeToken(issued.access_token, client.id);
    expect(await verifyAccessToken(issued.access_token, ORIGIN)).toBeNull();
    expect(await refreshTokens({ refreshToken: issued.refresh_token, clientId: client.id, scope: undefined })).toHaveProperty("access_token");
    const again = await tokens();
    await revokeToken(again.tokens.refresh_token, again.client.id);
    expect(await verifyAccessToken(again.tokens.access_token, ORIGIN)).toBeNull();
  });
});

describe("a connection is bound to one workspace (ADR 0079)", () => {
  async function connectTo(workspaceId: string, scopes: Parameters<typeof connect>[0] = ["reels:read", "reels:write"], userId = "user_1") {
    const client = await registerClient({ name: "Claude", redirectUris: [REDIRECT] });
    const code = await approve({ userId, workspaceId, clientId: client.id, scopes, redirectUri: REDIRECT, codeChallenge: challengeFor(VERIFIER), origin: ORIGIN });
    const issued = (await exchange(code, client.id)) as TokenResponse;
    return { client, issued };
  }

  it("stores the workspace on the grant and acts as the person in that workspace, not their home one", async () => {
    db.seedWorkspace("ws_lm", "user_1", { name: "Last Mile" });
    const { issued } = await connectTo("ws_lm");
    expect(db.tables.oAuthGrant[0]).toMatchObject({ userId: "user_1", workspaceId: "ws_lm" });
    const context = await verifyAccessToken(issued.access_token, ORIGIN);
    expect(context?.user).toMatchObject({ id: "user_1", workspaceId: "ws_lm", homeWorkspaceId: "ws_user_1", role: "OWNER" });
    expect(context?.user.workspace.name).toBe("Last Mile");
  });

  it("a token for the home workspace acts in the home workspace", async () => {
    db.seedWorkspace("ws_lm", "user_1");
    const { issued } = await connectTo("ws_user_1");
    expect((await verifyAccessToken(issued.access_token, ORIGIN))?.user.workspaceId).toBe("ws_user_1");
  });

  it("the same app connected to two workspaces is two grants with separate tokens", async () => {
    db.seedWorkspace("ws_lm", "user_1", { name: "Last Mile" });
    const client = await registerClient({ name: "Claude", redirectUris: [REDIRECT] });
    const issueFor = async (workspaceId: string) => {
      const code = await approve({ userId: "user_1", workspaceId, clientId: client.id, scopes: ["reels:read"], redirectUri: REDIRECT, codeChallenge: challengeFor(VERIFIER), origin: ORIGIN });
      return (await exchange(code, client.id)) as TokenResponse;
    };
    const home = await issueFor("ws_user_1");
    const lastMile = await issueFor("ws_lm");
    expect(db.tables.oAuthGrant).toHaveLength(2);
    expect((await verifyAccessToken(home.access_token, ORIGIN))?.user.workspaceId).toBe("ws_user_1");
    expect((await verifyAccessToken(lastMile.access_token, ORIGIN))?.user.workspaceId).toBe("ws_lm");
    const listed = await listGrants("user_1");
    expect(listed.map((grant) => grant.workspaceName).sort()).toEqual(["Last Mile", "Studio"]);
  });

  it("reconnecting to the same workspace updates that grant instead of adding one", async () => {
    const client = await registerClient({ name: "Claude", redirectUris: [REDIRECT] });
    for (const scopes of [["reels:read"], ["reels:read", "exports"]] as const) {
      await approve({ userId: "user_1", workspaceId: "ws_user_1", clientId: client.id, scopes: [...scopes], redirectUri: REDIRECT, codeChallenge: challengeFor(VERIFIER), origin: ORIGIN });
    }
    expect(db.tables.oAuthGrant).toHaveLength(1);
    expect(db.tables.oAuthGrant[0].scopes).toEqual(["reels:read", "exports"]);
  });

  it("checks the seat on every call: a person who lost their seat loses the connection to that workspace", async () => {
    db.seedWorkspace("ws_lm", "user_1");
    const { issued } = await connectTo("ws_lm");
    expect(await verifyAccessToken(issued.access_token, ORIGIN)).not.toBeNull();
    db.tables.workspaceMember = db.tables.workspaceMember.filter((row) => row.workspaceId !== "ws_lm");
    expect(await verifyAccessToken(issued.access_token, ORIGIN)).toBeNull();
  });

  it("a grant whose workspace is not the person's never authenticates, even if one was written", async () => {
    db.seedWorkspace("ws_other", "user_2");
    const { issued } = await connectTo("ws_other");
    expect(await verifyAccessToken(issued.access_token, ORIGIN)).toBeNull();
  });

  it("drops ai:generate from the token's scopes when the workspace has AI off (even if it was granted earlier)", async () => {
    db.seedWorkspace("ws_lm", "user_1", { ai: "on" });
    const { issued } = await connectTo("ws_lm", ["reels:read", "ai:generate"]);
    expect((await verifyAccessToken(issued.access_token, ORIGIN))?.scopes).toEqual(["reels:read", "ai:generate"]);
    db.tables.workspace.find((row) => row.id === "ws_lm")!.aiGeneration = "off";
    expect((await verifyAccessToken(issued.access_token, ORIGIN))?.scopes).toEqual(["reels:read"]);
  });

  it("a refreshed token stays bound to the same workspace", async () => {
    db.seedWorkspace("ws_lm", "user_1");
    const { issued, client } = await connectTo("ws_lm");
    const next = (await refreshTokens({ refreshToken: issued.refresh_token, clientId: client.id, scope: undefined })) as TokenResponse;
    expect((await verifyAccessToken(next.access_token, ORIGIN))?.user.workspaceId).toBe("ws_lm");
  });
});
