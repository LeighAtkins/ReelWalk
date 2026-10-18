import type { Metadata } from "next";
import Link from "next/link";
import { claimGuest } from "../guest-actions";
import { redirect } from "next/navigation";
import { signUp } from "@/app/auth-actions";
import { BrandMark } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create your studio · ReelWalk" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string; reelId?: string; next?: string }> }) {
  const { error, reelId, next } = await searchParams;
  const user = await getSessionUser();
  if (user && !user.isGuest) redirect("/");
  const returnReel = reelId ?? next?.match(/^\/reels\/([^?]+)\?export=1$/)?.[1];
  if (user?.isGuest) return <main className="auth"><h1>Your reel is ready. Make it yours.</h1><p>Save your draft and unlock seven days of full-size exports and Instagram scheduling. No card needed. Your uploads and unused AI credits stay with you.</p><form action={claimGuest} className="auth-card" data-testid="claim-guest-form"><input type="hidden" name="reelId" value={returnReel ?? ""}/><label className="field">Email<input className="text-input" type="email" name="email" required autoComplete="email"/></label><label className="field">Password<input className="text-input" type="password" name="password" minLength={8} maxLength={200} required autoComplete="new-password"/></label>{error ? <p role="alert" className="error">{error}</p> : null}<SubmitButton className="btn btn-block" pendingLabel="Saving your studio...">Save my reel & start 7 days free</SubmitButton><p className="muted small">After seven days, choose a paid plan to keep exporting. No automatic charge.</p><p>By saving, you agree to our <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy Policy</Link>.</p><Link href="/login">Already registered? Sign in</Link></form></main>;

  return (
    <main className="auth">
      <header className="auth-brand">
        <span className="brand">
          <BrandMark />
          ReelWalk
        </span>
        <h1>Your studio, in about a minute.</h1>
        <p className="muted">Start seven days of full-size exports and Instagram scheduling, with two AI video credits included. No card needed. Bring your room videos, exterior photos and listing details.</p>
      </header>

      <form action={signUp} className="auth-card" data-testid="signup-form">
        <label className="field">
          Your name
          <input className="text-input" name="name" autoComplete="name" required autoFocus maxLength={80} />
        </label>
        <label className="field">
          Studio or business name <span className="muted small">(optional)</span>
          <input className="text-input" name="studio" autoComplete="organization" maxLength={80} placeholder="Northside Realty, Café Lumen…" />
        </label>
        <label className="field">
          Email
          <input className="text-input" name="email" type="email" autoComplete="email" inputMode="email" required />
        </label>
        <label className="field">
          Password <span className="muted small">(8+ characters)</span>
          <input className="text-input" name="password" type="password" autoComplete="new-password" minLength={8} required />
        </label>
        {error ? (
          <p className="error small" role="alert">
            {error}
          </p>
        ) : null}
        <SubmitButton className="btn btn-block" pendingLabel="Creating your studio…">
          Create studio
        </SubmitButton>
        <p className="muted small" style={{ textAlign: "center" }}>
          Already have one?{" "}
          <Link href="/login" className="link">
            Sign in
          </Link>
        </p>
      </form>
      <p className="muted small auth-legal">
        By creating a studio you agree to the{" "}
        <Link href="/terms" className="link">
          Terms
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="link">
          Privacy Policy
        </Link>
        .
      </p>
    </main>
  );
}
