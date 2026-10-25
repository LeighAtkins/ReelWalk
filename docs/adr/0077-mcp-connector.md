# 77. A one-link connector: ReelWalk as a remote MCP server

Date: 2026-10-25

## Context

Higgsfield grew by being a connector: in Claude, *Add custom connector*, paste
`https://mcp.higgsfield.ai/mcp`, sign in, and the assistant drives the product.
The owner's reels are already built by agents over HTTP (`/api/...`, the
document commands of ADR 0048/0068, the frame, check and audio-trace routes of
ADR 0071/0066), but only by an agent running inside a signed-in browser tab
or holding a minted session cookie. A person in Claude or ChatGPT has neither.

The MCP specification (2025-11-25, the version the installed SDK ships) defines
the missing piece: a remote server on the **streamable HTTP** transport that
protects itself with **OAuth 2.1**: PKCE, protected-resource metadata
(RFC 9728) reached from the 401's `WWW-Authenticate`, authorization-server
metadata (RFC 8414), **dynamic client registration** (RFC 7591) so a client the
server has never heard of can connect, and resource indicators (RFC 8707) so a
token is only good for this server.

## Decision

ReelWalk serves an MCP server at **`https://reelwalking.com/mcp`**, with its own
OAuth 2.1 authorization server backed by the app's existing accounts, a help
page at `/connect`, and a "Connected apps" list on the account page. It is
read/write for reels and exports and **cannot post or schedule**: Instagram
posting is not a scope and not a tool.

### Endpoints

| Path | What |
|---|---|
| `POST /mcp` | The MCP endpoint (streamable HTTP, stateless, JSON answers) |
| `GET /.well-known/oauth-protected-resource/mcp` (and without `/mcp`) | RFC 9728 metadata: resource `…/mcp`, this site as its authorization server |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata: S256 only, public clients, scopes, endpoints |
| `POST /oauth/register` | RFC 7591 dynamic registration |
| `GET /oauth/authorize` | The consent page (a page, so a signed-out person goes through the usual login and comes back) |
| `POST /oauth/authorize/decision` | The person's answer to it |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants |
| `POST /oauth/revoke` | RFC 7009 |
| `GET /connect` | Public help: the link, Claude and ChatGPT steps, what it can and cannot do |

### Authorization (`apps/web/lib/mcp/oauth-*.ts`)

- **Public clients with PKCE (S256 only).** Registration answers
  `token_endpoint_auth_method: none`; the code verifier is the proof. `plain` and
  a missing challenge are refused. Redirect URIs must be https, plain http only
  on loopback (any port, RFC 8252), or a custom scheme; no fragments, no
  `javascript:`/`data:`/`file:`. The consent page and decision both re-check that
  the redirect URI is one the client registered, and never redirect to one that
  is not (the error is shown on our page instead).
- **Tokens are opaque and stored as SHA-256 only**, with a prefix (`rwc_` code,
  `rwa_` access, `rwr_` refresh). Code: 5 minutes, single use, claimed with an
  atomic `updateMany`. Access token: 1 hour. Refresh token: 30 days, **rotated on
  every use**. Presenting a spent code or a spent refresh token means a copy is
  out there, so **the whole grant ends** (all its tokens deleted, the grant
  marked revoked) and the person must consent again.
- **A token is bound to this server** (`resource` = `https://<origin>/mcp`,
  checked at the token endpoint, stored on the code and tokens, and compared on
  every call), so a token minted for another deployment, or for another
  resource, is refused.
- **Scopes**: `reels:read`, `reels:write`, `exports`, `ai:generate`. The consent
  page lists what the app asked for as checkboxes; the person can untick, never
  add (the decision intersects the ticked boxes with the original request, read
  again server-side). Defaults when an app asks for nothing: read, write,
  exports; **`ai:generate` is never granted unless asked for and left ticked**.
  A token carries its scopes; each tool checks them again.
- **One grant per person and app** (`OAuthGrant`, unique on user + client). The
  account page lists them (app, scopes, connected, last used, written at most
  every 5 minutes) with **Disconnect**, which revokes the grant and deletes its
  tokens; the next call from the app is a 401 `invalid_token`.
- **The consent answer is a small HTML page, not a 302.** The site's CSP has
  `form-action 'self'`, which browsers apply to the redirect after a form post, so
  a 302 to `claude.ai` would be blocked. The page navigates with
  `location.replace` and a visible link. The route requires `Origin` equal to the
  site's and the session cookie (SameSite=Lax is not sent cross-site), so
  another site cannot approve for the person. The shared demo account cannot
  connect apps.

### The MCP server (`lib/mcp/endpoint.ts`, `server.ts`, `tools.ts`)

