import Link from "next/link";

export default function NotFound() {
  return (
    <main className="auth">
      <div className="auth-card">
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Nothing at this address</h1>
        <p className="muted small">The reel may have been deleted, or the link is incomplete.</p>
        <Link href="/" className="btn btn-signal btn-block" prefetch={false}>
          Go to your reels
        </Link>
      </div>
    </main>
  );
}
