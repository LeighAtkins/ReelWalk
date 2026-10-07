"use client";

/**
 * Shown if the editor throws. The reel's last autosave is on the server, so a
 * reload gets the user back to work. Without this Next shows a blank page.
 */
export default function EditorError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="auth">
      <div className="auth-card" role="alert">
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>The editor hit a snag</h1>
        <p className="muted small">Your last saved version is safe. Reloading brings it back.</p>
        <p className="muted small" style={{ wordBreak: "break-word" }}>{error.message}</p>
        <button type="button" className="btn btn-signal btn-block" onClick={() => window.location.reload()}>
          Reload the editor
        </button>
        <button type="button" className="btn btn-quiet btn-block" onClick={reset}>
          Try again without reloading
        </button>
      </div>
    </main>
  );
}
