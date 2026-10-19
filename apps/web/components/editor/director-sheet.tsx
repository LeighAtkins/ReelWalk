"use client";

import { useEffect, useRef, useState } from "react";
import { aiClipCredits, DIRECTOR_LOOP_MAX_ROUNDS, directorLoopBrief, directorLoopStep, sameTimeline, type DirectorPlan, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { runAiJob, waitForAiJob } from "@/lib/ai-jobs-client";
import { captureDirectorEvidence } from "./director-evidence";
import { Sheet } from "../sheet";

const VERDICTS = { ready: "Opus thinks this reel is ready", "changes-proposed": "Opus suggests some changes", "needs-generation": "Opus suggests new AI shots" } as const;
const CHECKS: Record<string, string> = { scale: "Presenter's size", cameraContinuity: "Camera flow", presenterContinuity: "Presenter stays on screen", propertyIdentity: "House matches the real one" };
const RESULTS = { pass: "looks right", fail: "needs fixing", uncertain: "not sure" } as const;

type Review = { ok: true; editId: string; model: string; plan: DirectorPlan; baseline: Timeline; timeline: Timeline; applied: string[]; skipped: string[]; assets: LibraryAsset[]; evidence: { assetId: string; timesMs: number[] }[] };
export function DirectorSheet({ reelId, timeline, library, onApply, onClose }: {
  reelId: string; timeline: Timeline; library: LibraryAsset[];
  onApply(review: Review): boolean; onClose(): void;
}) {
  const [brief, setBrief] = useState("");
  const [extra, setExtra] = useState<LibraryAsset[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [history, setHistory] = useState<Review[]>([]);
  const [pending, setPending] = useState<{ id: string; status: string }[]>([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [approving, setApproving] = useState<number | null>(null);
  const [generated, setGenerated] = useState<Record<string, string>>({});
  const retry = useRef<{ key: string; body: unknown } | null>(null);
  // "Make it for me" (ADR 0037): Opus reviews, the app applies and makes shots within the budget, Opus checks each one.
  const [mode, setMode] = useState<"ask" | "auto">("ask");
  const [budget, setBudget] = useState(2);
  const [running, setRunning] = useState(false);
  const loop = useRef<{ runId: string | null; spent: number; round: number; stop: boolean } | null>(null);
  const media = [...new Map([...library, ...extra].map(a => [a.id, a])).values()];
  async function reloadHistory() {
    const response = await fetch(`/api/reels/${reelId}/director`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load saved direction.");
    const data = await response.json(); setHistory(data.records); setPending(data.pending ?? []);
  }
  useEffect(() => { void reloadHistory().catch(() => setMessage("Saved reviews could not be loaded. Refresh before starting another request.")); }, [reelId]);
  async function acceptResult(result: Review | { ok: false; message: string }) {
    if (!result.ok) { setMessage(result.message); return; }
    setReview(result); setMessage("Here is what Opus suggests. Nothing has changed yet."); await reloadHistory();
  }
  /** Completed AI takes this reel does not use yet, newest first: Opus considers them without the studio picking files. */
  async function unusedTakes(base: Timeline): Promise<{ ids: string[]; assets: LibraryAsset[] }> {
    const response = await fetch("/api/ai/generations", { cache: "no-store" });
    if (!response.ok) return { ids: [], assets: [] };
    const data = await response.json();
    const assets: LibraryAsset[] = data.jobs.flatMap((j: { asset: LibraryAsset | null }) => j.asset ? [j.asset] : []);
    const used = new Set(base.clips.map(c => c.assetId));
    return { ids: assets.filter(a => !used.has(a.id) && a.kind === "VIDEO").map(a => a.id).slice(0, 4), assets };
  }
  async function direct(request = brief, base = timeline, runId: string | null = null): Promise<Review | null> {
    setBusy(true); setMessage("Opus is getting your clips ready…");
    try {
      const key = JSON.stringify({ request, base, runId });
      if (retry.current?.key !== key) {
        const takes = await unusedTakes(base);
        setExtra(prev => [...new Map([...prev, ...takes.assets].map(a => [a.id, a])).values()]);
        const candidates = takes.ids;
        const evidence = await captureDirectorEvidence(base, [...media, ...takes.assets], candidates, setMessage);
        retry.current = { key, body: { requestId: crypto.randomUUID(), request, timeline: base, candidates, evidence, ...(runId ? { runId } : {}) } };
      }
      setMessage("Opus is watching the frames and working out what to change. This takes a minute or two…");
      const result = await runAiJob<Review>(`/api/reels/${reelId}/director`, retry.current.body);
      // A failed request keeps its id on the server, so asking again with the same brief would only fetch the same failure back.
      if (!result.ok) retry.current = null;
      await acceptResult(result);
      return result.ok ? result : null;
    } catch (error) { setMessage(error instanceof Error ? error.message : "Review could not finish. Check saved requests before retrying."); return null; }
    finally { setBusy(false); }
  }
  /** The finished take for a generation, or null when it failed, the run was stopped, or twenty minutes passed. */
  async function waitForTake(id: string, state: { stop: boolean }): Promise<LibraryAsset | null> {
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline && !state.stop) {
      await new Promise(resolve => setTimeout(resolve, 10_000));
      const response = await fetch("/api/ai/generations", { cache: "no-store" }).catch(() => null);
      if (!response?.ok) continue;
      const data = await response.json() as { jobs: { id: string; status: string; asset: LibraryAsset | null }[] };
      const job = data.jobs.find(j => j.id === id);
      if (job?.status === "SUCCEEDED" && job.asset) return job.asset;
      if (job && ["FAILED", "CANCELLED"].includes(job.status)) return null;
    }
    return null;
  }
  /** "Make it for me": review, apply, make the first shot that fits the budget, let Opus check it, repeat. */
  async function run() {
    const state = { runId: null as string | null, spent: 0, round: 0, stop: false };
    loop.current = state; setRunning(true);
    let request = brief, base = timeline;
    try {
      for (;;) {
        const result = await direct(request, base, state.runId);
        if (!result || state.stop) return;
        state.runId ??= result.editId;
        if ((result.applied.length || result.plan.edit.caption) && !onApply(result)) { setMessage("The timeline changed while Opus was working, so the run stopped before making anything."); return; }
        base = result.timeline;
        const step = directorLoopStep(result.plan, { round: state.round, maxRounds: DIRECTOR_LOOP_MAX_ROUNDS, budgetCredits: budget, spentCredits: state.spent });
        if (step.kind === "done") { setMessage(step.reason); return; }
        const shot = result.plan.shots[step.index];
        setBusy(true);
        const response = await fetch(`/api/reels/${reelId}/director/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ editId: result.editId, index: step.index, quotedCredits: step.credits, approved: true, auto: { runId: state.runId, budgetCredits: budget } }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Generation did not start.");
        state.spent += step.credits; state.round += 1;
        setGenerated(g => ({ ...g, [`${result.editId}:${step.index}`]: data.id }));
        setMessage(`Making "${shot.title}" · ${state.spent} of ${budget} credits used. Opus will check it when it is ready, in a few minutes…`);
        const asset = await waitForTake(data.id, state);
        if (state.stop) { setMessage(`Stopped. "${shot.title}" will still finish and appear in your media.`); return; }
        if (!asset) { setMessage(`"${shot.title}" did not come out, so the run stopped. A failed shot's credit is returned.`); return; }
        setExtra(prev => [...prev, asset]);
        request = directorLoopBrief(brief, state.round, { title: shot.title, fileName: asset.fileName });
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "The run stopped. Check saved reviews before starting another."); }
    finally { loop.current = null; setRunning(false); setBusy(false); }
  }
  async function resume(id: string) {
    setBusy(true); setMessage("Opus is still working on your last request…");
    try { await acceptResult(await waitForAiJob<Review>(id)); } finally { setBusy(false); }
  }
  async function generate(index: number) {
    if (!review) return; setApproving(index); setMessage("");
    try {
      const response = await fetch(`/api/reels/${reelId}/director/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ editId: review.editId, index, quotedCredits: aiClipCredits(review.plan.shots[index].durationSeconds, Boolean(review.plan.shots[index].voice)), approved: true }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Generation did not start.");
      setGenerated(g => ({ ...g, [`${review.editId}:${index}`]: data.id }));
      setMessage("Making the shot. It takes a few minutes; ask Opus again once it is ready and it will check the result. Tapping again will not charge twice.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not start this shot. Repeating the same approval reuses its request."); }
    finally { setApproving(null); }
  }
  const current = review && sameTimeline(review.baseline, timeline);
  return <Sheet title="Ask Opus" onClose={onClose}>
    <p className="muted">Tell Opus what you think, the way you would tell an editor. It looks through every clip, including AI takes you have not used, and suggests fixes. Nothing changes until you tap Apply, and new AI shots always ask first.</p>
    {pending.map(j => <button key={j.id} type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => resume(j.id)}>Opus is still working on your last request · show it</button>)}
    <label className="field">What do you think?<textarea className="text-area" rows={5} maxLength={4000} value={brief} onChange={e => setBrief(e.target.value)} disabled={busy} placeholder="For example: the skydive looks fake, she vanishes between shots, and she looks huge next to the house." /></label>
    <fieldset className="field" disabled={busy}>
      <legend className="small">AI shots</legend>
      <label className="small"><input type="radio" name="director-mode" checked={mode === "ask"} onChange={() => setMode("ask")} /> Ask me before using credits</label>
      <label className="small"><input type="radio" name="director-mode" checked={mode === "auto"} onChange={() => setMode("auto")} /> Make it for me, up to <input type="number" inputMode="numeric" min={1} max={40} value={budget} onChange={e => setBudget(Math.max(1, Math.min(40, Math.round(Number(e.target.value) || 1))))} style={{ width: "4em" }} aria-label="Credit budget" /> {budget === 1 ? "credit" : "credits"}</label>
      {mode === "auto" ? <span className="muted small">Opus applies its changes, makes one shot at a time, checks each result, and stops when it is happy, when the budget cannot cover the next shot, or after {DIRECTOR_LOOP_MAX_ROUNDS} rounds. You can stop it at any point; shots already made stay in your media.</span> : null}
    </fieldset>
    {running
      ? <button type="button" className="btn btn-quiet btn-block" onClick={() => { if (loop.current) loop.current.stop = true; setMessage("Stopping after the current step…"); }}>Stop the run</button>
      : <button type="button" className="btn btn-signal btn-block" disabled={busy || brief.trim().length < 3} onClick={() => { void (mode === "auto" ? run() : direct()); }}>{busy ? "Opus is working…" : mode === "auto" ? `Make it for me · up to ${budget} ${budget === 1 ? "credit" : "credits"}` : "Ask Opus"}</button>}
    {message ? <p role="status" className="small">{message}</p> : null}
    {history.length > 0 ? <details><summary>Earlier suggestions ({history.length})</summary>{history.map(h => <button key={h.editId} type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => setReview(h)}>{h.plan.note.slice(0, 110)}</button>)}</details> : null}
    {review ? <section aria-label="Opus direction">
      <p><strong>{VERDICTS[review.plan.verdict]}</strong></p><p>{review.plan.note}</p>
      <ul aria-label="Continuity and scale checks">{Object.entries(review.plan.checks).map(([name, check]) => <li key={name}><strong>{CHECKS[name] ?? name}: {RESULTS[check.result]}</strong> — {check.evidence}</li>)}</ul>
      {review.plan.issues.length ? <ul>{review.plan.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul> : null}
      <p className="muted small">{review.plan.limitations}</p>
      <details><summary>What Opus looked at</summary><p className="small">{review.evidence.length} clips, {review.evidence.reduce((n, e) => n + e.timesMs.length, 0)} frames. Opus sees still frames, not sound or the finished playback.</p></details>
      {review.applied.length > 0 || review.plan.edit.caption ? <><details><summary>What Opus would change</summary><ul>{review.applied.map((s, i) => <li key={i}>{s}</li>)}</ul>{review.skipped.map((s, i) => <p key={i}>{s}</p>)}{review.plan.edit.caption ? <p style={{ whiteSpace: "pre-wrap" }}>Post caption: {review.plan.edit.caption}</p> : null}</details><button type="button" className="btn btn-signal btn-block" disabled={!current || busy} onClick={() => { if (onApply(review)) setMessage("Applied as one editable, undoable step."); else setMessage("The timeline changed. Ask Opus to review the current edit."); }}>Apply these changes</button>{!current ? <p className="small">You have edited the reel since. Ask Opus again before applying.</p> : null}</> : null}
      {review.plan.shots.map((s, i) => <article key={`${review.editId}:${i}`}>
        <h3>{s.title}</h3><p>{s.reason}</p>{s.line ? <p className="small">She says: “{s.line}” · {s.voice === "veo" ? "Veo's own voice" : "the presenter voice, lip-synced"}</p> : null}<p className="small">New {s.durationSeconds}-second AI shot · {aiClipCredits(s.durationSeconds, Boolean(s.voice))} {aiClipCredits(s.durationSeconds, Boolean(s.voice)) === 1 ? "credit" : "credits"}</p>
        <details><summary>Opus's instructions for this shot</summary><p style={{ whiteSpace: "pre-wrap" }}>{s.prompt}</p><p className="small">First: {s.first ? `${media.find(a => a.id === s.first!.assetId)?.fileName ?? s.first.assetId} at ${(s.first.atMs / 1000).toFixed(2)}s` : "None"}<br />Last: {s.last ? `${media.find(a => a.id === s.last!.assetId)?.fileName ?? s.last.assetId} at ${(s.last.atMs / 1000).toFixed(2)}s` : "None"}{s.compose ? <><br />Start and end stills are composed first, placing the presenter from {media.find(a => a.id === s.compose!.presenter.assetId)?.fileName ?? s.compose.presenter.assetId} into the real frame at human scale.</> : null}</p></details>
        <button type="button" className="btn btn-quiet btn-block" disabled={approving !== null || busy || Boolean(generated[`${review.editId}:${i}`])} onClick={() => generate(i)}>{generated[`${review.editId}:${i}`] ? "Making the shot…" : approving === i ? "Starting…" : `Make this shot · ${aiClipCredits(s.durationSeconds, Boolean(s.voice))} ${aiClipCredits(s.durationSeconds, Boolean(s.voice)) === 1 ? "credit" : "credits"}`}</button>
      </article>)}
    </section> : null}
  </Sheet>;
}
