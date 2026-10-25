import { z } from "zod";
import { MINUTE, allow, json, readCapped, requestIp, retryAfterSeconds, siteOrigin } from "./http";
import { isAllowedRedirectUri, isCodeChallenge, isOurResource, redirectUriMatches, resourceFor, withParams } from "./oauth-core";
import { approve, exchangeCode, getClient, refreshTokens, registerClient, revokeToken, type OAuthFailure } from "./oauth-store";
import { DEFAULT_SCOPES, SCOPES, parseScopes, type Scope } from "./scopes";

/**
 * The connector's OAuth 2.1 endpoints as plain `(Request) => Response`
 * functions (ADR 0077); the route files only forward to them. Public clients
 * with PKCE (S256), dynamic registration (RFC 7591), authorization-server and
 * protected-resource metadata (RFC 8414, RFC 9728), token revocation (RFC 7009)
 * and resource indicators (RFC 8707).
 */

// ── Metadata ─────────────────────────────────────────────────────

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: `${origin}/connect`,
  };
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceFor(origin),
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "ReelWalk",
    resource_documentation: `${origin}/connect`,
  };
}

/** Where a 401 from /mcp tells a client to find the protected-resource metadata (RFC 9728 section 5.1). */
export const resourceMetadataUrl = (origin: string): string => `${origin}/.well-known/oauth-protected-resource/mcp`;

// ── Errors ───────────────────────────────────────────────────────

function oauthError(failure: Pick<OAuthFailure, "error" | "description">, status = 400): Response {
  return json({ error: failure.error, error_description: failure.description }, status, { Pragma: "no-cache" });
}

// ── Dynamic client registration (RFC 7591) ───────────────────────

const registrationSchema = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().max(100).optional(),
  client_uri: z.string().max(500).optional(),
  grant_types: z.array(z.string()).max(10).optional(),
  response_types: z.array(z.string()).max(10).optional(),
});

const REGISTER_LIMITS = (ip: string) => [{ key: `mcp:register:${ip}`, max: 20, windowMs: 60 * MINUTE }];

export async function handleRegister(request: Request): Promise<Response> {
  const limits = REGISTER_LIMITS(requestIp(request));
  if (!(await allow(limits))) return json({ error: "temporarily_unavailable", error_description: "Too many registrations. Try again later." }, 429, { "Retry-After": retryAfterSeconds(limits) });
  const body = await readCapped(request, 16 * 1024);
  if (body === null) return oauthError({ error: "invalid_request", description: "The registration is too large." }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return json({ error: "invalid_client_metadata", error_description: "Send the client metadata as JSON." }, 400);
  }
  const parsed = registrationSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid_client_metadata", error_description: "redirect_uris is required: one to ten URIs." }, 400);
  const meta = parsed.data;
  if (!meta.redirect_uris.every(isAllowedRedirectUri)) {
    return json({ error: "invalid_redirect_uri", error_description: "Redirect URIs must be https (or http on localhost, or a custom scheme) and have no fragment." }, 400);
  }
  if (meta.grant_types && !meta.grant_types.includes("authorization_code")) return json({ error: "invalid_client_metadata", error_description: "Only the authorization_code grant (and refresh_token) is supported." }, 400);
  if (meta.response_types && !meta.response_types.includes("code")) return json({ error: "invalid_client_metadata", error_description: "Only response_type code is supported." }, 400);
  const clientUri = meta.client_uri && /^https:\/\//.test(meta.client_uri) ? meta.client_uri : undefined;

  const client = await registerClient({ name: meta.client_name || "MCP app", redirectUris: [...new Set(meta.redirect_uris)], clientUri });
  return json(
    {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client: the PKCE verifier, not a secret, proves the token request is the one that started the flow.
      token_endpoint_auth_method: "none",
      scope: DEFAULT_SCOPES.join(" "),
    },
    201,
  );
}

// ── Token endpoint ───────────────────────────────────────────────

export async function handleToken(request: Request): Promise<Response> {
  const origin = siteOrigin(request);
  const limits = [{ key: `mcp:token:${requestIp(request)}`, max: 60, windowMs: MINUTE }];
  if (!(await allow(limits))) return json({ error: "temporarily_unavailable", error_description: "Too many requests." }, 429, { "Retry-After": retryAfterSeconds(limits) });
  const text = await readCapped(request, 16 * 1024);
  if (text === null) return oauthError({ error: "invalid_request", description: "The request is too large." }, 413);
  const form = new URLSearchParams(text);
  const field = (name: string) => form.get(name) ?? undefined;

  const clientId = field("client_id");
  if (!clientId) return oauthError({ error: "invalid_client", description: "client_id is required." }, 401);
  const client = await getClient(clientId);
  if (!client) return oauthError({ error: "invalid_client", description: "Unknown client_id." }, 401);
  if (!isOurResource(field("resource"), origin)) return oauthError({ error: "invalid_request", description: `resource must be ${resourceFor(origin)}.` });

  const grantType = field("grant_type");
  let result;
  if (grantType === "authorization_code") {
    const code = field("code");
    if (!code) return oauthError({ error: "invalid_request", description: "code is required." });
    result = await exchangeCode({ code, clientId, redirectUri: field("redirect_uri"), codeVerifier: field("code_verifier") });
  } else if (grantType === "refresh_token") {
    const refreshToken = field("refresh_token");
    if (!refreshToken) return oauthError({ error: "invalid_request", description: "refresh_token is required." });
    const scope = field("scope");
    const requested = scope ? parseScopes(scope) : null;
    if (requested && requested.unknown.length > 0) return oauthError({ error: "invalid_scope", description: `Unknown scope: ${requested.unknown.join(" ")}.` });
    result = await refreshTokens({ refreshToken, clientId, scope: requested?.scopes });
  } else {
    return oauthError({ error: "unsupported_grant_type", description: "Use authorization_code or refresh_token." });
  }
  if ("ok" in result) return oauthError(result);
  return json(result, 200, { Pragma: "no-cache" });
}

