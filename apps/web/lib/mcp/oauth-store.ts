import { prisma } from "@reelwalk/db";
import { ACCESS_TTL_MS, CODE_TTL_MS, REFRESH_TTL_MS, hashSecret, newClientId, newSecret, resourceFor, verifyPkce } from "./oauth-core";
import { formatScopes, isScope, type Scope } from "./scopes";
import { aiSwitchOf } from "../ai-gate";
import { actingUserFor } from "../workspaces";

/**
 * The connector's OAuth state in Postgres (ADR 0077): registered apps, one
 * grant per person and app, single-use authorization codes, and hashed access
 * and refresh tokens. A refresh token is rotated on every use; presenting one
 * that was already used, or a code that was already exchanged, ends the whole
 * grant, because it means a copy of the secret is out there.
 */

export type OAuthFailure = { ok: false; error: "invalid_request" | "invalid_client" | "invalid_grant" | "invalid_scope" | "unsupported_grant_type"; description: string };
const fail = (error: OAuthFailure["error"], description: string): OAuthFailure => ({ ok: false, error, description });

export type TokenResponse = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string };

const scopesOf = (values: readonly string[]): Scope[] => values.filter(isScope);

// ── Registration ─────────────────────────────────────────────────

/** Registrations nobody ever consented to are swept after this long. */
const STALE_CLIENT_MS = 7 * 24 * 3600_000;

export async function registerClient(input: { name: string; redirectUris: string[]; clientUri?: string }) {
  const client = await prisma.oAuthClient.create({ data: { id: newClientId(), name: input.name, redirectUris: input.redirectUris, clientUri: input.clientUri ?? null } });
  if (Math.random() < 0.05) await sweep();
  return client;
}

export const getClient = (id: string) => prisma.oAuthClient.findUnique({ where: { id } });

/** Expired codes and tokens, and apps that registered but never got consent, are dead weight. */
async function sweep(): Promise<void> {
  const now = Date.now();
  await Promise.all([
    prisma.oAuthCode.deleteMany({ where: { expiresAt: { lt: new Date(now - 24 * 3600_000) } } }),
    prisma.oAuthToken.deleteMany({ where: { expiresAt: { lt: new Date(now - 24 * 3600_000) } } }),
    prisma.oAuthClient.deleteMany({ where: { createdAt: { lt: new Date(now - STALE_CLIENT_MS) }, grants: { none: {} } } }),
  ]);
}

// ── Consent ──────────────────────────────────────────────────────

/**
 * The person said yes: their grant for this app in one workspace (new, or widened or narrowed on reconnecting) and a
 * one-use code. A grant is bound to the workspace it was approved for (ADR 0079); connecting the same app to
 * another workspace is a second grant.
 */
