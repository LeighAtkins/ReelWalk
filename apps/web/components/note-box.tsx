"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The note box on the export screen (ADR 0095): the note goes to the server,
 * which edits the reel and exports the next version in the background. The
 * page refreshes itself while it works, so this only has to start it.
 */
export function NoteBox({ reelId, disabled, left }: { reelId: string; disabled: boolean; left: number | null }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; upgrade: boolean } | null>(null);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (pending || note.trim().length < 3) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/reels/${reelId}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note, requestId: crypto.randomUUID() }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; upgrade?: boolean };
      if (!answer.ok) setError({ message: answer.message ?? "That did not send. Try again.", upgrade: answer.upgrade ?? false });
      else {
        setNote("");
        // Show the latest version (the one the note is about, then the new one) and its progress.
        router.push(`/reels/${reelId}/export#notes`);
        router.refresh();
      }
    } catch {
      setError({ message: "Could not reach ReelWalk. Check the connection and try again.", upgrade: false });
    } finally {
      setPending(false);
    }
  }

  const out = left === 0;
  return (
    <form className="note-box" onSubmit={send} data-testid="note-box">
      <textarea
        className="text-area"
        rows={2}
        required
        minLength={3}
        maxLength={600}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="For example: show the desk earlier"
        aria-label="Your note on this version"
        data-testid="note-input"
        disabled={disabled || out}
      />
      {error ? (
        <p className="error small" role="alert" data-testid="note-error">
          {error.message}{" "}
          {error.upgrade ? (
            <Link href="/pricing" className="link">
              See plans
            </Link>
          ) : null}
        </p>
      ) : null}
      <button className="btn btn-signal" type="submit" disabled={pending || disabled || out || note.trim().length < 3} data-testid="note-send">
        {pending ? "Sending…" : "Make the next version"}
      </button>
    </form>
  );
}

/** "Back to vN": that version's cut becomes the reel's cut again, and the screen shows it. Nothing is rendered. */
export function BackToVersion({ reelId, exportId, label }: { reelId: string; exportId: string; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/reels/${reelId}/notes/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ exportId }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!answer.ok) setError(answer.message ?? "That did not work. Try again.");
      else {
        router.push(`/reels/${reelId}/export?v=${exportId}`);
        router.refresh();
      }
    } catch {
      setError("Could not reach ReelWalk. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-quiet" onClick={restore} disabled={pending} data-testid="back-to-version">
        {pending ? "Going back…" : `Go back to ${label}`}
      </button>
      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
