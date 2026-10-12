import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { prisma } from "@reelwalk/db";
import { changePassword, deleteAccount, signOut, updateProfile } from "@/app/auth-actions";
import { openBillingPortal, startCheckout } from "@/app/billing-actions";
import { disconnectInstagram } from "@/app/instagram-actions";
import { FeedbackForm } from "@/components/feedback-form";
import { outputSize, PLANS } from "@reelwalk/core";
import { isInstagramConfigured } from "@/lib/instagram";
import { exportsThisMonth, storageUsed, workspacePlan } from "@/lib/plans";
import { isBillingConfigured } from "@/lib/stripe";
import { SubmitButton } from "@/components/submit-button";
import { TabBar } from "@/components/tab-bar";
import { getCurrentUser, mediaScope } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Account · ReelWalk" };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; instagram?: string; billing?: string; feedback?: string; message?: string }>;
}) {
  const { saved, error, instagram: igStatus, billing, feedback, message } = await searchParams;
  const user = await getCurrentUser();
  const [reels, exports, own, shared, sessions, instagram, current, usedThisMonth, usedBytes] = await Promise.all([
    prisma.reel.count({ where: { workspaceId: user.workspaceId } }),
    prisma.renderJob.count({ where: { workspaceId: user.workspaceId, status: "SUCCEEDED", kind: { not: "PREVIEW" } } }),
    prisma.mediaAsset.count({ where: { workspaceId: user.workspaceId, shared: false } }),
    prisma.mediaAsset.count({ where: { ...mediaScope(user.workspaceId), shared: true } }),
    prisma.session.count({ where: { userId: user.id, expiresAt: { gt: new Date() } } }),
    prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } } }),
    workspacePlan(user.workspaceId),
    exportsThisMonth(user.workspaceId),
    storageUsed(user.workspaceId),
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
            {plan.priceUsd > 0 && !current.comped ? <span className="muted"> · ${plan.priceUsd}/month</span> : null}
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
                Instagram{next.seats > 1 ? `, ${next.seats} people` : ""}. ${next.priceUsd}/month, cancel any time.
              </p>
              <SubmitButton className="btn btn-signal btn-block" pendingLabel="Opening checkout…" testId="upgrade">
                Upgrade to {next.name}
              </SubmitButton>
            </form>
          ) : null}
          <p className="muted small" style={{ marginBottom: 0 }}>
            <Link href="/pricing" data-testid="see-plans">
              Compare all plans and yearly prices
            </Link>
          </p>
          {billingOn && current.stripeCustomerId ? (
            <form action={openBillingPortal}>
              <SubmitButton className="btn btn-quiet btn-block" pendingLabel="Opening…" testId="billing-portal">
                Manage billing
              </SubmitButton>
            </form>
          ) : null}
        </section>

        <section className="card">
          <h2>Instagram</h2>
          {instagram ? (
            <>
              <p>
                Connected as <strong>@{instagram.username}</strong>. Finished exports get a <strong>Post to @{instagram.username}</strong>{" "}
                button on the export screen.
              </p>
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
            Deletes {user.workspace.name} for good: every reel, upload and export, and any connected Instagram account. It cannot be
            undone.
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
