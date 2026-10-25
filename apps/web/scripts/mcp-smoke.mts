/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end smoke test of the MCP connector (ADR 0077) against a running
 * app, using the official MCP SDK client: discovery from the 401, dynamic
 * registration, the consent screen, PKCE token exchange, tool calls,
 * automatic refresh when the access token has expired, and revocation.
 *
 *   MCP_BASE=http://localhost:3000 MCP_SESSION=<rw_session cookie value> \
 *   MCP_ASSET_ID=<a library video id> [MCP_EXPIRE_SQL_CMD=...] pnpm -C apps/web tsx scripts/mcp-smoke.mts
 *
 * MCP_SESSION stands in for the person's signed-in browser: the cookie is
 * sent to /oauth/authorize and /account only; the SDK client never sees it.
 * The script expires the access token itself through `MCP_EXPIRE_CMD` (a
 * shell command that runs SQL to expire tokens); without it the refresh step
 * is skipped.
 */
import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const base = (process.env.MCP_BASE ?? "http://localhost:3000").replace(/\/$/, "");
const session = process.env.MCP_SESSION ?? "";
const assetId = process.env.MCP_ASSET_ID ?? "";
const expireCmd = process.env.MCP_EXPIRE_CMD;
if (!session) throw new Error("Set MCP_SESSION to a signed-in rw_session cookie value.");

let failures = 0;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!pass) failures++;
};

/** The browser step: open the consent screen as the signed-in person, tick what is offered, press Allow. */
async function consent(authorizationUrl: URL): Promise<string> {
  const page = await fetch(authorizationUrl, { headers: { cookie: `rw_session=${session}` }, redirect: "manual" });
  const html = (await page.text()).replace(/<!-- -->/g, "");
  check("consent screen shows who is asking and the permissions", page.status === 200 && html.includes("Connect smoke-test client") && html.includes("See your reels and media"), `status ${page.status}`);
  const fields = new Map<string, string[]>();
  for (const match of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(match[0])?.[1];
    const value = /value="([^"]*)"/.exec(match[0])?.[1] ?? "";
    if (name) fields.set(name, [value.replace(/&amp;/g, "&").replace(/&quot;/g, '"')]);
  }
  const body = new URLSearchParams();
  for (const [name, [value]] of fields) body.set(name, value);
  for (const match of html.matchAll(/<input[^>]*type="checkbox"[^>]*name="scope"[^>]*value="([^"]+)"/g)) body.append("scope", match[1]);
  body.set("decision", "allow");
  // A form posted from another site must be refused.
  const forged = await fetch(`${base}/oauth/authorize/decision`, { method: "POST", headers: { cookie: `rw_session=${session}`, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body });
  check("a cross-site answer to the consent screen is refused", forged.status === 403, `status ${forged.status}`);
  const answered = await fetch(`${base}/oauth/authorize/decision`, { method: "POST", headers: { cookie: `rw_session=${session}`, origin: base, "content-type": "application/x-www-form-urlencoded" }, body });
  const answer = await answered.text();
  const target = /<a href="([^"]+)">continue<\/a>/.exec(answer)?.[1]?.replace(/&amp;/g, "&");
  if (!target) throw new Error(`No redirect in the consent answer: ${answer.slice(0, 300)}`);
  const redirected = new URL(target);
  check("the answer returns the code and the state to the app's own redirect URI", redirected.searchParams.has("code") && redirected.searchParams.get("state") === authorizationUrl.searchParams.get("state"));
  return redirected.searchParams.get("code")!;
}