- **Stateless streamable HTTP, JSON responses** (SDK
  `WebStandardStreamableHTTPServerTransport`, `sessionIdGenerator: undefined`,
  `enableJsonResponse: true`): a new server and transport per request, so any
  web instance can answer any call and nothing lives between requests. `GET`
  and `DELETE` answer 405 (no standalone stream, no session to close).
- **401 with the discovery pointer.** No token → 401 with
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="…"`;
  a bad, expired or revoked token adds `error="invalid_token"`. Failed
  attempts are counted per address (30 a minute, then 429).
- **Who the tools act as.** After checking the token, the route runs the request
  inside `runAsUser(user, …)` (an `AsyncLocalStorage`, `lib/mcp/acting-user.ts`);
  `getSessionUser()` in `lib/auth.ts` returns that person first when it is set.
  So `createUpload`, `confirmUpload`, `queueReelExport`, `createAiGeneration`
  and the rest run unchanged with their own workspace scoping, plan limits and
  credit gates. Only `/mcp` ever sets it, and `/mcp` never reads a cookie.
  (`lib/auth.ts` gained four lines; this is the one shared-file change.)
- **Tools** (each is data in `tools.ts`: name, LLM-facing description, a zod
  shape, scopes, read-only or write):

| Tool | Scope | Does |
|---|---|---|
| `list_reels` | read | The person's reels: id, title, revision, duration, last export |
| `get_reel` | read | The cut as a summary (clips with ids and times, titles, music), revision, media used, last export, export-blocking `issues`; `full: true` adds the timeline |
| `list_media` | read | Library media (own uploads/stock/AI; `includeStarter` adds the shared set) |
| `search_stock` | read | The ADR 0070 coherent stock search (sets from one creator and shoot), 30 an hour |
| `create_reel` | write | A new reel, optionally with library photos/videos placed in order with the editor's defaults |
| `add_media` | write | `stock` (import by id, licence recorded), `library` (place existing media), `prepare_upload` / `finish_upload` (a presigned PUT for agents that can send HTTP, ≤ 32 MB); optional `reelId` appends clips as a new revision |
| `apply_commands` | read (dry run) / write | `{ commands[], revision?, dryRun? }` through the same `applyReelCommand` as `POST /api/reels/:id/commands`; the type list **is** `COMMAND_TYPES` (minus `batch`/`applyProposal`, which a batch cannot hold) |
| `get_frames` | read | ADR 0071 frames of a finished export as images: one contact sheet by default |
| `get_checks` | read | ADR 0071 render checks plus the ADR 0066 sound problems, and the gate |
| `get_audio_trace` | read | ADR 0066 audio trace for a reel |
| `export_reel` | exports | `queueReelExport`: the same checks, plan limits and queue as the Export button |
| `get_export` | exports | Status, progress, and short-lived play/download URLs when done |
| `generate_ai_shot`, `get_ai_shot` | ai:generate / read | AI video, see below |

  The brief's eleven tools plus `list_media` (without it an agent cannot name
  the person's uploads), and the two AI tools. Descriptions are written for the
  model and repeat the **house style** where an agent edits: no boxed text, no
  whoosh sounds, a cut or visual change inside the first second, a title from
  frame 0 under seven words and above y 0.72. The same text is the server's
  `instructions`. `apply_commands` carries a cheat sheet of the common commands
  with their fields; a test checks every name in it is still a core command.
- **AI shots keep every gate.** `generate_ai_shot` needs `ai:generate`, and its
  first call only **quotes** (credits, cents, the balance) and spends nothing; it
  starts the shot only when called again with `confirmCredits` equal to the quote,
  through `createAiGeneration` (balance, storage, the `AI_VIDEO_BUDGET_CENTS`
  ceiling, reference rules, the idempotent `requestId`), at most 10 an hour. The
  assistant is told to ask the person first.
- **Every write is a revision.** Reel changes go through `saveReelFor` (the
  editor's autosave path: revision check, `revision + 1`, workspace-scoped
  media check), so a change made through the connector is a normal revision
  that a tab sees and that a stale revision conflicts with (409, with the
  current revision returned).

### Safety

- **Rate limits**, per person (Postgres fixed windows in the existing
  `AuthThrottle` table, shared by every instance): 120 calls a minute, 30 writes a
  minute, and per tool per hour: stock 30, imports/uploads 12, frames and checks
  60, exports 10, AI 10. Per address: 20 registrations an hour, 60 token and 60
  revoke requests a minute, 30 bad bearer tokens a minute.
- **Size caps**: MCP bodies 256 KB (the header and the stream are both
  counted), OAuth bodies 16 KB, ≤ 50 commands, ≤ 30 media per reel build, uploads
  ≤ 32 MB through the connector.
- **Errors do not leak**: an exception becomes "failed on the server" with the
  details only in the log. A reel or export in another workspace reads as
  missing.
- **CORS `*`** on the connector endpoints: they authenticate with a bearer
  token, never a cookie, so an open origin cannot act as a signed-in browser;
  browser-based clients (the MCP inspector) need it.

## Migration

**There is a Prisma migration: `20261025010000_mcp_oauth`. `ship.sh` does not
apply migrations; it must be run (`prisma migrate deploy`) before the web
deploy that contains this change, or `/mcp`, `/oauth/*` and the account page
fail.** It is additive only: one enum (`OAuthTokenKind`) and four new tables
(`OAuthClient`, `OAuthGrant`, `OAuthCode`, `OAuthToken`) with their indexes and
foreign keys (grants cascade from `User`). Nothing existing is altered.
Rolling back is leaving the tables unused.

## Consequences

- A person can add one link in Claude or ChatGPT and edit their own reels by
  chatting; the same capability is reachable by any MCP client.
- The attack surface grows by an authorization server. It is small (no client
  secrets, no password grant, no implicit flow, no scopes beyond four), but it
  is new: the places to look are `oauth-store.ts` (reuse detection, atomic
  claims) and the decision route (CSRF, redirect URI re-check).
- **Clients that cannot be public clients cannot connect.** Registration always
  answers `none`; a client that insists on a client secret will fail at token
  time. Claude, ChatGPT, Cursor and the MCP inspector use public clients with PKCE.
- **Stateless means no server-to-client messages** (progress notifications,
  sampling, elicitation). Long work (export, AI shots) is polled with
  `get_export` / `get_ai_shot`, which is what the tool descriptions say.
- **Uploads through the connector** are for agents that can send HTTP
  requests (a code sandbox); a chat that only talks cannot hand over a file.
  Bigger than 32 MB (multipart) is left to the app. Stock and the library cover
  the common case.
- **Concurrent refreshes from one client kill the grant**: two refreshes racing
  with the same token look like reuse. Well-behaved clients serialise refreshes;
  if one does not, the person reconnects.
- The editor's `clipFromAsset` lives in a client component, so `lib/mcp/clips.ts`
  has a server copy with the same defaults (a photo 3 s with a push-in, a 360
  photo 5 s with a sweep, a video whole). If the editor's defaults change, change
  both.
- The npm package `@modelcontextprotocol/sdk` is pinned at 1.32.2 (the
  version the brief names, the latest of that package). A v2 split into
  `@modelcontextprotocol/server` exists; moving to it is a later, mechanical
  change confined to `lib/mcp/server.ts` and `endpoint.ts`.

## Not done

- Not connected to a real Claude or ChatGPT: this needs the deployed HTTPS URL
  and the owner's accounts. Verified instead with the SDK's own client against
  `next dev` (below). The menu names on `/connect` for ChatGPT are from memory of
  the current app and are hedged on the page.
- Tools that need S3, ffmpeg, SQS or Veo (`add_media` imports and uploads,
  `get_frames`, `get_checks`, `export_reel`, `generate_ai_shot`) are verified
  against stubs, not live; the local run has no storage, queue or Google.
- No tool for the shoot planner, venue reels, presenters or stories; they can
  follow as tools over the same pattern.
- No Instagram posting or scheduling through the connector, on purpose (first
  version).
- Client Metadata Documents (the 2025-11-25 alternative to dynamic
  registration) are not implemented; dynamic registration is what Claude and
  ChatGPT use today.

## What was verified

See the pull request for the exact commands and output. In short:

- Unit tests (`apps/web/lib/mcp/*.test.ts`): PKCE against the RFC 7636 vector,
  redirect-URI rules, secrets stored only as hashes; the whole code → token →
  refresh → revoke lifecycle against an in-memory stand-in for Prisma (replay
  ends the grant, refresh rotation and theft detection, scope narrowing but
  never widening, expiry, app and resource binding, one person cannot revoke
  another's grant); registration, token, revoke and the authorization checks as
  HTTP; the consent answer (CSRF, demo account, edited form, HTML escaping); the
  MCP endpoint through the real SDK transport (401 and `WWW-Authenticate`,
  405, 413, 429, initialize, tools/list, a call acting as the right person,
  scope refusal, schema refusal); every tool against stubbed database and
  library layers, including the style hints, the command list coming from the
  registry, the write list, scope and rate-limit gates.
- `apps/web/scripts/mcp-smoke.mts`: the SDK's own client against `next dev` on a
  throwaway Postgres: discovery from the 401, registration, consent (including a
  forged cross-site answer), PKCE exchange, tools, a dry run that changes
  nothing, a saved batch as revision 1, a stale revision refused, the app listed
  under Connected apps, an expired access token refreshed by the client on its
  own, an invented refresh token refused, revocation, and the 401 afterwards.
