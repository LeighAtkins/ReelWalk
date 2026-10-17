"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryAsset } from "@/lib/library";

type Job = { id: string; prompt: string; status: string; error: string | null; asset: LibraryAsset | null };
type State = { enabled: boolean; balance: { remaining: number; monthly: number; trial: number; topUp: number }; jobs: Job[] };
const active = (job: Job) => ["QUEUED", "SUBMITTING", "RUNNING"].includes(job.status);

export function AiVideoPanel({ photos, onAdd }: { photos: LibraryAsset[]; onAdd?(asset: LibraryAsset): void }) {
  const [state, setState] = useState<State | null>(null);
  const [prompt, setPrompt] = useState("");
  const [photo, setPhoto] = useState("");
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

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    requestId.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/ai/generations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: requestId.current, prompt, ...(photo ? { referenceAssetId: photo } : {}) }),
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
    <p className="muted small">One credit makes an 8-second vertical clip at 1080p, without sound. Add music in the editor.</p>
    {state && !state.enabled ? <p className="toast" role="status">AI video is being connected. Your credits are ready for when it opens.</p> : null}
    <form onSubmit={generate} className="ai-video-form">
      <label className="field">Start from a photo (optional)
        <select className="text-input" value={photo} onChange={e => { setPhoto(e.target.value); requestId.current = null; }} disabled={busy}>
          <option value="">Generate from words</option>
          {photos.filter(p => p.kind === "IMAGE" && !p.isPano && /\.(jpe?g|png)$/i.test(p.fileName)).map(p => <option key={p.id} value={p.id}>{p.fileName}</option>)}
        </select>
      </label>
      {photo ? <img className="ai-reference" src={photos.find(p => p.id === photo)?.url} alt="Reference photo for this shot" /> : null}
      <label className="field">Describe the shot
        <textarea className="text-input" rows={4} minLength={10} maxLength={2000} required value={prompt}
          placeholder="A slow, smooth camera push into a bright living room, morning light through the windows. Keep the layout and furniture unchanged."
          disabled={busy} onChange={e => { setPrompt(e.target.value); requestId.current = null; }} />
      </label>
      <p className="muted small">Each new version uses a credit. Technical failures return it. Review generated property details before publishing.</p>
      {error ? <p className="error small" role="alert">{error}</p> : null}
      <button className="btn btn-block" type="submit" disabled={busy || !state?.enabled || state.balance.remaining < 1 || state.jobs.filter(active).length >= 2}>
        {busy ? "Starting…" : "Generate 8-second clip · 1 credit"}
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
