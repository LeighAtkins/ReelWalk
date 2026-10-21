"use client";

import { useEffect, useRef, useState } from "react";
import { aiClipCredits, DIRECTOR_LOOP_MAX_ROUNDS, isGeneratedAssetId, directorLoopBrief, directorLoopStep, sameTimeline, type DirectorPlan, type InstagramAudioTrack, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import type { PublicDirectorRun } from "@/lib/workflows";
import { runAiJob, waitForAiJob } from "@/lib/ai-jobs-client";
import { captureDirectorEvidence } from "./director-evidence";
import { Sheet } from "../sheet";
import { PresenterPicker } from "./presenter-kit";

const VERDICTS = { ready: "Opus thinks this reel is ready", "changes-proposed": "Opus suggests some changes", "needs-generation": "Opus suggests new AI shots" } as const;
const CHECKS: Record<string, string> = { scale: "Presenter's size", cameraContinuity: "Camera flow", presenterContinuity: "Presenter stays on screen", propertyIdentity: "House matches the real one" };
const RESULTS = { pass: "looks right", fail: "needs fixing", uncertain: "not sure" } as const;

type Review = { ok: true; editId: string; model: string; plan: DirectorPlan; baseline: Timeline; timeline: Timeline; applied: string[]; skipped: string[]; assets: LibraryAsset[]; evidence: { assetId: string; timesMs: number[] }[]; /** An Instagram sound the plan chose; the editor imports it when the review is applied. */ instagramPick?: InstagramAudioTrack | null; /** The editor's document generation the review was asked against (ADR 0048); absent on a review saved earlier. */ generation?: number };
export function DirectorSheet({ reelId, timeline, generation, library, onApply, onAssets, onClose }: {
  reelId: string; timeline: Timeline; library: LibraryAsset[];
  /** The reel's current document generation: a review applies only against the generation it was asked for. */
  generation: number;
  /** Applies a review as one step: the new generation and reel, or why not (the reel changed since, or the edit is not a valid reel). */
  onApply(review: Review): Promise<{ ok: true; generation: number; timeline: Timeline } | { ok: false; reason: "stale" | "rejected"; message: string }>;
  /** Media the director brought in (AI takes made or considered), so the editor's library and picker know them. */
  onAssets?(assets: LibraryAsset[]): void;
  onClose(): void;
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
  // With AI_JOBS_DURABLE the run's round, spend and stop flag are saved (ADR 0049): this sheet is a view of it.
  const [durable, setDurable] = useState(false);
  const [savedRun, setSavedRun] = useState<PublicDirectorRun | null>(null);
  const stopSaved = useRef(false);
  /** Why the server refused the last review start ("busy", "reviewed": another tab has this round). */
  const refused = useRef<string | null>(null);
  const media = [...new Map([...library, ...extra].map(a => [a.id, a])).values()];
  // Who she is in composed shots (ADR 0056): the picked presenter kit, sent with every approval.
  const [presenterId, setPresenterId] = useState<string | null>(null);
  const withPresenter = presenterId ? { presenterId } : {};
  // How many generated hops each AI take is from a real reference, to warn before a chained shot is made.
  const [depths, setDepths] = useState<Record<string, number>>({});
  useEffect(() => {
    void fetch("/api/ai/generations", { cache: "no-store" }).then(response => response.ok ? response.json() : null).then((data: { jobs: { asset: { id: string } | null; referenceDepth: number | null }[] } | null) => {
      if (data) setDepths(Object.fromEntries(data.jobs.flatMap(job => job.asset ? [[job.asset.id, job.referenceDepth ?? 0]] : [])));
    }).catch(() => undefined);
  }, []);
  /** The reference depth a proposal would have: 0 with a kit or real footage, else one more than the take it names. */
  const proposalDepth = (shot: DirectorPlan["shots"][number]) => !shot.compose || presenterId || !shot.compose.presenter || !isGeneratedAssetId(shot.compose.presenter.assetId) ? 0 : (depths[shot.compose.presenter.assetId] ?? 0) + 1;
  async function reloadHistory() {
    const response = await fetch(`/api/reels/${reelId}/director`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load saved direction.");
    const data = await response.json(); setHistory(data.records); setPending(data.pending ?? []);
    setDurable(Boolean(data.durable)); if (data.run !== undefined) setSavedRun(data.run);
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
  async function direct(request = brief, base = timeline, runId: string | null = null, baseGeneration = generation, workflowRunId: string | null = null): Promise<Review | null> {
    setBusy(true); setMessage("Opus is getting your clips ready…");
    try {
      const key = JSON.stringify({ request, base, runId, workflowRunId });
      if (retry.current?.key !== key) {
        const takes = await unusedTakes(base);
        setExtra(prev => [...new Map([...prev, ...takes.assets].map(a => [a.id, a])).values()]);
        if (takes.assets.length) onAssets?.(takes.assets);
        const candidates = takes.ids;
        const evidence = await captureDirectorEvidence(base, [...media, ...takes.assets], candidates, setMessage);
        retry.current = { key, body: { requestId: crypto.randomUUID(), request, timeline: base, candidates, evidence, ...(runId ? { runId } : {}), ...(workflowRunId ? { workflowRunId } : {}) } };
      }
      setMessage("Opus is watching the frames and working out what to change. This takes a minute or two…");
      const answer = await runAiJob<Review>(`/api/reels/${reelId}/director`, retry.current.body);
      const result = answer.ok ? { ...answer, generation: baseGeneration } : answer;
      // A failed request keeps its id on the server, so asking again with the same brief would only fetch the same failure back.
      refused.current = result.ok ? null : ((result as { reason?: string }).reason ?? null);
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
      if (job && ["FAILED", "CANCELLED", "UNRESOLVED"].includes(job.status)) return null;
    }
    return null;
  }
  /** "Make it for me": review, apply, make the first shot that fits the budget, let Opus check it, repeat. */
  async function run() {
    const state = { runId: null as string | null, spent: 0, round: 0, stop: false };
    loop.current = state; setRunning(true);
    let request = brief, base = timeline, baseGeneration = generation;
    try {
      for (;;) {
        const result = await direct(request, base, state.runId, baseGeneration);
        if (!result || state.stop) return;
        state.runId ??= result.editId;
        if (result.applied.length || result.plan.edit.caption) {
          const applied = await onApply(result);
          if (!applied.ok) { setMessage(applied.reason === "stale" ? "The timeline changed while Opus was working, so the run stopped before making anything." : `The run stopped before making anything: ${applied.message}`); return; }
          base = applied.timeline; baseGeneration = applied.generation;
        }
        const step = directorLoopStep(result.plan, { round: state.round, maxRounds: DIRECTOR_LOOP_MAX_ROUNDS, budgetCredits: budget, spentCredits: state.spent });
        if (step.kind === "done") { setMessage(step.reason); return; }
        const shot = result.plan.shots[step.index];
        setBusy(true);
        const response = await fetch(`/api/reels/${reelId}/director/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ editId: result.editId, index: step.index, quotedCredits: step.credits, approved: true, auto: { runId: state.runId, budgetCredits: budget }, ...withPresenter }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Generation did not start.");
        state.spent += step.credits; state.round += 1;
        setGenerated(g => ({ ...g, [`${result.editId}:${step.index}`]: data.id }));
        setMessage(`Making "${shot.title}" · ${state.spent} of ${budget} credits used. Opus will check it when it is ready, in a few minutes…`);
        const asset = await waitForTake(data.id, state);
        if (state.stop) { setMessage(`Stopped. "${shot.title}" will still finish and appear in your media.`); return; }
        if (!asset) { setMessage(`"${shot.title}" did not come out, so the run stopped. A failed shot's credit is returned.`); return; }
        setExtra(prev => [...prev, asset]);
        onAssets?.([asset]);
        request = directorLoopBrief(brief, state.round, { title: shot.title, fileName: asset.fileName });
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "The run stopped. Check saved reviews before starting another."); }
    finally { loop.current = null; setRunning(false); setBusy(false); }
  }
  async function runPost(runId: string, body: unknown): Promise<PublicDirectorRun> {
    const response = await fetch(`/api/reels/${reelId}/director/runs/${runId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.message ?? "The run could not be updated.");
    setSavedRun(data.run.status === "RUNNING" || data.run.status === "QUEUED" ? data.run : null);
    return data.run;
  }
  /**
   * "Make it for me" on a saved run (ADR 0049). Each pass reads where the run
   * is from the server (round, credits used, the shot it waits for, its last
   * review), so the same code starts a run and continues one after a reload
   * or a web restart. Frames are still sampled here, in the editor tab.
   */
  async function runSaved(existing: PublicDirectorRun | null) {
    stopSaved.current = false; setRunning(true);
    let run = existing;
    // "succeeded" only when the loop decided it was done; every other ending is recorded as the failure it is.
    const end = async (text: string, outcome: "succeeded" | "failed" = "failed") => { setMessage(text); if (run) await runPost(run.id, { action: "finish", message: text, outcome }).catch(() => undefined); };
    try {
      if (!run) {
        const response = await fetch(`/api/reels/${reelId}/director/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID(), brief, budgetCredits: budget }) });
        const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.message ?? "The run could not start.");
        run = data.run as PublicDirectorRun; setSavedRun(run);
      }
      const original = run.state.brief ?? brief;
      // The editor's document generation the next review is asked against (ADR 0048): now, then after each apply.
      let baseGeneration = generation;
      for (let resumed = Boolean(existing), follow = false; ; resumed = follow, follow = false) {
        if (stopSaved.current || run.cancelRequested) return;
        const last = run.steps.at(-1);
        let result: Review | null;
        if (last && run.steps.length === run.round + 1) {
          // This round's review exists: wait for it or read it.
          if (last.status === "QUEUED" || last.status === "RUNNING") {
            setBusy(true); setMessage("Opus is still reviewing this round…");
            const answer = await waitForAiJob<Review>(last.id).finally(() => setBusy(false));
            await acceptResult(answer);
            if (!answer.ok) { await end(answer.message); return; }
            result = answer;
            run = await runPost(run.id, { action: "note", message: "Opus reviewed this round." });
          } else if (last.status === "SUCCEEDED" && last.result) { result = last.result as Review; setReview(result); }
          else { await end(last.error ?? "Opus could not finish this round, so the run stopped."); return; }
        } else {
          // The next review: the first from the brief, later ones check the take the last round made.
          let request = original, base = timeline;
          const previous = last?.result as Review | null | undefined;
          if (previous) {
            // The run expects the next review to start from what the last one left (its edit if it had one).
            base = previous.applied.length > 0 || previous.plan.edit.caption ? previous.timeline : previous.baseline;
            const awaiting = run.state.awaiting;
            if (awaiting) {
              setMessage(`Waiting for "${awaiting.title}"…`);
              const asset = await waitForTake(awaiting.generationId, { get stop() { return stopSaved.current; } });
              if (stopSaved.current) return;
              if (!asset) { await end(`"${awaiting.title}" did not come out, so the run stopped. A failed shot's credit is returned.`); return; }
              setExtra(prev => [...prev, asset]); onAssets?.([asset]);
              request = directorLoopBrief(original, run.round, { title: awaiting.title, fileName: asset.fileName });
            }
          }
          result = await direct(request, base, run.state.firstEditId ?? null, baseGeneration, run.id);
          if (!result && (refused.current === "busy" || refused.current === "reviewed")) {
            // Another tab started this round's review first: follow it rather than ending the run under it.
            setMessage("This run is going on in another tab; following it…");
            const response = await fetch(`/api/reels/${reelId}/director/runs/${run.id}`, { cache: "no-store" });
            const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.message ?? "The run could not be read.");
            run = data.run as PublicDirectorRun; setSavedRun(run);
            follow = true; // like a resume: the other tab may already have applied what it gets
            continue;
          }
          if (!result) { await end("Opus could not finish this round, so the run stopped. Check saved reviews before starting another."); return; }
          run = await runPost(run.id, { action: "note", message: "Opus reviewed this round." });
        }
        if (stopSaved.current) return;
        // Apply the review once: after a reload the editor may already show it.
        const changes = result.applied.length > 0 || Boolean(result.plan.edit.caption);
        const alreadyApplied = resumed && sameTimeline(result.timeline, timeline);
        if (changes && !alreadyApplied) {
          const applied = await onApply(result);
          if (!applied.ok) { await end(applied.reason === "stale" ? "The timeline changed while Opus was working, so the run stopped before making anything." : `The run stopped before making anything: ${applied.message}`); return; }
          baseGeneration = applied.generation;
        }
        const reviewStep = run.steps.at(-1)!;
        if (changes) run = await runPost(run.id, { action: "note", appliedStepId: reviewStep.id });
        const step = directorLoopStep(result.plan, { round: run.round, maxRounds: run.maxRounds, budgetCredits: run.budgetCredits, spentCredits: run.spentCredits });
        if (step.kind === "done") { await end(step.reason, "succeeded"); return; }
        const shot = result.plan.shots[step.index];
        const review = result;
        setBusy(true);
        // Approving the same review and shot again reuses its generation (ADR 0034), so a resumed run never pays twice.
        const response = await fetch(`/api/reels/${reelId}/director/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ editId: review.editId, index: step.index, quotedCredits: step.credits, approved: true, auto: { runId: run.state.firstEditId ?? review.editId, budgetCredits: run.budgetCredits }, ...withPresenter }) });
        const data = await response.json(); setBusy(false); if (!response.ok) throw new Error(data.error ?? "Generation did not start.");
        setGenerated(g => ({ ...g, [`${review.editId}:${step.index}`]: data.id }));
        run = await runPost(run.id, { action: "advance", stepId: reviewStep.id, index: step.index, generationId: data.id, applied: changes });
        setMessage(`Making "${shot.title}" · ${run.spentCredits} of ${run.budgetCredits} credits used. Opus will check it when it is ready, in a few minutes…`);
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "The run stopped. Its progress is saved; check it before starting another."); }
    finally { setRunning(false); setBusy(false); }
  }
  async function stopRun() {
    stopSaved.current = true; if (loop.current) loop.current.stop = true;
    setMessage("Stopping after the current step…");
    if (savedRun) await runPost(savedRun.id, { action: "stop", message: "Stopped." }).catch(() => undefined);
  }
  async function resume(id: string) {
    setBusy(true); setMessage("Opus is still working on your last request…");
    try { await acceptResult(await waitForAiJob<Review>(id)); } finally { setBusy(false); }
  }
  async function generate(index: number) {
    if (!review) return; setApproving(index); setMessage("");
    try {
      const response = await fetch(`/api/reels/${reelId}/director/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ editId: review.editId, index, quotedCredits: aiClipCredits(review.plan.shots[index].durationSeconds, Boolean(review.plan.shots[index].voice)), approved: true, ...withPresenter }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Generation did not start.");
      setGenerated(g => ({ ...g, [`${review.editId}:${index}`]: data.id }));
      setMessage("Making the shot. It takes a few minutes; ask Opus again once it is ready and it will check the result. Tapping again will not charge twice.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not start this shot. Repeating the same approval reuses its request."); }
    finally { setApproving(null); }
  }
  const current = review && (review.generation !== undefined ? review.generation === generation : sameTimeline(review.baseline, timeline));
  return <Sheet title="Ask Opus" onClose={onClose}>
    <p className="muted">Tell Opus what you think, the way you would tell an editor. It looks through every clip, including AI takes you have not used, and suggests fixes. Nothing changes until you tap Apply, and new AI shots always ask first.</p>
    {savedRun && !running ? <section aria-label="Saved run">
      <p className="small"><strong>A “make it for me” run is in progress</strong> · round {savedRun.round + 1} of {savedRun.maxRounds + 1} · {savedRun.spentCredits} of {savedRun.budgetCredits} credits used{savedRun.state.awaiting ? ` · waiting for “${savedRun.state.awaiting.title}”` : ""}</p>
      {savedRun.state.message ? <p className="muted small">{savedRun.state.message}</p> : null}
      <button type="button" className="btn btn-signal btn-block" disabled={busy} onClick={() => { void runSaved(savedRun); }}>Continue the run</button>
      <button type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => { void stopRun(); }}>Stop the run</button>
    </section> : null}
    {pending.map(j => <button key={j.id} type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => resume(j.id)}>Opus is still working on your last request · show it</button>)}
    <label className="field">What do you think?<textarea className="text-area" rows={5} maxLength={4000} value={brief} onChange={e => setBrief(e.target.value)} disabled={busy} placeholder="For example: the skydive looks fake, she vanishes between shots, and she looks huge next to the house." /></label>
    <fieldset className="field" disabled={busy}>
      <legend className="small">AI shots</legend>
      <label className="small"><input type="radio" name="director-mode" checked={mode === "ask"} onChange={() => setMode("ask")} /> Ask me before using credits</label>
      <label className="small"><input type="radio" name="director-mode" checked={mode === "auto"} onChange={() => setMode("auto")} /> Make it for me, up to <input type="number" inputMode="numeric" min={1} max={40} value={budget} onChange={e => setBudget(Math.max(1, Math.min(40, Math.round(Number(e.target.value) || 1))))} style={{ width: "4em" }} aria-label="Credit budget" /> {budget === 1 ? "credit" : "credits"}</label>
      {mode === "auto" ? <span className="muted small">Opus applies its changes, makes one shot at a time, checks each result, and stops when it is happy, when the budget cannot cover the next shot, or after {DIRECTOR_LOOP_MAX_ROUNDS} rounds. You can stop it at any point; shots already made stay in your media.</span> : null}
    </fieldset>
    {running
      ? <button type="button" className="btn btn-quiet btn-block" onClick={() => { void stopRun(); }}>Stop the run</button>
      : <button type="button" className="btn btn-signal btn-block" disabled={busy || brief.trim().length < 3} onClick={() => { void (mode === "auto" ? (durable ? runSaved(null) : run()) : direct()); }}>{busy ? "Opus is working…" : mode === "auto" ? `Make it for me · up to ${budget} ${budget === 1 ? "credit" : "credits"}` : "Ask Opus"}</button>}
    <PresenterPicker library={media} value={presenterId} onChange={setPresenterId} onAssets={assets => { setExtra(prev => [...prev, ...assets]); onAssets?.(assets); }} disabled={busy || running} />
    {message ? <p role="status" className="small">{message}</p> : null}
    {history.length > 0 ? <details><summary>Earlier suggestions ({history.length})</summary>{history.map(h => <button key={h.editId} type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => setReview(h)}>{h.plan.note.slice(0, 110)}</button>)}</details> : null}
    {review ? <section aria-label="Opus direction">
      <p><strong>{VERDICTS[review.plan.verdict]}</strong></p><p>{review.plan.note}</p>
      <ul aria-label="Continuity and scale checks">{Object.entries(review.plan.checks).map(([name, check]) => <li key={name}><strong>{CHECKS[name] ?? name}: {RESULTS[check.result]}</strong> — {check.evidence}</li>)}</ul>
      {review.plan.issues.length ? <ul>{review.plan.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul> : null}
      <p className="muted small">{review.plan.limitations}</p>
      <details><summary>What Opus looked at</summary><p className="small">{review.evidence.length} clips, {review.evidence.reduce((n, e) => n + e.timesMs.length, 0)} frames. Opus sees still frames, not sound or the finished playback.</p></details>
      {review.applied.length > 0 || review.plan.edit.caption ? <><details><summary>What Opus would change</summary><ul>{review.applied.map((s, i) => <li key={i}>{s}</li>)}</ul>{review.skipped.map((s, i) => <p key={i}>{s}</p>)}{review.plan.edit.caption ? <p style={{ whiteSpace: "pre-wrap" }}>Post caption: {review.plan.edit.caption}</p> : null}</details><button type="button" className="btn btn-signal btn-block" disabled={!current || busy} onClick={() => { void onApply(review).then((applied) => setMessage(applied.ok ? "Applied as one editable, undoable step." : applied.reason === "stale" ? "The timeline changed. Ask Opus to review the current edit." : applied.message)); }}>Apply these changes</button>{!current ? <p className="small">You have edited the reel since. Ask Opus again before applying.</p> : null}</> : null}
      {review.plan.shots.map((s, i) => <article key={`${review.editId}:${i}`}>
        <h3>{s.title}</h3><p>{s.reason}</p>{s.line ? <p className="small">She says: “{s.line}” · {s.voice === "veo" ? "Veo's own voice" : "the presenter voice, lip-synced"}</p> : null}{proposalDepth(s) > 0 ? <p className="small"><span className="badge badge-running">Made from an AI take · {proposalDepth(s)} {proposalDepth(s) === 1 ? "hop" : "hops"} from her real photos</span> Faces drift when takes are chained. Pick a presenter above so her face comes from the kit.</p> : null}{s.compose && !presenterId && !s.compose.presenter ? <p className="small"><span className="badge badge-failed">Needs a presenter</span> Set one up above before making this shot.</p> : null}<p className="small">New {s.durationSeconds}-second AI shot · {aiClipCredits(s.durationSeconds, Boolean(s.voice))} {aiClipCredits(s.durationSeconds, Boolean(s.voice)) === 1 ? "credit" : "credits"}</p>
        <details><summary>Opus's instructions for this shot</summary><p style={{ whiteSpace: "pre-wrap" }}>{s.prompt}</p><p className="small">First: {s.first ? `${media.find(a => a.id === s.first!.assetId)?.fileName ?? s.first.assetId} at ${(s.first.atMs / 1000).toFixed(2)}s` : "None"}<br />Last: {s.last ? `${media.find(a => a.id === s.last!.assetId)?.fileName ?? s.last.assetId} at ${(s.last.atMs / 1000).toFixed(2)}s` : "None"}{s.compose ? <><br />Start and end stills are composed first ({s.compose.framing} framing), placing the presenter from {presenterId || !s.compose.presenter ? "your presenter kit" : media.find(a => a.id === s.compose!.presenter!.assetId)?.fileName ?? s.compose.presenter.assetId} into the real frame at human scale, and her face is checked against the kit before any credit is spent on Veo.</> : null}</p></details>
        <button type="button" className="btn btn-quiet btn-block" disabled={approving !== null || busy || Boolean(generated[`${review.editId}:${i}`])} onClick={() => generate(i)}>{generated[`${review.editId}:${i}`] ? "Making the shot…" : approving === i ? "Starting…" : `Make this shot · ${aiClipCredits(s.durationSeconds, Boolean(s.voice))} ${aiClipCredits(s.durationSeconds, Boolean(s.voice)) === 1 ? "credit" : "credits"}`}</button>
      </article>)}
    </section> : null}
  </Sheet>;
}