export async function approve(input: { userId: string; workspaceId: string; clientId: string; scopes: Scope[]; redirectUri: string; codeChallenge: string; origin: string }): Promise<string> {
  const grant = await prisma.oAuthGrant.upsert({
    where: { userId_clientId_workspaceId: { userId: input.userId, clientId: input.clientId, workspaceId: input.workspaceId } },
    create: { userId: input.userId, workspaceId: input.workspaceId, clientId: input.clientId, scopes: input.scopes },
    update: { scopes: input.scopes, revokedAt: null },
  });
  const code = newSecret("rwc");
  await prisma.oAuthCode.create({
    data: {
      codeHash: hashSecret(code),
      grantId: grant.id,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      resource: resourceFor(input.origin),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  return code;
}

// ── Tokens ───────────────────────────────────────────────────────

async function issue(grantId: string, scopes: Scope[], resource: string): Promise<TokenResponse> {
  const access = newSecret("rwa");
  const refresh = newSecret("rwr");
  const now = Date.now();
  await prisma.oAuthToken.create({ data: { hash: hashSecret(access), kind: "ACCESS", grantId, scopes, resource, expiresAt: new Date(now + ACCESS_TTL_MS) } });
  await prisma.oAuthToken.create({ data: { hash: hashSecret(refresh), kind: "REFRESH", grantId, scopes, resource, expiresAt: new Date(now + REFRESH_TTL_MS) } });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: formatScopes(scopes) };
}

/** Ends a grant: no token under it works again and the person must consent again to reconnect. */
async function endGrant(where: { id: string; userId?: string }): Promise<boolean> {
  const ended = await prisma.oAuthGrant.updateMany({ where: { ...where, revokedAt: null }, data: { revokedAt: new Date() } });
  // A person's own disconnect must not touch a grant that is not theirs.
  if (where.userId && ended.count === 0) return false;
  await Promise.all([prisma.oAuthToken.deleteMany({ where: { grantId: where.id } }), prisma.oAuthCode.deleteMany({ where: { grantId: where.id } })]);
  return ended.count > 0;
}

export async function exchangeCode(input: { code: string; clientId: string; redirectUri: string | undefined; codeVerifier: string | undefined }): Promise<TokenResponse | OAuthFailure> {
  const row = await prisma.oAuthCode.findUnique({ where: { codeHash: hashSecret(input.code) }, include: { grant: true } });
  if (!row) return fail("invalid_grant", "That authorization code is not valid.");
  if (row.usedAt) {
    // A code is good for one exchange. Seeing it again means it was copied.
    await endGrant({ id: row.grantId });
    return fail("invalid_grant", "That authorization code was already used. The connection was ended; connect again.");
  }
  if (row.grant.clientId !== input.clientId) return fail("invalid_grant", "That code was issued to another app.");
  if (row.grant.revokedAt) return fail("invalid_grant", "That connection was revoked.");
  if (row.expiresAt.getTime() < Date.now()) return fail("invalid_grant", "That authorization code has expired.");
  if (input.redirectUri !== row.redirectUri) return fail("invalid_grant", "redirect_uri does not match the authorization request.");
  if (!verifyPkce(input.codeVerifier, row.codeChallenge)) return fail("invalid_grant", "The PKCE code_verifier does not match.");

  // Claim the code atomically: two requests racing with the same code cannot both win.
  const claimed = await prisma.oAuthCode.updateMany({ where: { codeHash: row.codeHash, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) {
    await endGrant({ id: row.grantId });
    return fail("invalid_grant", "That authorization code was already used.");
  }
  return issue(row.grantId, scopesOf(row.scopes), row.resource);
}

export async function refreshTokens(input: { refreshToken: string; clientId: string; scope: Scope[] | undefined }): Promise<TokenResponse | OAuthFailure> {
  const row = await prisma.oAuthToken.findUnique({ where: { hash: hashSecret(input.refreshToken) }, include: { grant: true } });
  if (!row || row.kind !== "REFRESH") return fail("invalid_grant", "That refresh token is not valid.");
  if (row.usedAt) {
    await endGrant({ id: row.grantId });
    return fail("invalid_grant", "That refresh token was already used. The connection was ended; connect again.");
  }
  if (row.grant.clientId !== input.clientId) return fail("invalid_grant", "That refresh token was issued to another app.");
  if (row.grant.revokedAt) return fail("invalid_grant", "That connection was revoked.");
  if (row.expiresAt.getTime() < Date.now()) return fail("invalid_grant", "That refresh token has expired. Connect again.");
  const held = scopesOf(row.scopes);
  if (input.scope && !input.scope.every((scope) => held.includes(scope))) return fail("invalid_scope", "A refresh cannot add scopes that were not granted.");

  const claimed = await prisma.oAuthToken.updateMany({ where: { hash: row.hash, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) {
    await endGrant({ id: row.grantId });
    return fail("invalid_grant", "That refresh token was already used.");
  }
  return issue(row.grantId, input.scope && input.scope.length > 0 ? input.scope : held, row.resource);
}

// ── Using a token ────────────────────────────────────────────────

export type AccessContext = {
  token: string;
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: Scope[];
  expiresAt: number;
  /** The person, acting in the workspace the grant is bound to (ADR 0079). */
  user: NonNullable<Awaited<ReturnType<typeof actingUserFor>>>;
};

const TOUCH_EVERY_MS = 5 * 60_000;

/** The grant behind a bearer token, or null when it is unknown, expired, revoked or meant for another server. */
export async function verifyAccessToken(token: string, origin: string): Promise<AccessContext | null> {
  if (!token.startsWith("rwa_")) return null;
  const row = await prisma.oAuthToken.findUnique({ where: { hash: hashSecret(token) }, include: { grant: { include: { client: true } } } });
  if (!row || row.kind !== "ACCESS" || row.expiresAt.getTime() < Date.now() || row.grant.revokedAt) return null;
  if (row.resource !== resourceFor(origin)) return null;
  // The workspace is the grant's, and the seat is checked again on every call: a person who lost their seat loses the connection to it.
  const user = await actingUserFor(row.grant.userId, row.grant.workspaceId);
  if (!user) return null;
  // A workspace that has since turned AI off keeps the connection but not the credit-spending scope.
  const scopes = scopesOf(row.scopes).filter((scope) => scope !== "ai:generate" || aiSwitchOf(user.workspace.aiGeneration) === "on");
  // "Last used" on the account page: written at most every few minutes, not on every call.
  void prisma.oAuthGrant
    .updateMany({ where: { id: row.grantId, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - TOUCH_EVERY_MS) } }] }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return { token, grantId: row.grantId, clientId: row.grant.clientId, clientName: row.grant.client.name, scopes, expiresAt: row.expiresAt.getTime(), user };
}

// ── Revocation ───────────────────────────────────────────────────

/** RFC 7009: the app gives a token back. A refresh token ends the whole grant; an access token only itself. Unknown tokens are not an error. */
export async function revokeToken(token: string, clientId: string): Promise<void> {
  const row = await prisma.oAuthToken.findUnique({ where: { hash: hashSecret(token) }, include: { grant: true } });
  if (!row || row.grant.clientId !== clientId) return;
  if (row.kind === "REFRESH") await endGrant({ id: row.grantId });
  else await prisma.oAuthToken.deleteMany({ where: { hash: row.hash } });
}

/** The account page's "Disconnect": true if the person's grant existed and was live. */
export const revokeGrant = (userId: string, grantId: string): Promise<boolean> => endGrant({ id: grantId, userId });

export async function listGrants(userId: string) {
  const grants = await prisma.oAuthGrant.findMany({ where: { userId, revokedAt: null }, include: { client: true, workspace: { select: { name: true } } }, orderBy: { createdAt: "desc" } });
  return grants.map((grant) => ({ id: grant.id, clientName: grant.client.name, workspaceId: grant.workspaceId, workspaceName: grant.workspace.name, scopes: scopesOf(grant.scopes), createdAt: grant.createdAt, lastUsedAt: grant.lastUsedAt }));
}
