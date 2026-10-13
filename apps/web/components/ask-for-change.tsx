"use client";

import Link from "next/link";
import { useActionState } from "react";
import { askAndContinue, type AskState } from "@/app/ai-actions";

const initial: AskState = { error: null, note: null, skipped: [] };

/**
 * On the export screen, under a finished reel (ADR 0020): type the change,
 * and ReelWalk edits the reel and renders it again, or opens the editor on
 * the result. Rendering again spends an export, so that button is lacquer.
 */
export function AskForChange({ reelId, usage }: { reelId: string; usage: { used: number; allowed: number } | null }) {
  const [state, action, pending] = useActionState(askAndContinue, initial);
  const left = usage ? Math.max(0, usage.allowed - usage.used) : null;
  return (
    <form action={action} className="card ask" data-testid="ask-for-change">
      <h2>Ask for a change</h2>
      <p className="muted small">
        Say what you want different and ReelWalk makes the change, no editor needed.
        {left !== null ? ` ${left} of ${usage!.allowed} requests left this month.` : ""}
      </p>
      <input type="hidden" name="reelId" value={reelId} />
      <textarea
        name="request"
        className="text-area"
        rows={3}
        required
        minLength={3}
        maxLength={600}
        placeholder="For example: make the kitchen shot longer and swap the music for something calmer"
        data-testid="ask-input"
      />
      {state.error ? (
        <p className="error small" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.error && state.upgrade ? (
        <Link href="/pricing" className="btn btn-quiet">
          See plans
        </Link>
      ) : null}
      {state.note ? (
        <p role="status" data-testid="ask-note">
          {state.note}
        </p>
      ) : null}
      {state.skipped.length > 0 ? (
        <ul className="muted small ask-skipped">
          {state.skipped.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <div className="export-actions">
        <button className="btn btn-signal" type="submit" name="then" value="export" disabled={pending || left === 0} data-testid="ask-export">
          {pending ? "Working it out…" : "Change it and export again"}
        </button>
        <button className="btn btn-quiet" type="submit" name="then" value="edit" disabled={pending || left === 0}>
          Change it and open the editor
        </button>
      </div>
    </form>
  );
}
