import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CORS_HEADERS, MINUTE, allow, json, preflight, readCapped, requestIp, retryAfterSeconds, siteOrigin } from "./http";
import { resourceMetadataUrl } from "./oauth-http";
import { runAsUser } from "./acting-user";
import { verifyAccessToken } from "./oauth-store";
import { SCOPES } from "./scopes";
import { createMcpServer } from "./server";

/**
 * `POST /mcp`, the connector's MCP endpoint (ADR 0077): streamable HTTP, the
 * current MCP transport, run statelessly with plain JSON answers so any web
 * instance can serve any call. Every request carries `Authorization: Bearer`;
 * without a valid token the answer is 401 with a `WWW-Authenticate` header that
 * points at the protected-resource metadata, which is how a client finds the
 * authorization server and starts the OAuth flow (RFC 9728).
 */

/** A tool call is a few kilobytes; 50 commands with long titles still fit well inside this. */
export const MAX_BODY_BYTES = 256 * 1024;

function unauthorized(origin: string, error: "invalid_token" | null, description: string): Response {
  const parts = [`resource_metadata="${resourceMetadataUrl(origin)}"`, `scope="${SCOPES.join(" ")}"`];
  if (error) parts.push(`error="${error}"`, `error_description="${description}"`);
  return json({ error: error ?? "unauthorized", error_description: description }, 401, { "WWW-Authenticate": `Bearer ${parts.join(", ")}` });
}

const rpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}): Response =>
  json({ jsonrpc: "2.0", error: { code, message }, id: null }, status, headers);

/** Bearer-token guesses per address: the token space is huge, but a flood of bad ones is worth stopping. */
const failedAuthLimits = (request: Request) => [{ key: `mcp:badauth:${requestIp(request)}`, max: 30, windowMs: MINUTE }];

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return preflight();
  const origin = siteOrigin(request);

  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (!token) return unauthorized(origin, null, "Sign in to ReelWalk to use this server.");
  const badAuth = failedAuthLimits(request);
  const ctx = await verifyAccessToken(token, origin);
  if (!ctx) {
    // Counting only the failures keeps a legitimate client's traffic out of this limit.
    if (!(await allow(badAuth))) return json({ error: "temporarily_unavailable", error_description: "Too many invalid tokens." }, 429, { "Retry-After": retryAfterSeconds(badAuth) });
    return unauthorized(origin, "invalid_token", "The access token is missing, expired or revoked.");
  }

  // Stateless server: no standalone SSE stream (GET) and no sessions to close (DELETE).
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST, OPTIONS" });

  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return rpcError(413, -32600, `Request too large (limit ${MAX_BODY_BYTES / 1024} KB).`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, -32700, "Parse error: the body is not JSON.");
  }

  const server = createMcpServer({ user: ctx.user, scopes: ctx.scopes, origin });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await runAsUser(ctx.user, () =>
      transport.handleRequest(request, { parsedBody: body, authInfo: { token, clientId: ctx.clientId, scopes: ctx.scopes, expiresAt: Math.floor(ctx.expiresAt / 1000), resource: new URL(`${origin}/mcp`) } }),
    );
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
