import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signUp } from "@/app/auth-actions";
import { BrandMark } from "@/components/icons";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create your studio · ReelWalk" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  if (await getSessionUser()) redirect("/");

  return (
    <main className="auth">
      <header className="auth-brand">
        <span className="brand">
          <BrandMark />
          ReelWalk
        </span>
        <h1>Your studio, in about a minute.</h1>
        <p className="muted">Comes stocked: eight songs with the beat already found, home and interior clips, and 360 rooms to practise on.</p>
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
        <button className="btn btn-signal btn-block" type="submit">
          Create studio
        </button>
        <p className="muted small" style={{ textAlign: "center" }}>
          Already have one?{" "}
          <Link href="/login" className="link">
            Sign in
          </Link>
        </p>
      </form>
    </main>
  );
}
