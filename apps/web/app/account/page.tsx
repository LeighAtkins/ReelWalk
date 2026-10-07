import type { Metadata } from "next";
import { prisma } from "@reelwalk/db";
import { changePassword, signOut, updateProfile } from "@/app/auth-actions";
import { disconnectInstagram } from "@/app/instagram-actions";
import { isInstagramConfigured } from "@/lib/instagram";
import { SubmitButton } from "@/components/submit-button";
import { TabBar } from "@/components/tab-bar";
import { formatDateTime } from "@/lib/format";
import { getCurrentUser, mediaScope } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Account · ReelWalk" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; instagram?: string }> }) {
  const { saved, error, instagram: igStatus } = await searchParams;
  const user = await getCurrentUser();
  const [reels, exports, own, shared, sessions, instagram] = await Promise.all([
    prisma.reel.count({ where: { workspaceId: user.workspaceId } }),
    prisma.renderJob.count({ where: { workspaceId: user.workspaceId, status: "SUCCEEDED", kind: { not: "PREVIEW" } } }),
    prisma.mediaAsset.count({ where: { workspaceId: user.workspaceId, shared: false } }),
    prisma.mediaAsset.count({ where: { ...mediaScope(user.workspaceId), shared: true } }),
    prisma.session.count({ where: { userId: user.id, expiresAt: { gt: new Date() } } }),
    prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } } }),
  ]);

  return (
    <>
      <main className="shell">
        <h1 style={{ marginBottom: 4 }}>{user.workspace.name}</h1>
        <p className="muted small" style={{ marginBottom: 20 }}>
          Studio since {formatDateTime(user.workspace.createdAt)}
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
          ) : isInstagramConfigured() ? (
            <>
              <p className="muted">
                Connect an Instagram professional account (linked to a Facebook Page) to post exports as Reels with one tap.
              </p>
              <a className="btn btn-block" href="/api/instagram/connect">
                Connect Instagram
              </a>
            </>
          ) : (
            <p className="muted">
              Sharing works through the share sheet and share links. One-tap posting needs this deployment to have a Meta app
              (META_APP_ID and META_APP_SECRET).
            </p>
          )}
          {igStatus === "connected" ? <p className="toast" role="status">Instagram connected.</p> : null}
          {igStatus === "disconnected" ? <p className="toast" role="status">Instagram disconnected.</p> : null}
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
          {saved === "password" ? <p className="toast" role="status">Password changed.</p> : null}
          <SubmitButton pendingLabel="Changing…">Change password</SubmitButton>
        </form>

        <form action={signOut} className="card">
          <p className="muted small">
            {sessions === 1 ? "Signed in on this device only." : `Signed in on ${sessions} devices.`}
          </p>
          <SubmitButton className="btn btn-quiet btn-block" pendingLabel="Signing out…" testId="sign-out">
            Sign out
          </SubmitButton>
        </form>
      </main>
      <TabBar />
    </>
  );
}
