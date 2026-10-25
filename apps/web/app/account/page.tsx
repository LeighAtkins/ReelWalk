import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { prisma } from "@reelwalk/db";
import { changePassword, deleteAccount, signOut, updateProfile } from "@/app/auth-actions";
import { buyAiCredits, openBillingPortal, startCheckout } from "@/app/billing-actions";
import { getAiBalance } from "@/lib/ai-video";
import { aiTopUpPrice } from "@/lib/billing-ai";
import { disconnectInstagram } from "@/app/instagram-actions";
import { disconnectApp } from "@/app/mcp-actions";
import { listGrants } from "@/lib/mcp/oauth-store";
import { SCOPE_LABELS } from "@/lib/mcp/scopes";
import { deleteCommentTrigger, disconnectCommentReplies, saveCommentTrigger, toggleCommentTrigger } from "@/app/comment-reply-actions";
import { FeedbackForm } from "@/components/feedback-form";
import { AI_TOP_UP, formatAud, outputSize, PLANS, PRICE_SMALL_PRINT } from "@reelwalk/core";
import { isInstagramConfigured } from "@/lib/instagram";
import { isMessagingConfigured } from "@/lib/instagram-messaging";
import { aiEditUsage } from "@/lib/ai-edit";
import { exportsThisMonth, storageUsed, workspacePlan } from "@/lib/plans";
import { isBillingConfigured } from "@/lib/stripe";
import { SubmitButton } from "@/components/submit-button";
import { createWorkspace, setWorkspaceAi, switchWorkspace } from "@/app/workspace-actions";
import { listWorkspaces } from "@/lib/workspaces";
import { canManage } from "@/lib/workspace-access";
import { TabBar } from "@/components/tab-bar";
import { getCurrentUser, mediaScope } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Account · ReelWalk" };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; saved?: string; error?: string; instagram?: string; billing?: string; feedback?: string; message?: string; replies?: string }>;
}) {
  const { workspace: workspaceNote, saved, error, instagram: igStatus, billing, feedback, message, replies: repliesStatus } = await searchParams;
  const user = await getCurrentUser();
  const aiBalance = await getAiBalance(user.workspaceId);
  const workspaces = await listWorkspaces(user, user.workspaceId);
  const aiOff = user.workspace.aiGeneration === "off";
  const owner = canManage(user.role);
  const [reels, exports, own, shared, sessions, instagram, current, usedThisMonth, usedBytes, aiUsage, triggers, recentReplies, connectedApps] = await Promise.all([
    prisma.reel.count({ where: { workspaceId: user.workspaceId } }),
    prisma.renderJob.count({ where: { workspaceId: user.workspaceId, status: "SUCCEEDED", kind: { not: "PREVIEW" } } }),
    prisma.mediaAsset.count({ where: { workspaceId: user.workspaceId, shared: false } }),
    prisma.mediaAsset.count({ where: { ...mediaScope(user.workspaceId), shared: true } }),
    prisma.session.count({ where: { userId: user.id, expiresAt: { gt: new Date() } } }),
    prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } } }),
    workspacePlan(user.workspaceId),
    exportsThisMonth(user.workspaceId),
    storageUsed(user.workspaceId),
    aiEditUsage(user.workspaceId),
    prisma.commentTrigger.findMany({
      where: { workspaceId: user.workspaceId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { replies: { where: { status: "SENT" } } } } },
    }),
    prisma.commentReply.findMany({ where: { trigger: { workspaceId: user.workspaceId } }, orderBy: { createdAt: "desc" }, take: 10, include: { trigger: { select: { keyword: true } } } }),
    listGrants(user.id),
  ]);
  const { plan } = current;
  const usedGb = usedBytes / 1024 ** 3;
  const billingOn = isBillingConfigured();
  // The next plan up, if there is one to offer.
  const next = current.id === "FREE" ? PLANS.AGENT : current.id === "AGENT" ? PLANS.OFFICE : null;

  return (
    <>
      <main className="shell">
        <h1 style={{ marginBottom: 4 }}>{user.workspace.name}</h1>
        <p className="muted small" style={{ marginBottom: 20 }}>
          Studio since <LocalTime date={user.workspace.createdAt} />
        </p>

        <ul className="stat-row">
          <li>
            <strong>{reels}</strong>
            <span>reels</span>
          </li>
          <li>
            <strong>{exports}</strong>
            <span>exports</span>
          </li>
          <li>
            <strong>{own}</strong>
            <span>your media</span>
          </li>
          <li>
            <strong>{shared}</strong>
            <span>starter library</span>
          </li>
        </ul>

        <section className="card" id="plan" data-testid="plan-card" data-plan={current.id}>
          <h2>
            {plan.name} plan
            {plan.priceAud > 0 && !current.comped ? <span className="muted"> · {formatAud(plan.priceAud)}/month</span> : null}
          </h2>
          {current.comped ? (
            <p className="muted small">
              Tester access: {plan.name} is on the house until <LocalTime date={current.compedUntil!} />. Thank you for trying ReelWalk early.
            </p>
          ) : current.planRenewsAt ? (
            <p className="muted small">
              Renews <LocalTime date={current.planRenewsAt} />.
            </p>
          ) : null}
          <dl className="usage">
            <div>
              <dt>Exports this month</dt>
              <dd>
                <meter min={0} max={plan.exportsPerMonth} value={Math.min(usedThisMonth, plan.exportsPerMonth)} />
                <span>
                  {usedThisMonth} of {plan.exportsPerMonth}
                </span>
              </dd>
            </div>
            <div>
              <dt>Your uploads</dt>
              <dd>
                <meter min={0} max={plan.storageGb} value={Math.min(usedGb, plan.storageGb)} />
                <span>
                  {usedGb < 0.1 ? "under 0.1" : usedGb.toFixed(1)} of {plan.storageGb} GB
                </span>
              </dd>
            </div>
            <div>
              <dt>Export size</dt>
              <dd>
                {outputSize(plan.outputWidth).width}×{outputSize(plan.outputWidth).height}
                {plan.watermark ? ", with a small ReelWalk mark" : ", no mark"}
              </dd>
            </div>
            <div>
              <dt>Post to Instagram</dt>
              <dd>{plan.instagram ? "One tap from the export screen" : "Share sheet or link"}</dd>
            </div>
            {aiUsage ? (
              <div>
                <dt>Changes asked for in words</dt>
                <dd data-testid="ai-usage">
                  {aiUsage.used} of {aiUsage.allowed} this month
                </dd>
              </div>
            ) : null}
          </dl>
          {billing === "welcome" ? (
            <p className="toast" role="status">
              Thank you. Your plan updates within a few seconds; reload if it has not.
            </p>
          ) : null}
          {billing === "unavailable" ? (
            <p className="error small" role="alert">
              Billing is not available right now. Try again in a minute.
            </p>
          ) : null}
          {billingOn && next ? (
            <form action={startCheckout}>
              <input type="hidden" name="plan" value={next.id} />
              <p className="muted small">
                {next.name}: {next.exportsPerMonth} exports a month at 1080×1920 with no mark, {next.storageGb} GB of uploads, one-tap posting to
                Instagram{next.seats > 1 ? `, ${next.seats} people` : ""}. {formatAud(next.priceAud)}/month, cancel any time.
              </p>
              <SubmitButton className="btn btn-block" pendingLabel="Opening checkout…" testId="upgrade">
                Upgrade to {next.name}
              </SubmitButton>
            </form>
          ) : null}
          <p className="muted small" style={{ marginBottom: 0 }}>
            <Link href="/pricing" data-testid="see-plans">
              Compare all plans and yearly prices
            </Link>
          </p>
          <p className="muted small" style={{ marginBottom: 0 }}>{PRICE_SMALL_PRINT}</p>
          {billingOn && current.stripeCustomerId ? (
            <form action={openBillingPortal}>
              <SubmitButton className="btn btn-quiet btn-block" pendingLabel="Opening…" testId="billing-portal">
                Manage billing
              </SubmitButton>
            </form>
          ) : null}
        </section>

        <section className="card" id="workspaces" data-testid="workspaces-card">
          <h2>Workspaces</h2>
          <p className="muted small">One sign-in, several workspaces. Each has its own reels, media library, Instagram account, scheduled posts, AI credits and plan.</p>
          {workspaceNote ? <p className="toast" role="status">{workspaceNote === "denied" ? "That workspace is not one of yours." : workspaceNote === "owner" ? "Only an owner can change that." : workspaceNote}</p> : null}
          {saved === "ai" ? <p className="toast" role="status">Saved.</p> : null}
          <ul className="ws-list">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <form action={switchWorkspace}>
                  <input type="hidden" name="workspaceId" value={workspace.id} />
                  <button className={workspace.active ? "btn btn-block" : "btn btn-quiet btn-block"} type="submit" disabled={workspace.active} data-testid="workspace-row">
                    {workspace.name}
                    {workspace.active ? " · in use" : ""}
                    {workspace.ai === "off" ? " · AI off" : ""}
                  </button>
                </form>
              </li>
            ))}
          </ul>
          {owner ? (
            <form action={setWorkspaceAi}>
              <input type="hidden" name="ai" value={aiOff ? "on" : "off"} />
              <p className="muted small">AI generation in {user.workspace.name} is <strong>{aiOff ? "off" : "on"}</strong>.{aiOff ? " Nothing here can start an AI video or ask a model, and no credits are spent." : ""}</p>
              <SubmitButton className="btn btn-quiet btn-block" pendingLabel="Saving…" testId="workspace-ai-toggle">
                {aiOff ? "Turn AI generation on" : "Turn AI generation off"}
              </SubmitButton>
            </form>
          ) : null}
          {user.email !== "demo@reelwalk.local" ? (
            <form action={createWorkspace} style={{ marginTop: 12 }}>
              <label>
                Create a workspace
                <input name="name" required maxLength={60} placeholder="Name, for example Last Mile" autoComplete="off" data-testid="workspace-name" />
              </label>
              <SubmitButton className="btn btn-quiet btn-block" pendingLabel="Creating…" testId="workspace-create">
                Create and switch to it
              </SubmitButton>
            </form>
          ) : null}
        </section>

        <section className="card">
          <h2>AI video</h2>
          {aiOff ? <p className="muted small" data-testid="ai-off-note">AI generation is turned off for this workspace, so AI video, presenters and the AI editing helpers are unavailable here and no credits are spent. Turn it on under Workspaces above.</p> : null}
          <p><strong>{aiBalance.remaining}</strong> {aiBalance.remaining === 1 ? "credit" : "credits"} available</p>
          <p className="muted small">{aiBalance.monthly} monthly · {aiBalance.trial} trial · {aiBalance.topUp} purchased</p>
          {aiBalance.resetsAt ? <p className="muted small">Monthly allowance resets <LocalTime date={new Date(aiBalance.resetsAt)} />.</p> : null}
          <p className="muted small">One credit creates a 4-second clip; an 8-second clip uses 2. Agent includes 20 a month; Studio includes 60. Monthly credits reset without rollover, including on yearly plans. Purchased credits do not expire.</p>
          {billing === "credits" ? <p className="toast" role="status">Thank you. Your credits appear once payment is confirmed.</p> : null}
          {aiOff ? null : <Link className="btn btn-block" href="/ai-video">Generate AI video</Link>}
          {billingOn && aiTopUpPrice() && !aiOff && owner ? <form action={buyAiCredits} style={{ marginTop: 12 }}>
            <SubmitButton className="btn btn-quiet btn-block" pendingLabel="Opening checkout…">{AI_TOP_UP.credits} extra AI credits · {formatAud(AI_TOP_UP.priceCents / 100)}</SubmitButton>
          </form> : null}
        </section>

        <section className="card" id="instagram">
          <h2>Instagram</h2>
          {instagram ? (
            <>
              <p>
                Connected as <strong>@{instagram.username}</strong>. Finished exports get a <strong>Post to @{instagram.username}</strong>{" "}
                button on the export screen, and can be scheduled to post later.
              </p>
              <Link className="btn btn-block" href="/scheduled" prefetch={false} data-testid="scheduled-link">
                Scheduled posts
              </Link>
              <form action={disconnectInstagram}>
                <button className="btn btn-quiet" type="submit">
                  Disconnect
                </button>
              </form>
            </>
          ) : isInstagramConfigured() && plan.instagram ? (
            <>
              <p className="muted">
                Connect an Instagram professional account (linked to a Facebook Page) to post exports as Reels with one tap.
              </p>
              <a className="btn btn-block" href="/api/instagram/connect">
                Connect Instagram
              </a>
            </>
          ) : isInstagramConfigured() ? (
            <p className="muted">
              One-tap posting comes with the Agent plan. Until then, post exports from the export screen with your phone&apos;s share sheet, or
              send a share link.
            </p>
          ) : (
            <p className="muted">
              Post exports to Instagram from the export screen with your phone&apos;s share sheet, or send a share link.
            </p>
          )}
          {igStatus === "connected" ? <p className="toast" role="status">Instagram connected.</p> : null}
          {igStatus === "disconnected" ? <p className="toast" role="status">Instagram disconnected.</p> : null}
          {igStatus === "plan" ? (
            <p className="error small" role="alert">
              One-tap posting comes with the Agent plan.
            </p>
          ) : null}
          {igStatus === "no-account" ? (
            <p className="error small" role="alert">
              That Facebook login has no Instagram professional account linked to a Page.
            </p>
          ) : null}
          {igStatus === "denied" || igStatus === "failed" ? (
            <p className="error small" role="alert">
              Instagram did not finish connecting. Try again.
            </p>
          ) : null}
        </section>

        {instagram && plan.instagram && isMessagingConfigured() ? (
          <section className="card" id="replies" data-testid="comment-replies">
            <h2>Comment replies</h2>
            <p className="muted">
              When someone comments a keyword on one of your recent posts, @{instagram.username} sends them one DM: a guide, a link, a price list.
              Instagram allows one DM per comment, within 7 days of it.
            </p>
            {instagram.messagingToken ? (
              <>
                {triggers.length ? (
                  <ul className="plain-list">
                    {triggers.map((t) => (
                      <li key={t.id} data-testid="comment-trigger" data-keyword={t.keyword}>
                        <p>
                          <strong>{t.keyword}</strong> {t.enabled ? null : <span className="muted small">(paused)</span>}
                          <span className="muted small"> · {t._count.replies} sent</span>
                        </p>
                        <p className="small">{t.message}</p>
                        {t.publicReply ? <p className="muted small">Public reply: {t.publicReply}</p> : null}
                        <div className="field-row">
                          <form action={toggleCommentTrigger}>
                            <input type="hidden" name="id" value={t.id} />
                            <button className="btn btn-quiet" type="submit">
                              {t.enabled ? "Pause" : "Resume"}
                            </button>
                          </form>
                          <form action={deleteCommentTrigger}>
                            <input type="hidden" name="id" value={t.id} />
                            <button className="btn btn-quiet" type="submit">
                              Delete
                            </button>
                          </form>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <form action={saveCommentTrigger}>
                  <label className="field">
                    Keyword
                    <input className="text-input" name="keyword" required maxLength={30} placeholder="GUIDE" autoCapitalize="characters" data-testid="trigger-keyword" />
                  </label>
                  <label className="field">
                    DM to send
                    <textarea
                      className="text-input"
                      name="message"
                      rows={4}
                      required
                      maxLength={1000}
                      placeholder="Here's the guide: https://…"
                      data-testid="trigger-message"
                    />
                  </label>
                  <label className="field">
                    Public reply under the comment (optional)
                    <input className="text-input" name="publicReply" maxLength={300} placeholder="Sent it to your DMs" />
                  </label>
                  <SubmitButton pendingLabel="Saving…" testId="trigger-save">
                    Save keyword
                  </SubmitButton>
                </form>
                {recentReplies.length ? (
                  <>
                    <h3 className="small">Latest</h3>
                    <ul className="plain-list small" data-testid="comment-reply-log">
                      {recentReplies.map((r) => (
                        <li key={r.id}>
                          @{r.username ?? "someone"} · {r.trigger.keyword} · {r.status === "SENT" ? "sent" : r.status === "FAILED" ? `failed: ${r.error ?? ""}` : "sending"}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <a className="btn btn-quiet" href="/api/instagram/messaging/connect" data-testid="replies-reconnect">
                  Reconnect Instagram
                </a>
                <form action={disconnectCommentReplies}>
                  <button className="btn btn-quiet" type="submit">
                    Turn off comment replies
                  </button>
                </form>
              </>
            ) : (
              <a className="btn btn-block" href="/api/instagram/messaging/connect" data-testid="replies-connect">
                Allow comment replies
              </a>
            )}
            {repliesStatus === "connected" ? <p className="toast" role="status">Comment replies are on.</p> : null}
            {repliesStatus === "saved" ? <p className="toast" role="status">Keyword saved.</p> : null}
            {repliesStatus === "invalid" ? (
              <p className="error small" role="alert">
                A keyword is one word of letters or numbers, and the DM cannot be empty.
              </p>
            ) : null}
            {repliesStatus === "other-account" ? (
              <p className="error small" role="alert">
                That Instagram login is a different account from @{instagram.username}. Log in as @{instagram.username}.
              </p>
            ) : null}
            {repliesStatus === "denied" || repliesStatus === "failed" ? (
              <p className="error small" role="alert">
                Instagram did not finish connecting. Try again.
              </p>
            ) : null}
          </section>
        ) : null}

        <section className="card" id="apps" data-testid="connected-apps">
          <h2>Connected apps</h2>
          {connectedApps.length === 0 ? (
            <p className="muted small">
              No apps are connected. <Link href="/connect" className="link">Connect Claude or ChatGPT</Link> to edit your reels by chatting.
            </p>
          ) : (
            <ul className="plain-list small">
              {connectedApps.map((app) => (
                <li key={app.id} data-testid="connected-app">
                  <strong>{app.clientName}</strong> <span className="muted">in {app.workspaceName}</span>
                  <br />
                  <span className="muted">
                    {app.scopes.map((scope) => SCOPE_LABELS[scope].title).join(" · ")}
                    <br />
                    Connected <LocalTime date={app.createdAt} />
                    {app.lastUsedAt ? <> · last used <LocalTime date={app.lastUsedAt} /></> : " · not used yet"}
                  </span>
                  <form action={disconnectApp}>
                    <input type="hidden" name="grantId" value={app.id} />
                    <SubmitButton className="btn btn-quiet" pendingLabel="Disconnecting…">
                      Disconnect
                    </SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          )}
          {saved === "app" ? <p className="toast" role="status">Disconnected. That app can no longer use your account.</p> : null}
        </section>

        <form action={updateProfile} className="card">
          <h2>Profile</h2>
          <label className="field">
            Your name
            <input className="text-input" name="name" defaultValue={user.name} required maxLength={80} />
          </label>
          <label className="field">
            Studio name
            <input className="text-input" name="studio" defaultValue={user.workspace.name} required maxLength={80} />
          </label>
          <p className="muted small">Signed in as {user.email}</p>
          {saved === "1" ? <p className="toast" role="status">Saved.</p> : null}
          <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
        </form>

        <form action={changePassword} className="card">
          <h2>Password</h2>
          <label className="field">
            Current password
            <input className="text-input" name="current" type="password" autoComplete="current-password" required />
          </label>
          <label className="field">
            New password
            <input className="text-input" name="password" type="password" autoComplete="new-password" minLength={8} required />
          </label>
          {error === "current" ? (
            <p className="error small" role="alert">
              The current password is wrong.
            </p>
          ) : null}
          {error === "throttled" ? (
            <p className="error small" role="alert">
              Too many attempts. Wait fifteen minutes, then try again.
            </p>
          ) : null}
          {saved === "password" ? <p className="toast" role="status">Password changed.</p> : null}
          <SubmitButton pendingLabel="Changing…">Change password</SubmitButton>
        </form>

        <FeedbackForm page="/account" back="/account#feedback" status={feedback} error={message} />

        <form action={signOut} className="card">
          <p className="muted small">
            {sessions === 1 ? "Signed in on this device only." : `Signed in on ${sessions} devices.`}
          </p>
          <SubmitButton className="btn btn-quiet btn-block" pendingLabel="Signing out…" testId="sign-out">
            Sign out
          </SubmitButton>
        </form>

        <form action={deleteAccount} className="card card-danger" id="delete">
          <h2>Delete account</h2>
          <p className="muted small">
            Deletes your sign-in and {workspaces.length > 1 ? `all ${workspaces.length} of your workspaces (${workspaces.map((workspace) => workspace.name).join(", ")}), except any that someone else also uses` : user.workspace.name} for good: every reel, upload and export, and any connected Instagram account.
            It cannot be undone.
          </p>
          <label className="field">
            Password
            <input className="text-input" name="password" type="password" autoComplete="current-password" required />
          </label>
          <label className="check">
            <input type="checkbox" name="confirm" value="yes" required />
            <span>I understand everything in this studio is deleted.</span>
          </label>
          {error === "delete-password" ? (
            <p className="error small" role="alert">
              That password is wrong, so nothing was deleted.
            </p>
          ) : null}
          {error === "confirm" ? (
            <p className="error small" role="alert">
              Tick the box to confirm.
            </p>
          ) : null}
          <SubmitButton className="btn btn-danger btn-block" pendingLabel="Deleting…" testId="delete-account">
            Delete my account
          </SubmitButton>
        </form>
      </main>
      <TabBar />
    </>
  );
}
