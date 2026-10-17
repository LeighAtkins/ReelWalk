"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AI_SHOT_LABELS, AI_SHOT_MODES, aiBoundary, aiShotSchema, type AiShot, type AiShotMode, type Clip } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";

type Job = { id: string; prompt: string; status: string; error: string | null; asset: LibraryAsset | null; shot: unknown; draftId: string | null };
type State = { enabled: boolean; balance: { remaining: number; monthly: number; trial: number; topUp: number }; jobs: Job[] };
const active = (job: Job) => ["QUEUED", "SUBMITTING", "RUNNING"].includes(job.status);

export function AiVideoPanel({ photos, clips = [], selectedClip, reelId, beforeGenerate, onAdd }: {
  photos: LibraryAsset[]; clips?: Clip[]; selectedClip?: Clip | null; reelId?: string;
  beforeGenerate?(): Promise<boolean>; onAdd?(asset: LibraryAsset, shot?: AiShot): void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [prompt, setPrompt] = useState("Keep the property unchanged and make the camera movement feel natural.");
  const [mode, setMode] = useState<AiShotMode>(selectedClip?.kind === "VIDEO" ? "continue" : selectedClip?.kind === "IMAGE" ? "gimbal" : "custom");
  const [photo, setPhoto] = useState(selectedClip ? `clip:${selectedClip.id}` : "");
  const selectedIndex = clips.findIndex(c => c.id === selectedClip?.id);
  const [last, setLast] = useState(selectedIndex >= 0 && clips[selectedIndex + 1] ? `clip:${clips[selectedIndex + 1].id}` : "");
  const [firstMs, setFirstMs] = useState(0);
  const [lastMs, setLastMs] = useState(0);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const requestSignature = useRef("");
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

  const bridge = mode === "bridge" || mode === "burst";
  const camera = mode === "gimbal" || mode === "drone";
  const available = photos.filter(a => !a.isPano && (a.kind === "VIDEO" || (a.kind === "IMAGE" && /\.(jpe?g|png)$/i.test(a.fileName))));
  const anchor = photo.startsWith("clip:") ? clips.find(c => c.id === photo.slice(5)) : undefined;
  const next = last.startsWith("clip:") ? clips.find(c => c.id === last.slice(5)) : undefined;
  function source(value: string, end: boolean, atMs: number) {
    const clip = value.startsWith("clip:") ? clips.find(c => c.id === value.slice(5)) : undefined;
    return clip ? aiBoundary(clip, end) : value ? { assetId: value.slice(6), atMs } : undefined;
  }
  const firstFrame = source(photo, true, firstMs);
  const lastFrame = bridge ? source(last, false, lastMs) : undefined;

  function picker(ending: boolean) {
    const value = ending ? last : photo;
    const frame = ending ? lastFrame : firstFrame;
    const asset = available.find(a => a.id === frame?.assetId);
    return <label className="field">{ending ? "End at" : "Start from"}
      <select className="text-input" value={value} disabled={busy} onChange={e => {
        if (ending) { setLast(e.target.value); setLastMs(0); } else { setPhoto(e.target.value); setFirstMs(0); }
      }}>
        <option value="">{ending ? "Choose the landing frame" : mode === "custom" ? "Generate from words" : "Choose a photo or video"}</option>
        {clips.filter(c => !c.pano && available.some(a => a.id === c.assetId && (!camera || a.kind === "IMAGE"))).map(c => <option key={c.id} value={`clip:${c.id}`}>
          Reel shot {clips.indexOf(c) + 1} · {ending ? "first" : "last"} frame · {photos.find(a => a.id === c.assetId)?.fileName}
        </option>)}
        {available.filter(a => !camera || a.kind === "IMAGE").map(a => <option key={a.id} value={`asset:${a.id}`}>{a.fileName}</option>)}
      </select>
      {asset?.kind === "IMAGE" ? <img className="ai-reference" src={asset.url} alt={ending ? "Ending reference" : "Starting reference"} /> : null}
      {asset?.kind === "VIDEO" ? <>
        <video className="ai-reference" key={`${asset.id}-${frame?.atMs}`} src={asset.url} muted playsInline preload="auto"
          onLoadedMetadata={e => { e.currentTarget.currentTime = (frame?.atMs ?? 0) / 1000; }} aria-label={`${ending ? "Ending" : "Starting"} source frame`} />
        {value.startsWith("asset:") ? <span>Frame time (seconds)<input className="text-input" type="number" min={0} max={Math.max(0, (asset.durationMs ?? 0) / 1000 - 0.034)} step="0.001"
          value={(ending ? lastMs : firstMs) / 1000} disabled={busy} onChange={e => (ending ? setLastMs : setFirstMs)(Math.max(0, Math.round(Number(e.target.value) * 1000)))} /></span> :
          <span className="muted small">Uses the trimmed clip's {ending ? "first" : "last"} frame ({((frame?.atMs ?? 0) / 1000).toFixed(3)}s in the source).</span>}
      </> : null}
    </label>;
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const shot = aiShotSchema.safeParse({ mode, first: firstFrame, last: lastFrame, anchor,
      next: bridge && anchor ? next : undefined, ...(draft && anchor && reelId ? { draftReelId: reelId } : {}),
    });
    if (!shot.success) { setError(shot.error.issues[0]?.message || "Choose source frames."); return; }
    if (bridge && anchor && (!next || clips.indexOf(next) !== clips.indexOf(anchor) + 1)) {
      setError("Choose the shot immediately after the starting clip for a timeline bridge."); return;
    }
    setBusy(true);
    try {
      if (beforeGenerate && !await beforeGenerate()) throw new Error("Save your reel before generating this shot.");
      const payload = { prompt, shot: shot.data };
      const signature = JSON.stringify(payload);
      if (signature !== requestSignature.current) { requestSignature.current = signature; requestId.current = null; }
      requestId.current ??= crypto.randomUUID();
      const response = await fetch("/api/ai/generations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: requestId.current, ...payload }),
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
    <p className="muted small">One credit generates 8 seconds of silent 1080p video. Bridges use the full move in 4 seconds; bursts in 2 seconds. Your real footage stays in the reel.</p>
    {state && !state.enabled ? <p className="toast" role="status">AI video is being connected. Your credits are ready for when it opens.</p> : null}
    <form onSubmit={generate} className="ai-video-form">
      <label className="field">Make a shot
        <select className="text-input" value={mode} disabled={busy} onChange={e => {
          const value = e.target.value as AiShotMode;
          setMode(value);
          if (["gimbal", "drone"].includes(value) && photos.find(a => a.id === firstFrame?.assetId)?.kind !== "IMAGE") setPhoto("");
        }}>
          {AI_SHOT_MODES.map(m => <option key={m} value={m}>{AI_SHOT_LABELS[m]}</option>)}
        </select>
      </label>
      {picker(false)}
      {bridge ? picker(true) : null}
      {mode === "drone" ? <p className="muted small">Choose an exterior photo with room above the roofline. A small rise is more faithful than a wide invented aerial view.</p> : null}
      <label className="field">Describe the shot
        <textarea className="text-input" rows={4} minLength={10} maxLength={2000} required value={prompt}
          placeholder="A slow, smooth camera push into a bright living room, morning light through the windows. Keep the layout and furniture unchanged."
          disabled={busy} onChange={e => { setPrompt(e.target.value); requestId.current = null; }} />
      </label>
      {anchor && reelId ? <label className="field"><span><input type="checkbox" checked={draft} disabled={busy} onChange={e => setDraft(e.target.checked)} /> Automatically make a separate promo draft</span>
        <span className="muted small">Completes while you are away. Keeps your original reel, music and captions. Changed boundaries wait for review.</span></label> : null}
      <p className="muted small">References use the original frame with a centre crop to portrait. Review joins, especially with zoom, colour effects or letterboxing.</p>
      <p className="muted small">Each new version uses a credit. Technical failures return it. Review generated property details before publishing.</p>
      {error ? <p className="error small" role="alert">{error}</p> : null}
      <button className="btn btn-block" type="submit" disabled={busy || !state?.enabled || state.balance.remaining < 1 || state.jobs.filter(active).length >= 2}>
        {busy ? "Starting…" : "Generate 8-second clip · 1 credit"}
      </button>
      <p className="muted small"><Link href="/account">Plans and more credits</Link></p>
    </form>
    <div className="ai-video-results" aria-live="polite">
      {state?.jobs.map(job => <article className="ai-video-result" key={job.id}>
        <p className="small">{aiShotSchema.safeParse(job.shot).success ? AI_SHOT_LABELS[(job.shot as AiShot).mode] : job.prompt}</p>
        {active(job) ? <p className="muted small" role="status">{job.status === "QUEUED" ? "Waiting to start…" : "Generating your shot…"} You can leave and return later.</p> : null}
        {job.status === "FAILED" ? <p className="error small">{job.error}</p> : null}
        {job.asset ? <>
          <video src={job.asset.url} controls playsInline preload="metadata" aria-label="Generated AI clip" />
          <p className="muted small">AI-generated · saved in your media library</p>
          {job.draftId ? <Link className="btn btn-block" href={`/reels/${job.draftId}`}>Review blended promo draft</Link> : null}
          {job.asset && (job.shot as AiShot | null)?.draftReelId && !job.draftId ? <p className="muted small">The source boundary changed. Your clip is ready in the media library.</p> : null}
          {onAdd ? <button type="button" className="btn btn-block" onClick={() => { const recipe = aiShotSchema.safeParse(job.shot); onAdd(job.asset!, recipe.success ? recipe.data : undefined); }}>{(job.shot as AiShot | null)?.anchor ? "Place at source cut / replace still" : "Add to reel"}</button> :
            <Link className="btn btn-quiet btn-block" href="/">Open your reels to use this clip</Link>}
        </> : null}
      </article>)}
    </div>
  </div>;
}
