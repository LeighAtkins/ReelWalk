/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@reelwalk/db";
import { POST } from "@/app/oauth/authorize/decision/route";
import { challengeFor } from "./oauth-core";
import { registerClient } from "./oauth-store";
import type { FakeDb } from "./test-db";

vi.mock("@reelwalk/db", async () => {
  const { createFakeDb } = await import("./test-db");
  return { prisma: createFakeDb() };
});
const auth = vi.hoisted(() => ({ user: null as any }));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => auth.user }));

const db = prisma as unknown as FakeDb;
const ORIGIN = "https://reelwalking.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");

beforeEach(() => {
  db.reset();
  vi.stubEnv("APP_URL", ORIGIN);
  auth.user = { id: "u1", email: "a@example.com", workspaceId: "ws1" };
});

async function answer(over: { origin?: string | null; fields?: Record<string, string>; scopes?: string[]; decision?: string } = {}) {
  const client = await registerClient({ name: "Claude", redirectUris: [REDIRECT] });
  const body = new URLSearchParams({ client_id: client.id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, state: "st", requested: "reels:read reels:write exports ai:generate", decision: over.decision ?? "allow", ...over.fields });
  for (const scope of over.scopes ?? ["reels:read", "reels:write"]) body.append("scope", scope);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (over.origin !== null) headers.origin = over.origin ?? ORIGIN;
  return POST(new Request(`${ORIGIN}/oauth/authorize/decision`, { method: "POST", headers, body }));
}

const target = async (response: Response) => new URL(/<a href="([^"]+)">continue/.exec(await response.text())![1].replace(/&amp;/g, "&"));

describe("the consent answer", () => {
  it("approves the ticked scopes and sends the browser to the app with a code and the state", async () => {
    const response = await answer();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const url = await target(response);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get("code")).toMatch(/^rwc_/);
    expect(url.searchParams.get("state")).toBe("st");
    expect(db.tables.oAuthGrant[0]).toMatchObject({ userId: "u1", scopes: ["reels:read", "reels:write"] });
  });

  it("gives nothing beyond what was ticked, even if the form is edited to add a scope", async () => {
    await answer({ scopes: ["reels:read", "ai:generate"], fields: { requested: "reels:read" } });
    expect(db.tables.oAuthGrant[0].scopes).toEqual(["reels:read"]);
  });

  it("cancel and an empty selection both answer access_denied and grant nothing", async () => {
    for (const over of [{ decision: "deny" }, { scopes: [] }]) {
      const url = await target(await answer(over));
      expect(url.searchParams.get("error")).toBe("access_denied");
      expect(url.searchParams.get("code")).toBeNull();
    }
    expect(db.tables.oAuthGrant).toHaveLength(0);
  });

  it("refuses an answer posted from another site or with no origin", async () => {
    expect((await answer({ origin: "https://evil.example" })).status).toBe(403);
    expect((await answer({ origin: null })).status).toBe(403);
    expect(db.tables.oAuthGrant).toHaveLength(0);
  });

  it("refuses when signed out, and for the shared demo account", async () => {
    auth.user = null;
    expect((await answer()).status).toBe(401);
    auth.user = { id: "demo", email: "demo@reelwalk.local", workspaceId: "wsd" };
    expect((await answer()).status).toBe(403);
    expect(db.tables.oAuthGrant).toHaveLength(0);
  });

  it("checks the request again: a redirect URI the app did not register gets no code", async () => {
    const response = await answer({ fields: { redirect_uri: "https://evil.example/cb" } });
    expect(response.status).toBe(400);
    expect(db.tables.oAuthCode).toHaveLength(0);
  });

  it("escapes the app's name and URL in the page it returns", async () => {
    const client = await registerClient({ name: '<script>alert(1)</script>"', redirectUris: [REDIRECT] });
    const body = new URLSearchParams({ client_id: client.id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, state: '"><script>x</script>', requested: "reels:read", decision: "allow" });
    body.append("scope", "reels:read");
    const html = await (await POST(new Request(`${ORIGIN}/oauth/authorize/decision`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body }))).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain('"><script>x');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
