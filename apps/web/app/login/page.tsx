import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signIn, signInDemo } from "@/app/auth-actions";
import { BrandMark } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in · ReelWalk" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  if (await getSessionUser()) redirect(next && next.startsWith("/") ? next : "/");
  const demo = Boolean(process.env.DEMO_PASSWORD);

  return (
    <main className="auth">
      <header className="auth-brand">
        <span className="brand">
          <BrandMark />
          ReelWalk
        </span>
        <h1>Make the reel. Post it. Go outside.</h1>
        <p className="muted">Walkthrough reels for listings, dish-by-dish reels for restaurants. Cut on your phone, rendered in the cloud.</p>
      </header>

      <form action={signIn} className="auth-card" data-testid="login-form">
        <input type="hidden" name="next" value={next ?? "/"} />
        <label className="field">
          Email
          <input className="text-input" name="email" type="email" autoComplete="email" inputMode="email" required autoFocus />
        </label>
        <label className="field">
          Password
          <input className="text-input" name="password" type="password" autoComplete="current-password" required />
        </label>
        {error === "credentials" ? (
          <p className="error small" role="alert">
            That email and password do not match.
          </p>
        ) : null}
        {error === "demo" ? (
          <p className="error small" role="alert">
            The demo studio is not available right now.
          </p>
        ) : null}
        <SubmitButton className="btn btn-signal btn-block" pendingLabel="Signing in…">
          Sign in
        </SubmitButton>
        <p className="muted small" style={{ textAlign: "center" }}>
          New here?{" "}
          <Link href="/signup" className="link">
            Create your studio
          </Link>
        </p>
      </form>

      {demo ? (
        <form action={signInDemo} className="auth-demo">
          <SubmitButton className="btn btn-quiet btn-block" pendingLabel="Opening the demo…" testId="demo-login">
            Look around the demo studio
          </SubmitButton>
          <p className="muted small">A furnished home tour, music and sample reels, ready to remix.</p>
        </form>
      ) : null}
    </main>
  );
}
