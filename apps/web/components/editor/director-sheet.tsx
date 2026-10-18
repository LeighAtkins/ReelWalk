"use client";

import { useEffect, useRef, useState } from "react";
import { aiClipCredits, type DirectorPlan, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { runAiJob, waitForAiJob } from "@/lib/ai-jobs-client";
import { captureDirectorEvidence } from "./director-evidence";
import { Sheet } from "../sheet";

type Review = { ok: true; editId: string; model: string; plan: DirectorPlan; baseline: Timeline; timeline: Timeline; applied: string[]; skipped: string[]; assets: LibraryAsset[]; evidence: { assetId: string; timesMs: number[] }[] };
export function DirectorSheet({ reelId, timeline, library, onApply, onClose }: {
  reelId: string; timeline: Timeline; library: LibraryAsset[];
  onApply(review: Review): boolean; onClose(): void;
}) {
  const [brief, setBrief] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [extra, setExtra] = useState<LibraryAsset[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [history, setHistory] = useState<Review[]>([]);
  const [pending, setPending] = useState<{ id: string; status: string }[]>([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [approving, setApproving] = useState<number | null>(null);
  const [generated, setGenerated] = useState<Record<string, string>>({});
  const retry = useRef<{ key: string; body: unknown } | null>(null);
  const media = [...new Map([...library, ...extra].map(a => [a.id, a])).values()];
  async function reloadHistory() {
    const response = await fetch(`/api/reels/${reelId}/director`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load saved direction.");
    const data = await response.json(); setHistory(data.records); setPending(data.pending ?? []);
  }
  useEffect(() => { void reloadHistory().catch(() => setMessage("Saved reviews could not be loaded. Refresh before starting another request.")); }, [reelId]);
  async function acceptResult(result: Review | { ok: false; message: string }) {
    if (!result.ok) { setMessage(result.message); return; }
    setReview(result); setMessage("Opus's proposed edit is ready to review. Your reel has not changed."); await reloadHistory();
  }
  async function direct() {
    setBusy(true); setMessage("");
    try {
      const key = JSON.stringify({ brief, timeline, candidates });
      if (retry.current?.key !== key) {
        const evidence = await captureDirectorEvidence(timeline, media, candidates, setMessage);
        retry.current = { key, body: { requestId: crypto.randomUUID(), request: brief, timeline, candidates, evidence } };
      }
      setMessage("Opus is reviewing sampled frames and preparing its direction…");
      await acceptResult(await runAiJob<Review>(`/api/reels/${reelId}/director`, retry.current.body));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Review could not finish. Check saved requests before retrying."); }
    finally { setBusy(false); }
  }
  async function resume(id: string) {
    setBusy(true); setMessage("Resuming the saved review; no new model request.");
    try { await acceptResult(await waitForAiJob<Review>(id)); } finally { setBusy(false); }
  }
  async function generate(index: number) {
    if (!review) return; setApproving(index); setMessage("");
    try {
      const response = await fetch(`/api/reels/${reelId}/director/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ editId: review.editId, index, approved: true }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Generation did not start.");
      setGenerated(g => ({ ...g, [`${review.editId}:${index}`]: data.id }));
      setMessage("Shot queued. Opus must review the result before it is added to your reel. This approval cannot charge for a second take.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not start this shot. Repeating the same approval reuses its request."); }
    finally { setApproving(null); }
  }
  async function refreshTakes() {
    try {
      const response = await fetch("/api/ai/generations", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not refresh AI takes.");
      const data = await response.json(); setExtra(data.jobs.flatMap((j: { asset: LibraryAsset | null }) => j.asset ? [j.asset] : []));
      setMessage("Available AI takes refreshed. Select completed takes for Opus to review.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not refresh takes."); }
  }
  const current = review && JSON.stringify(review.baseline) === JSON.stringify(timeline);
  return <Sheet title="Opus director" onClose={onClose}>
    <p className="muted small">Opus reviews sampled source frames and directs the edit. These are not final playback or audio checks. Each new Veo take needs your approval.</p>
    {history.length > 0 ? <details><summary>Saved direction ({history.length})</summary>{history.map(h => <button key={h.editId} type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => setReview(h)}>{h.plan.note.slice(0, 110)}</button>)}</details> : null}
    {pending.map(j => <button key={j.id} type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => resume(j.id)}>Resume saved {j.status.toLowerCase()} review</button>)}
    <label className="field">Your brief<textarea className="text-area" rows={5} maxLength={4000} value={brief} onChange={e => setBrief(e.target.value)} disabled={busy} placeholder="Direct a 30-second reel. Keep the presenter visible through their sequence; make camera movement and cuts continuous." /></label>
    <details><summary>Candidate takes for review ({candidates.length}/3)</summary>
      <button type="button" className="btn btn-quiet" disabled={busy} onClick={refreshTakes}>Refresh completed AI takes</button>
      {media.filter(a => ["VIDEO", "IMAGE"].includes(a.kind) && !a.isPano).map(a => <label key={a.id} className="field"><span><input type="checkbox" checked={candidates.includes(a.id)} disabled={busy || (!candidates.includes(a.id) && candidates.length >= 3)} onChange={e => setCandidates(ids => e.target.checked ? [...ids, a.id] : ids.filter(id => id !== a.id))} /> {a.isAiGenerated ? "AI · " : ""}{a.fileName}</span></label>)}
    </details>
    <button type="button" className="btn btn-signal btn-block" disabled={busy || brief.trim().length < 3} onClick={direct}>{busy ? "Opus is working…" : "Ask Opus to direct"}</button>
    {message ? <p role="status" className="small">{message}</p> : null}
    {review ? <section aria-label="Opus direction">
      <p><strong>{review.plan.verdict.replaceAll("-", " ")}</strong> · {review.model}</p><p>{review.plan.note}</p>
      <ul aria-label="Continuity and scale checks">{Object.entries(review.plan.checks).map(([name, check]) => <li key={name}><strong>{name.replace(/([A-Z])/g, " $1")}: {check.result}</strong> — {check.evidence}</li>)}</ul>
      {review.plan.issues.length ? <ul>{review.plan.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul> : null}
      <p className="muted small">{review.plan.limitations}</p>
      <details><summary>What Opus reviewed</summary>{review.evidence.map((e, i) => <p key={i} className="small">{media.find(a => a.id === e.assetId)?.fileName ?? e.assetId}: {e.timesMs.length} source frames, {(e.timesMs[0] / 1000).toFixed(2)}–{(e.timesMs.at(-1)! / 1000).toFixed(2)}s. Audio and final composited playback were not supplied.</p>)}</details>
      {review.applied.length > 0 || review.plan.edit.caption ? <><details><summary>Proposed timeline changes</summary><ul>{review.applied.map((s, i) => <li key={i}>{s}</li>)}</ul>{review.skipped.map((s, i) => <p key={i}>{s}</p>)}{review.plan.edit.caption ? <p style={{ whiteSpace: "pre-wrap" }}>Post caption: {review.plan.edit.caption}</p> : null}</details><button type="button" className="btn btn-signal btn-block" disabled={!current || busy} onClick={() => { if (onApply(review)) setMessage("Applied as one editable, undoable step."); else setMessage("The timeline changed. Ask Opus to review the current edit."); }}>Apply Opus's edit</button>{!current ? <p className="small">The timeline changed since this review. Re-review before applying.</p> : null}</> : null}
      {review.plan.shots.map((s, i) => <article key={`${review.editId}:${i}`}>
        <h3>{s.title}</h3><p>{s.reason}</p><p className="small">{s.durationSeconds}s · {aiClipCredits(s.durationSeconds)} Veo credits · silent video</p>
        <details><summary>Opus's exact prompt and references</summary><p style={{ whiteSpace: "pre-wrap" }}>{s.prompt}</p><p className="small">First: {s.first ? `${media.find(a => a.id === s.first!.assetId)?.fileName ?? s.first.assetId} at ${(s.first.atMs / 1000).toFixed(2)}s` : "None"}<br />Last: {s.last ? `${media.find(a => a.id === s.last!.assetId)?.fileName ?? s.last.assetId} at ${(s.last.atMs / 1000).toFixed(2)}s` : "None"}</p></details>
        <button type="button" className="btn btn-quiet btn-block" disabled={approving !== null || busy || Boolean(generated[`${review.editId}:${i}`])} onClick={() => generate(i)}>{generated[`${review.editId}:${i}`] ? "Generation queued" : approving === i ? "Starting…" : `Approve ${aiClipCredits(s.durationSeconds)}-credit generation`}</button>
      </article>)}
    </section> : null}
  </Sheet>;
}