class Provider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authorizationUrl?: URL;
  refreshes = 0;
  get redirectUrl() {
    return "http://localhost:6274/oauth/callback";
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "smoke-test client", redirect_uris: [this.redirectUrl], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    if (this.saved) this.refreshes++;
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

const text = (result: unknown) => JSON.parse(((result as { content: { text: string }[] }).content[0]).text) as Record<string, any>;

async function main() {
  // 1. No token: 401 that tells a client where to start.
  const bare = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const challenge = bare.headers.get("www-authenticate") ?? "";
  check("unauthenticated /mcp answers 401 with resource_metadata", bare.status === 401 && /resource_metadata="[^"]+oauth-protected-resource\/mcp"/.test(challenge), challenge);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  const resource = await (await fetch(metadataUrl!)).json();
  check("protected-resource metadata names /mcp and this server as its authorization server", resource.resource === `${base}/mcp` && resource.authorization_servers?.[0] === base);
  const server = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  check("authorization-server metadata offers S256 only and registration", JSON.stringify(server.code_challenge_methods_supported) === '["S256"]' && Boolean(server.registration_endpoint));

  // 2. The SDK client does the whole dance.
  const provider = new Provider();
  const connect = async () => {
    const client = new Client({ name: "smoke", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
    try {
      await client.connect(transport);
      return { client, transport };
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      const code = await consent(provider.authorizationUrl!);
      await transport.finishAuth(code);
      const second = new Client({ name: "smoke", version: "1" });
      const next = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
      await second.connect(next);
      return { client: second, transport: next };
    }
  };
  const { client } = await connect();
  check("client registered itself and holds a bearer token", Boolean(provider.info?.client_id) && Boolean(provider.saved?.access_token?.startsWith("rwa_")) && Boolean(provider.saved?.refresh_token?.startsWith("rwr_")));
  check("authorization URL carried PKCE S256 and the resource", provider.authorizationUrl?.searchParams.get("code_challenge_method") === "S256" && provider.authorizationUrl?.searchParams.get("resource") === `${base}/mcp`);
  const instructions = client.getInstructions() ?? "";
  check("server instructions carry the house style", /no boxed/i.test(instructions) && /cannot post to Instagram/i.test(instructions));

  // 3. Tools.
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  check("tools/list has the promised tools", ["list_reels", "get_reel", "create_reel", "search_stock", "add_media", "apply_commands", "get_frames", "get_checks", "get_audio_trace", "export_reel", "get_export"].every((name) => names.includes(name)), `${names.length} tools`);
  const created = text(await client.callTool({ name: "create_reel", arguments: { title: "Smoke reel", mediaIds: assetId ? [assetId, assetId] : [] } }));
  check("create_reel", created.ok === true && typeof created.reelId === "string", JSON.stringify(created).slice(0, 160));
  const listed = text(await client.callTool({ name: "list_reels", arguments: {} }));
  check("list_reels sees the new reel", listed.reels.some((reel: any) => reel.id === created.reelId));
  const read = text(await client.callTool({ name: "get_reel", arguments: { reelId: created.reelId } }));
  check("get_reel returns the cut and its revision", read.ok && read.revision === 0 && read.clips.length === (assetId ? 2 : 0), `revision ${read.revision}, clips ${read.clips?.length}`);
  if (assetId) {
    const clipId = read.clips[0].id as string;
    const dry = text(await client.callTool({ name: "apply_commands", arguments: { reelId: created.reelId, revision: 0, dryRun: true, commands: [{ type: "setSpeed", clipId, speed: 2 }] } }));
    const after = text(await client.callTool({ name: "get_reel", arguments: { reelId: created.reelId } }));
    check("apply_commands dryRun changes nothing", dry.ok && dry.dryRun === true && after.revision === 0, `revision ${after.revision}`);
    const real = text(await client.callTool({ name: "apply_commands", arguments: { reelId: created.reelId, revision: 0, commands: [{ type: "setSpeed", clipId, speed: 2 }, { type: "setTransition", clipId: read.clips[1].id, transition: "fade" }] } }));
    check("apply_commands saves a batch as one new revision", real.ok && real.revision === 1 && real.changes.length > 0, `revision ${real.revision}`);
    const stale = text(await client.callTool({ name: "apply_commands", arguments: { reelId: created.reelId, revision: 0, commands: [{ type: "setSpeed", clipId, speed: 1 }] } }));
    check("a stale revision is refused with the current one", stale.ok === false && stale.status === 409 && stale.currentRevision === 1);
  }
  const unknown = await client.callTool({ name: "get_reel", arguments: { reelId: "not-mine" } });
  check("a reel that is not the person's reads as missing", (unknown as { isError?: boolean }).isError === true);
  const blocked = await client.callTool({ name: "create_reel", arguments: { mediaIds: ["someone-elses-asset"] } });
  check("media that is not the person's is refused", (blocked as { isError?: boolean }).isError === true);

  // 4. Connected apps on the account page.
  const account = await (await fetch(`${base}/account`, { headers: { cookie: `rw_session=${session}` } })).text();
  check("Account lists the app under Connected apps", account.includes("Connected apps") && account.includes("smoke-test client"));

  // 5. Expired access token: the client refreshes by itself.
  if (expireCmd) {
    const before = provider.saved!.access_token;
    execSync(expireCmd, { stdio: "ignore" });
    const again = text(await client.callTool({ name: "list_reels", arguments: {} }));
    check("after the access token expires the client refreshes and carries on", again.ok === true && provider.refreshes >= 1 && provider.saved!.access_token !== before, `${provider.refreshes} refresh(es)`);
    const oldRefresh = (await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: provider.info!.client_id, refresh_token: "rwr_not-a-real-token" }) }));
    check("an invented refresh token is refused", oldRefresh.status === 400);
  }

  // 6. Revocation (the token endpoint of RFC 7009): every token stops working.
  const revoke = await fetch(`${base}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: provider.saved!.refresh_token!, client_id: provider.info!.client_id }) });
  check("revoke answers 200", revoke.status === 200);
  const dead = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${provider.saved!.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  check("after revocation the access token gets 401 invalid_token", dead.status === 401 && (dead.headers.get("www-authenticate") ?? "").includes("invalid_token"), `status ${dead.status}`);
  await client.close().catch(() => undefined);
}

await main();
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
