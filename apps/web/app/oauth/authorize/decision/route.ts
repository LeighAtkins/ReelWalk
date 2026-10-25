import { prisma } from "@reelwalk/db";
import { aiSwitchOf } from "@/lib/ai-gate";
import { getSessionUser } from "@/lib/auth";
import { siteOrigin } from "@/lib/mcp/http";
import { grantableScopes } from "@/lib/mcp/consent";
import { checkAuthorizeRequest, completeAuthorization } from "@/lib/mcp/oauth-http";
import { isScope, type Scope } from "@/lib/mcp/scopes";
import { seatRole } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEMO_EMAIL = "demo@reelwalk.local";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function page(status: number, title: string, body: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1>${body}`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

/**
 * The person's answer to the consent screen (ADR 0077). The browser cannot be
 * sent straight to the app with a 302: the site's CSP `form-action 'self'`
 * applies to the redirect that follows a form post, so the answer is a small
 * page that navigates there. The request is checked again in full (the hidden
 * fields are only the browser's word), the form must come from this site, and
 * the session cookie must be present, so another site cannot make the
 * approval for the person.
 */
export async function POST(request: Request) {
  const origin = siteOrigin(request);
  if (request.headers.get("origin") !== origin) return page(403, "Request refused", "<p>This answer did not come from ReelWalk.</p>");
  const user = await getSessionUser();
  if (!user) return page(401, "Signed out", "<p>You were signed out. Start again from the app.</p>");
  if (user.email === DEMO_EMAIL) return page(403, "Use your own account", "<p>The shared demo studio can't be connected to other apps.</p>");

  const form = await request.formData();
  const field = (name: string) => (typeof form.get(name) === "string" ? (form.get(name) as string) : undefined);
  const check = await checkAuthorizeRequest(
    {
      response_type: "code",
      client_id: field("client_id"),
      redirect_uri: field("redirect_uri"),
      code_challenge: field("code_challenge"),
      code_challenge_method: "S256",
      state: field("state") || undefined,
      scope: field("requested"),
    },
    origin,
  );
  if (check.kind !== "consent") return page(400, "Can't connect", `<p>${escapeHtml(check.kind === "reject" ? check.message : check.description)}</p>`);

  // The workspace the connection will act on (ADR 0079): one the person holds a seat in, else refused.
  const workspaceId = field("workspace") ?? user.workspaceId;
  const workspace = (await seatRole(user.id, user.homeWorkspaceId, workspaceId)) ? await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, aiGeneration: true } }) : null;
  if (!workspace) return page(403, "Can't connect", "<p>That workspace is not one of yours.</p>");

  const granted = form.getAll("scope").filter((value): value is Scope => typeof value === "string" && isScope(value));
  const allowed = field("decision") === "allow" ? granted : [];
  const aiOn = aiSwitchOf(workspace.aiGeneration) === "on";
  const effective = grantableScopes(allowed, check.requested, aiOn);
  const target = await completeAuthorization(check, user.id, { id: workspace.id, aiOn }, allowed, origin);
  const safe = escapeHtml(target);
  return page(
    200,
    effective.length > 0 ? `Connected to ${check.clientName}` : "Cancelled",
    `<p>Returning to ${escapeHtml(check.clientName)}. If nothing happens, <a href="${safe}">continue</a>.</p><meta http-equiv="refresh" content="0;url=${safe}"><script>location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")})</script>`,
  );
}
