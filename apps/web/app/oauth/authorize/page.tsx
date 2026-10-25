import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/icons";
import { getSessionUser } from "@/lib/auth";
import { appUrl } from "@/lib/app-url";
import { checkAuthorizeRequest, type AuthorizeParams } from "@/lib/mcp/oauth-http";
import { withParams } from "@/lib/mcp/oauth-core";
import { SCOPE_LABELS } from "@/lib/mcp/scopes";
import { OAuthConsentFields } from "@/components/oauth-consent-fields";
import { listWorkspaces } from "@/lib/workspaces";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connect an app · ReelWalk", robots: { index: false } };

const DEMO_EMAIL = "demo@reelwalk.local";

/**
 * The consent screen of the MCP connector's OAuth flow (ADR 0077). An app
 * (Claude, ChatGPT) sent the person here; they sign in as usual, see who is
 * asking and for what, untick anything they do not want to give, and answer.
 * The answer goes to ./decision, which checks the request again.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<AuthorizeParams> }) {
  const params = await searchParams;
  const user = await getSessionUser();
  if (!user) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (typeof value === "string") query.set(key, value);
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
  }

  const origin = await appUrl();
  const check = await checkAuthorizeRequest(params, origin);
  const workspaces = await listWorkspaces(user, user.workspaceId);
  if (check.kind === "bounce") redirect(withParams(check.redirectUri, { error: check.error, error_description: check.description, state: check.state, iss: origin }));

  return (
    <main className="auth">
      <header className="auth-brand">
        <span className="brand">
          <BrandMark />
          ReelWalk
        </span>
      </header>

      {check.kind === "reject" ? (
        <div className="auth-card" data-testid="oauth-error">
          <h1>Can&apos;t connect</h1>
          <p className="error small" role="alert">
            {check.message}
          </p>
        </div>
      ) : user.email === DEMO_EMAIL ? (
        <div className="auth-card" data-testid="oauth-error">
          <h1>Use your own account</h1>
          <p className="muted">The shared demo studio can&apos;t be connected to other apps. Sign out and create your own account first.</p>
        </div>
      ) : (
        <form method="post" action="/oauth/authorize/decision" className="auth-card" data-testid="oauth-consent">
          <h1>Connect {check.clientName}?</h1>
          <p className="muted small">
            {check.clientName} wants to work in {workspaces.length > 1 ? "one of your workspaces" : user.workspace.name} as {user.email}. It can use only what you leave ticked, and it cannot post to Instagram or schedule posts.
          </p>
          <input type="hidden" name="client_id" value={check.clientId} />
          <input type="hidden" name="redirect_uri" value={check.redirectUri} />
          <input type="hidden" name="code_challenge" value={check.codeChallenge} />
          <input type="hidden" name="state" value={check.state ?? ""} />
          <input type="hidden" name="requested" value={check.requested.join(" ")} />
          <OAuthConsentFields workspaces={workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name, ai: workspace.ai }))} activeId={user.workspaceId} requested={check.requested} labels={SCOPE_LABELS} />
          <p className="muted small">You can disconnect it any time under Account, Connected apps.</p>
          <button className="btn btn-block" type="submit" name="decision" value="allow" data-testid="oauth-allow">
            Allow
          </button>
          <button className="btn btn-quiet btn-block" type="submit" name="decision" value="deny" formNoValidate data-testid="oauth-deny">
            Cancel
          </button>
        </form>
      )}
    </main>
  );
}
