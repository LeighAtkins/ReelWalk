"use client";

import Link from "next/link";
import { runAiJob } from "@/lib/ai-jobs-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { aiClipCredits } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";

type Job = { id: string; prompt: string; status: string; error: string | null; asset: LibraryAsset | null };
export type Suggestion = { recommended: boolean; title: string; reason: string; prompt: string; durationSeconds: 4 | 8 };
export type VideoIdea = { referenceAssetId: string; suggestion: Suggestion; generatedJobId?: string };
type State = { mode: "ASK" | "AUTO"; enabled: boolean; balance: { remaining: number; monthly: number; trial: number; topUp: number }; jobs: Job[] };
const active = (job: Job) => ["QUEUED", "SUBMITTING", "RUNNING"].includes(job.status);

export function AiVideoPanel({ photos, onAdd, preferredPhotoId, initialIdea }: { initialIdea?: VideoIdea; preferredPhotoId?: string; photos: LibraryAsset[]; onAdd?(asset: LibraryAsset): void }) {
  const [state, setState] = useState<State | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(initialIdea?.suggestion ?? null);
  const autoAdd = useRef(new Set<string>(initialIdea?.generatedJobId ? [initialIdea.generatedJobId] : []));
  const added = useRef(new Set<string>());
  const [prompt, setPrompt] = useState(initialIdea?.suggestion.prompt ?? "");
  const [photo, setPhoto] = useState(initialIdea?.referenceAssetId ?? preferredPhotoId ?? "");
  const [seconds, setSeconds] = useState<4 | 8>(initialIdea?.suggestion.durationSeconds ?? 4);
  const credits = aiClipCredits(seconds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/ai/generations", { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load AI clips.");
    setState(data);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [refresh]);

  const running = state?.jobs.some(active) ?? false;
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void refresh(controller.signal).catch(() => {}); }, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [running, refresh]);

  useEffect(() => {
    if (!onAdd) return;
    for (const job of state?.jobs ?? []) if (job.asset && autoAdd.current.has(job.id) && !added.current.has(job.id)) {
      added.current.add(job.id);
      onAdd(job.asset);
    }
  }, [state, onAdd]);

  async function suggest() {
    if (!photo || busy) return;
    setBusy(true); setError(null);
    requestId.current ??= crypto.randomUUID();
    try {
      const result = await runAiJob<{ ok: true; suggestion: Suggestion; generatedJobId?: string }>("/api/listing-assistance", { kind: "video-suggestion", assetId: photo, requestId: requestId.current });
      if (!result.ok) throw new Error(result.message);
      setSuggestion(result.suggestion);
      setPrompt(result.suggestion.prompt); setSeconds(result.suggestion.durationSeconds);
      if (result.generatedJobId) { autoAdd.current.add(result.generatedJobId); requestId.current = null; await refresh(); }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not get a suggestion."); }
    finally { setBusy(false); }
  }

  async function generate() {
    setBusy(true); setError(null);
    requestId.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/ai/generations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true, execution: "manual", requestId: requestId.current, prompt, durationSeconds: seconds, ...(photo ? { referenceAssetId: photo } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not start this shot.");
      requestId.current = null;
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Connection interrupted. Try again to check this request."); }
    finally { setBusy(false); }
  }

  return <div className="ai-video-panel">
    <p className="ai-credit-count" role="status">{state ? `${state.balance.remaining} AI ${state.balance.remaining === 1 ? "credit" : "credits"} available` : "Loading your credits…"}</p>
    <p className="muted small">One credit makes a 4-second vertical clip at 1080p, without sound; an 8-second clip uses 2. Add music in the editor.</p>
    {state && !state.enabled ? <p className="toast" role="status">AI video is being connected. Your credits are ready for when it opens.</p> : null}
    <form onSubmit={event => { event.preventDefault(); void generate(); }} className="ai-video-form">
      <label className="field">Start from a photo (optional)
        <select className="text-input" value={photo} onChange={e => { setPhoto(e.target.value); requestId.current = null; setSuggestion(null); }} disabled={busy}>
          <option value="">Generate from words</option>
          {photos.filter(p => p.kind === "IMAGE" && !p.isPano && /\.(jpe?g|png)$/i.test(p.fileName)).map(p => <option key={p.id} value={p.id}>{p.fileName}</option>)}
        </select>
      </label>
      {photo ? <button type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => void suggest()}>Let Opus suggest an enhancement</button> : null}
      {suggestion ? <section className="card" data-testid="veo-suggestion"><h3>{suggestion.title}</h3><p>{suggestion.reason}</p><p className="muted small">{suggestion.recommended ? `${seconds} seconds / ${credits} credit${credits === 1 ? "" : "s"}. ${state?.mode === "AUTO" ? "Your paid automatic mode authorizes generation." : "Nothing generates until you approve below."}` : "Opus recommends keeping the real photo. No video credits spent."}</p></section> : null}
      {photo ? <img className="ai-reference" src={photos.find(p => p.id === photo)?.url} alt="Reference photo for this shot" /> : null}
      <label className="field">Clip length
        <select className="text-input" value={seconds} disabled={busy} onChange={e => { setSeconds(Number(e.target.value) as 4 | 8); requestId.current = null; }}>
          <option value={4}>4 seconds · 1 credit</option><option value={8}>8 seconds · 2 credits</option>
        </select>
        <span className="muted small">Shorter clips stay closer to your photo.</span>
      </label>
      <label className="field">Describe the shot
        <textarea className="text-input" rows={4} minLength={10} maxLength={2000} required value={prompt}
          placeholder="A slow, smooth camera push into a bright living room, morning light through the windows. Keep the layout and furniture unchanged."
          disabled={busy} onChange={e => { setPrompt(e.target.value); requestId.current = null; }} />
      </label>
      <p className="muted small">Each new version uses credits. Technical failures return them. Review generated property details before publishing.</p>
      {error ? <p className="error small" role="alert">{error}</p> : null}
      <button className="btn btn-block" type="submit" disabled={busy || !state?.enabled || state.balance.remaining < credits || state.jobs.filter(active).length >= 2 || state.jobs.some(job => active(job) && job.prompt === prompt)}>
        {busy ? "Starting…" : `Yes, generate ${seconds}-second clip · ${credits} ${credits === 1 ? "credit" : "credits"}`}
      </button>
      <p className="muted small"><Link href="/account">Plans and more credits</Link></p>
    </form>
    <div className="ai-video-results" aria-live="polite">
      {state?.jobs.map(job => <article className="ai-video-result" key={job.id}>
        <p className="small">{job.prompt}</p>
        {active(job) ? <p className="muted small" role="status">{job.status === "QUEUED" ? "Waiting to start…" : "Generating your shot…"} You can leave and return later.</p> : null}
        {job.status === "FAILED" ? <p className="error small">{job.error}</p> : null}
        {job.asset ? <>
          <video src={job.asset.url} controls playsInline preload="metadata" aria-label="Generated AI clip" />
          <p className="muted small">AI-generated · saved in your media library</p>
          {onAdd ? <button type="button" className="btn btn-block" onClick={() => onAdd(job.asset!)}>Add to reel</button> :
            <Link className="btn btn-quiet btn-block" href="/">Open your reels to use this clip</Link>}
        </> : null}
      </article>)}
    </div>
  </div>;
}
