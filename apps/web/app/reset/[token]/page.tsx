import type { Metadata } from "next";
import Link from "next/link";
import { resetPassword } from "@/app/password-reset-actions";
import { BrandMark } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { openPasswordReset } from "@/lib/password-reset";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Choose a new password · ReelWalk" };

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const reset = await openPasswordReset(token);

  return (
    <main className="auth">
      <header className="auth-brand">
        <span className="brand">
          <BrandMark />
          ReelWalk
        </span>
        <h1>Choose a new password.</h1>
        {reset ? <p className="muted">For {reset.user.email}. You are signed in on this device once it is saved; other devices are signed out.</p> : null}
      </header>

      {reset ? (
        <form action={resetPassword} className="auth-card" data-testid="reset-form">
          <input type="hidden" name="token" value={token} />
          <label className="field">
            New password <span className="muted small">(8+ characters)</span>
            <input className="text-input" name="password" type="password" autoComplete="new-password" minLength={8} required autoFocus />
          </label>
          <SubmitButton className="btn btn-signal btn-block" pendingLabel="Saving…">
            Save and sign in
          </SubmitButton>
        </form>
      ) : (
        <section className="auth-card" data-testid="reset-expired">
          <p role="alert">This link has expired or was already used. Links work once, for an hour.</p>
          <Link href="/forgot" className="btn btn-block">
            Ask for a new link
          </Link>
        </section>
      )}
    </main>
  );
}
