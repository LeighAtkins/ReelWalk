import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requestPasswordReset } from "@/app/password-reset-actions";
import { BrandMark } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Forgot your password · ReelWalk" };

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const { sent, error } = await searchParams;
  if (await getSessionUser()) redirect("/account");

  return (
    <main className="auth">
      <header className="auth-brand">
        <span className="brand">
          <BrandMark />
          ReelWalk
        </span>
        <h1>Forgot your password?</h1>
        <p className="muted">Tell us the email you signed up with and we send a link to choose a new one. The link works for an hour.</p>
      </header>

      {sent === "1" ? (
        <section className="auth-card" data-testid="forgot-sent">
          <p role="status">If that address has an account, we sent a link. Check your inbox, and the spam folder if it is slow to arrive.</p>
          <p className="muted small">
            Nothing after a few minutes? Try again with another address you may have used, or{" "}
            <Link href="/login" className="link">
              go back to sign in
            </Link>
            .
          </p>
        </section>
      ) : (
        <form action={requestPasswordReset} className="auth-card" data-testid="forgot-form">
          <label className="field">
            Email
            <input className="text-input" name="email" type="email" autoComplete="email" inputMode="email" required autoFocus />
          </label>
          {error === "email" ? (
            <p className="error small" role="alert">
              That email does not look right.
            </p>
          ) : null}
          {error === "throttled" ? (
            <p className="error small" role="alert">
              Too many attempts. Wait an hour, then try again.
            </p>
          ) : null}
          {error === "expired" ? (
            <p className="error small" role="alert">
              That link has expired or was already used. Ask for a new one.
            </p>
          ) : null}
          <SubmitButton className="btn btn-signal btn-block" pendingLabel="Sending…">
            Send me a link
          </SubmitButton>
          <p className="muted small" style={{ textAlign: "center" }}>
            Remembered it?{" "}
            <Link href="/login" className="link">
              Sign in
            </Link>
          </p>
        </form>
      )}
    </main>
  );
}
