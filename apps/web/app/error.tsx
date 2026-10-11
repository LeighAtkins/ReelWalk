"use client";

import Link from "next/link";

/**
 * Any page that throws lands here instead of a blank screen. Work is saved on
 * the server as it happens, so trying again or going home loses nothing.
 */
export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="auth">
      <div className="auth-card" role="alert">
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Something went wrong</h1>
        <p className="muted small">This page did not load. Your reels and uploads are safe.</p>
        <button type="button" className="btn btn-signal btn-block" onClick={reset}>
          Try again
        </button>
        <Link href="/" className="btn btn-quiet btn-block" prefetch={false}>
          Go to your reels
        </Link>
      </div>
    </main>
  );
}
