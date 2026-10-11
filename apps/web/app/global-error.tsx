"use client";

/**
 * Last resort, when the root layout itself fails: it replaces the whole
 * document, so the app's stylesheet may be missing and styles are inline.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100dvh", display: "grid", placeItems: "center", background: "#0f2a44", color: "#eaf2fb", fontFamily: "system-ui, sans-serif" }}>
        <div role="alert" style={{ maxWidth: 360, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem" }}>ReelWalk could not load</h1>
          <p style={{ opacity: 0.75 }}>Your reels and uploads are safe. Try again in a moment.</p>
          <button
            type="button"
            onClick={() => (reset ? reset() : window.location.reload())}
            style={{ marginTop: 12, padding: "12px 20px", border: 0, borderRadius: 999, background: "#f0442c", color: "#fff", fontWeight: 700, fontSize: 16 }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