// ── Revocation (RFC 7009) ────────────────────────────────────────

export async function handleRevoke(request: Request): Promise<Response> {
  const limits = [{ key: `mcp:revoke:${requestIp(request)}`, max: 60, windowMs: MINUTE }];
  if (!(await allow(limits))) return json({ error: "temporarily_unavailable" }, 429, { "Retry-After": retryAfterSeconds(limits) });
  const text = await readCapped(request, 16 * 1024);
  if (text === null) return oauthError({ error: "invalid_request", description: "The request is too large." }, 413);
  const form = new URLSearchParams(text);
  const token = form.get("token");
  const clientId = form.get("client_id");
  if (!token || !clientId) return oauthError({ error: "invalid_request", description: "token and client_id are required." });
  await revokeToken(token, clientId);
  return json({}, 200);
}

// ── Authorization request (the consent screen's input) ───────────

export type AuthorizeParams = Record<string, string | string[] | undefined>;

export type AuthorizeCheck =
  /** The request cannot be trusted with a redirect (unknown app, redirect URI not registered): show the error here. */
  | { kind: "reject"; message: string }
  /** The redirect URI is the app's own; the error goes back to it. */
  | { kind: "bounce"; redirectUri: string; error: string; description: string; state: string | undefined }
  | { kind: "consent"; clientId: string; clientName: string; redirectUri: string; scopes: Scope[]; requested: Scope[]; codeChallenge: string; state: string | undefined };

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Validates an authorization request. Used when the consent screen is shown and again when the person answers it. */
export async function checkAuthorizeRequest(params: AuthorizeParams, origin: string): Promise<AuthorizeCheck> {
  const clientId = single(params.client_id);
  const redirectUri = single(params.redirect_uri);
  if (!clientId || !redirectUri) return { kind: "reject", message: "This link is missing the app or where to return to. Start again from the app." };
  const client = await getClient(clientId);
  if (!client) return { kind: "reject", message: "This app is not registered. Start again from the app." };
  if (!redirectUriMatches(client.redirectUris, redirectUri)) return { kind: "reject", message: "This app asked to return to an address it did not register, so ReelWalk will not continue." };

  const state = single(params.state);
  const bounce = (error: string, description: string): AuthorizeCheck => ({ kind: "bounce", redirectUri, error, description, state });
  if (single(params.response_type) !== "code") return bounce("unsupported_response_type", "response_type must be code.");
  const codeChallenge = single(params.code_challenge);
  if (!isCodeChallenge(codeChallenge)) return bounce("invalid_request", "A PKCE code_challenge (S256) is required.");
  if (single(params.code_challenge_method) !== "S256") return bounce("invalid_request", "code_challenge_method must be S256.");
  if (!isOurResource(single(params.resource), origin)) return bounce("invalid_target", `resource must be ${resourceFor(origin)}.`);
  const asked = parseScopes(single(params.scope));
  if (asked.unknown.length > 0) return bounce("invalid_scope", `Unknown scope: ${asked.unknown.join(" ")}.`);
  const requested = asked.scopes.length > 0 ? asked.scopes : [...DEFAULT_SCOPES];
  return { kind: "consent", clientId: client.id, clientName: client.name, redirectUri, scopes: requested, requested, codeChallenge, state };
}

/** Where the browser goes with the person's answer. `granted` is the scopes they left ticked; none means they declined. */
export async function completeAuthorization(check: Extract<AuthorizeCheck, { kind: "consent" }>, userId: string, granted: Scope[], origin: string): Promise<string> {
  const allowed = granted.filter((scope) => check.requested.includes(scope));
  if (allowed.length === 0) return withParams(check.redirectUri, { error: "access_denied", error_description: "The person declined.", state: check.state, iss: origin });
  const code = await approve({ userId, clientId: check.clientId, scopes: allowed, redirectUri: check.redirectUri, codeChallenge: check.codeChallenge, origin });
  return withParams(check.redirectUri, { code, state: check.state, iss: origin });
}
