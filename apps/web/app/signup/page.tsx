import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signUp } from "@/app/auth-actions";
import { BrandMark } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { ATTRIBUTION_KEYS, pickAttribution } from "@/lib/attribution";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create your studio · ReelWalk" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : undefined;
  // utm_* and click ids from the link that brought them here ride along in hidden fields and are stored with the new user (ADR 0080).
  const attribution = pickAttribution(params);
  if (await getSessionUser()) redirect("/");

  return (
    <main className="auth">
      <header className="auth-brand">
        <span className="brand">
          <BrandMark />
          ReelWalk
        </span>
        <h1>Your studio, in about a minute.</h1>
        <p className="muted">Comes stocked with songs whose beat is already found and 360 rooms to practise on. Bring your own photos and video for the real thing.</p>
      </header>

      <form action={signUp} className="auth-card" data-testid="signup-form">
        {ATTRIBUTION_KEYS.map((key) => (attribution?.[key] ? <input key={key} type="hidden" name={key} value={attribution[key]} /> : null))}
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
