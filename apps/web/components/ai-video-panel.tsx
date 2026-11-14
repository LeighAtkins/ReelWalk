"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AI_CAMERA_MOVE_RECIPES, AI_DRAFT_CREDITS, MOVES, MOVE_GROUPS, MOVE_GROUP_LABELS, aiFinalCredits, isCameraMove, moveById, movePrompt, AI_SHOT_LABELS, AI_SHOT_MODES, AI_SHOT_STYLES, AI_SHOT_STYLE_LABELS, AI_SHOT_ATMOSPHERES, AI_SHOT_ATMOSPHERE_LABELS,
  aiBoundary, aiClipCredits, aiConnectsClips, aiDefaultClipSeconds, aiShotSchema, aiShotStyle, type AiShot, type MoveId, type AiShotMode, type AiShotStyle, type AiShotAtmosphere, type Clip } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { CAMERA_KEYFRAME_MOVES, cameraKeyframeVideoPrompt, type CameraKeyframeMove, type CameraKeyframeInput } from "@reelwalk/core";
import { ShotSourcePicker } from "./shot-source-picker";
import { ShotKeyframePanel } from "./shot-keyframe-panel";
import { shotBuilderDraftSchema, shotBuilderRecoveryKey } from "./shot-builder-draft";
import styles from "./shot-workspace.module.css";
import { AI_QUEUE_LIMIT, queueLabel, type QueuePosition, type TakeTrim } from "@reelwalk/core";

type Job = { id: string; prompt: string; status: string; error: string | null; asset: LibraryAsset | null; shot: unknown; draftId: string | null;
  /** The take queue and the gate's measurements (ADR 0069). */
  queue?: QueuePosition | null; faceHeightPx?: number | null; framing?: string | null; take?: TakeTrim | null;
  /** Credits this take used, its length, and the final made from it when it is a draft (ADR 0076). */
  credits?: number; durationSeconds?: number; finalId?: string | null };
type State = { enabled: boolean; balance: { remaining: number; monthly: number; trial: number; topUp: number }; jobs: Job[] };
const active = (job: Job) => ["QUEUED", "SUBMITTING", "RUNNING"].includes(job.status);
const DEFAULT_PROMPT = "Make the sequence flow naturally and keep the referenced property's identity recognisable.";
const tierOf = (job: Job): "draft" | "final" | null => { const tier = (job.shot as { tier?: string } | null)?.tier; return tier === "draft" || tier === "final" ? tier : null; };

export function AiVideoPanel({ photos, clips = [], selectedClip, reelId, beforeGenerate, onAdd, initialMove = null }: {
  photos: LibraryAsset[]; clips?: Clip[]; selectedClip?: Clip | null; reelId?: string;
  /** A camera move the Moves sheet chose (ADR 0076): selected, with its words in the prompt. */
  initialMove?: MoveId | null;
  beforeGenerate?(): Promise<boolean>; onAdd?(asset: LibraryAsset, shot?: AiShot): void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [prompt, setPrompt] = useState(initialMove ? movePrompt(initialMove) : DEFAULT_PROMPT);
  const [move, setMove] = useState<MoveId | "">(initialMove ?? "");
  const [quality, setQuality] = useState<"draft" | "final">("final");
  const [mode, setMode] = useState<AiShotMode>(selectedClip?.kind === "VIDEO" ? "continue" : selectedClip?.kind === "IMAGE" ? "gimbal" : "custom");
  const [photo, setPhoto] = useState(selectedClip ? `clip:${selectedClip.id}` : "");
  const [last, setLast] = useState("");
  const [firstMs, setFirstMs] = useState(0);
  const [lastMs, setLastMs] = useState(0);
  const [draft, setDraft] = useState(false);
  const [style, setStyle] = useState<AiShotStyle>("source");
  const [atmosphere, setAtmosphere] = useState<AiShotAtmosphere>("source");
  const [energy, setEnergy] = useState<"subtle" | "bold">("subtle");
  const [harmonize, setHarmonize] = useState(false);
  const [polish, setPolish] = useState(false);
  const [useEndReference, setUseEndReference] = useState(false);
  // null follows the shot type: 8 s for timelapses, 4 s for everything else.
  const [chosenSeconds, setChosenSeconds] = useState<4 | 8 | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraPhotos, setExtraPhotos] = useState<Record<string, LibraryAsset>>({});
  const [direction, setDirection] = useState<CameraKeyframeMove | null>(initialMove ? null : "push-in");
  const [distanceM, setDistanceM] = useState(1);
  const [frameNotes, setFrameNotes] = useState("");
  const [startBase, setStartBase] = useState(selectedClip ? `clip:${selectedClip.id}` : "");
  const [endBase, setEndBase] = useState("");
  const [generatedStart, setGeneratedStart] = useState(false), [generatedEnd, setGeneratedEnd] = useState(false);
  const [startImageBlocked, setStartImageBlocked] = useState(false), [endImageBlocked, setEndImageBlocked] = useState(false);
  const receiveBalance = useCallback((remaining: number) => setState(old => old && old.balance.remaining !== remaining ? { ...old, balance: { ...old.balance, remaining } } : old), []);
  const receiveAssets = useCallback((assets: LibraryAsset[]) => setExtraPhotos(old => {
    if (!assets.some(asset => !old[asset.id] || old[asset.id].url !== asset.url)) return old;
    return { ...old, ...Object.fromEntries(assets.map(asset => [asset.id, asset])) };
  }), []);
  const allPhotos = [...photos.filter(asset => !extraPhotos[asset.id]), ...Object.values(extraPhotos)];
  const [draftLoaded, setDraftLoaded] = useState(false), [recoveryError, setRecoveryError] = useState("");
  const recoveryKey = shotBuilderRecoveryKey(reelId, selectedClip?.id);
  useEffect(() => {
    setDraftLoaded(false);
    try {
      const value = localStorage.getItem(recoveryKey);
      if (!value) {
        const start = selectedClip ? `clip:${selectedClip.id}` : "";
        setPhoto(start); setStartBase(start); setLast(""); setEndBase(""); setFirstMs(0); setLastMs(0);
        setGeneratedStart(false); setGeneratedEnd(false); setUseEndReference(false);
        setDirection(initialMove ? null : "push-in"); setDistanceM(1); setChosenSeconds(null); setFrameNotes("");
        setPrompt(initialMove ? movePrompt(initialMove) : DEFAULT_PROMPT); setMove(initialMove ?? "");
        setMode(selectedClip?.kind === "VIDEO" ? "continue" : selectedClip?.kind === "IMAGE" ? "gimbal" : "custom");
        setQuality("final"); setStyle("source"); setAtmosphere("source"); setEnergy("subtle"); setHarmonize(false); setPolish(false); setDraft(false);
      } else {
        const saved = shotBuilderDraftSchema.parse(JSON.parse(value));
        setPhoto(saved.photo); setLast(saved.last); setStartBase(saved.startBase); setEndBase(saved.endBase);
        setFirstMs(saved.firstMs); setLastMs(saved.lastMs); setGeneratedStart(saved.generatedStart); setGeneratedEnd(saved.generatedEnd);
        setUseEndReference(saved.useEndReference); setDirection(saved.direction); setDistanceM(saved.distanceM); setChosenSeconds(saved.chosenSeconds);
        setFrameNotes(saved.frameNotes); setPrompt(saved.prompt); setMode(saved.mode); setMove(saved.move); setQuality(saved.quality);
        setStyle(saved.style); setAtmosphere(saved.atmosphere); setEnergy(saved.energy); setHarmonize(saved.harmonize); setPolish(saved.polish); setDraft(saved.draft);
      }
    } catch { setRecoveryError("Saved shot choices could not reopen. Your generated images remain in the library."); }
    finally { setDraftLoaded(true); }
  }, [recoveryKey]);
  useEffect(() => {
    if (!draftLoaded) return;
    try {
      localStorage.setItem(recoveryKey, JSON.stringify({ version: 1, photo, last, startBase, endBase, firstMs, lastMs, generatedStart, generatedEnd, useEndReference,
        direction, distanceM, chosenSeconds, frameNotes, prompt, mode, move, quality, style, atmosphere, energy, harmonize, polish, draft }));
    } catch { setRecoveryError("This browser could not save the shot choices. Keep this tab open; generated images are still saved on the server."); }
  }, [draftLoaded, recoveryKey, photo, last, startBase, endBase, firstMs, lastMs, generatedStart, generatedEnd, useEndReference, direction, distanceM, chosenSeconds, frameNotes, prompt, mode, move, quality, style, atmosphere, energy, harmonize, polish, draft]);
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

  const bridge = aiConnectsClips(mode);
  const seconds = chosenSeconds ?? aiDefaultClipSeconds(mode, move || undefined);
  // A draft (ADR 0076) is a Lite 720p preview from a starting frame; credits are whole, so it is one credit whatever the length.
  const noDraft = bridge || useEndReference ? "A draft is made from a starting frame only." : null;
  const draftMode = quality === "draft" && !noDraft;
  const credits = draftMode ? AI_DRAFT_CREDITS : aiClipCredits(seconds);
  const camera = mode === "gimbal" || mode === "drone";
  const anchor = photo.startsWith("clip:") ? clips.find(c => c.id === photo.slice(5)) : undefined;
  const next = last.startsWith("clip:") ? clips.find(c => c.id === last.slice(5)) : undefined;
  function source(value: string, end: boolean, atMs: number) {
    if (value.startsWith("clip:")) {
      const clip = clips.find(c => c.id === value.slice(5));
      return clip ? aiBoundary(clip, end) : undefined;
    }
    return value.startsWith("asset:") ? { assetId: value.slice(6), atMs } : undefined;
  }
  const firstFrame = source(photo, true, firstMs);
  const lastFrame = bridge || useEndReference ? source(last, false, lastMs) : undefined;
  const assetFor = (frame: { assetId: string } | undefined) => allPhotos.find(asset => asset.id === frame?.assetId);
  const keyframeSource = (value: string, end: boolean) => {
    const frame = source(value, end, 0), asset = assetFor(frame);
    return frame && asset?.kind === "IMAGE" ? { assetId: frame.assetId, atMs: 0 as const } : undefined;
  };
  const startImageSource = keyframeSource(startBase, true);
  const endImageSource = endBase ? keyframeSource(endBase, false) : assetFor(firstFrame)?.kind === "IMAGE" && firstFrame ? { assetId: firstFrame.assetId, atMs: 0 as const } : undefined;
  const continuity = assetFor(firstFrame)?.kind === "IMAGE" && firstFrame ? { assetId: firstFrame.assetId, atMs: 0 as const } : undefined;
  const imageInput = (role: "start" | "end"): CameraKeyframeInput | null => {
    const frame = role === "start" ? startImageSource : endImageSource;
    return frame && direction && !bridge ? { role, source: frame, ...(role === "end" && continuity ? { continuity } : {}), move: direction, distanceM, durationSeconds: seconds, ...(frameNotes.trim() ? { prompt: frameNotes.trim() } : {}) } : null;
  };
  // The submitted prompt is derived synchronously from the controls being shown.
  const currentPrompt = direction && !bridge ? cameraKeyframeVideoPrompt({ role: "end", source: { assetId: "selected-source", atMs: 0 },
    move: direction, distanceM, durationSeconds: seconds, prompt: frameNotes.trim() }, !!lastFrame) : prompt;
  function resetGeneratedFrames() {
    if (generatedStart) { setPhoto(startBase); setFirstMs(0); setGeneratedStart(false); }
    if (generatedEnd) { setLast(endBase); setLastMs(0); setGeneratedEnd(false); }
  }
  function chooseSource(ending: boolean, value: string) {
    if (ending) { setLast(value); setEndBase(value); setLastMs(0); setGeneratedEnd(false); setUseEndReference(!!value); }
    else {
      setPhoto(value); setStartBase(value); setFirstMs(0); setGeneratedStart(false);
      if (generatedEnd) { setLast(endBase); setLastMs(0); setGeneratedEnd(false); }
    }
  }
  function useImage(role: "start" | "end", asset: LibraryAsset) {
    receiveAssets([asset]);
    if (role === "start") {
      setPhoto(`asset:${asset.id}`); setFirstMs(0); setGeneratedStart(true);
      if (generatedEnd) { setLast(endBase); setLastMs(0); setGeneratedEnd(false); }
    } else { setLast(`asset:${asset.id}`); setLastMs(0); setUseEndReference(true); setGeneratedEnd(true); }
    setQuality("final"); requestId.current = null;
  }
  function picker(ending: boolean) {
    return <ShotSourcePicker label={ending ? "End" : "Start"} value={ending ? last : photo} frame={ending ? lastFrame : firstFrame}
      photos={allPhotos} clips={clips} allowVideos={!camera} allowNone disabled={busy}
      onChange={value => chooseSource(ending, value)} onTimeChange={atMs => (ending ? setLastMs : setFirstMs)(atMs)} />;
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (useEndReference && !bridge && !lastFrame) { setError("Choose an ending reference, or turn off ending guidance."); return; }
    if (startImageBlocked || endImageBlocked) { setError("Finish reviewing your prepared image before making the video."); return; }
    const shot = aiShotSchema.safeParse({ mode, ...(move && !bridge && !direction ? { move } : {}), first: firstFrame, last: lastFrame, anchor, style, atmosphere, energy, harmonize: Boolean(onAdd) && harmonize, polish: Boolean(onAdd) && polish,
      next: anchor && lastFrame ? next : undefined, ...(draft && anchor && reelId ? { draftReelId: reelId } : {}),
    });
    if (!shot.success) { setError(shot.error.issues[0]?.message || "Choose source frames."); return; }
    if (bridge && anchor && (!next || clips.indexOf(next) !== clips.indexOf(anchor) + 1)) {
      setError("Choose the shot immediately after the starting clip for a timeline bridge."); return;
    }
    setBusy(true);
    try {
      if (beforeGenerate && !await beforeGenerate()) throw new Error("Save your reel before generating this shot.");
      const payload = { prompt: currentPrompt, shot: shot.data, durationSeconds: seconds, ...(draftMode ? { quality: "draft" as const } : {}) };
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

  const finalCredits = (job: Job) => aiFinalCredits((job.durationSeconds ?? 4) as 4 | 8, Boolean((job.shot as AiShot).voice && (job.shot as AiShot).line), job.credits ?? AI_DRAFT_CREDITS);

  /** "Make it final" (ADR 0076): the finished draft's prompt, frames and seed on the full model; the server reads them from the draft. */
  async function makeFinal(job: Job) {
    setError(null); setBusy(true);
    try {
      const response = await fetch("/api/ai/generations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), prompt: job.prompt, finalOf: job.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not make this draft final.");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Connection interrupted. Try again to check this request."); }
    finally { setBusy(false); }
  }

  return <div className={`ai-video-panel ${styles.workspace}`}>
    <header className={styles.header}>
      <p className={styles.intro}>Choose the pictures, review your ending, then make the video.</p>
      <p className="ai-credit-count" role="status">{state ? `${state.balance.remaining} AI ${state.balance.remaining === 1 ? "credit" : "credits"} available` : "Loading your credits…"}</p>
    </header>
    {state && !state.enabled ? <p className="toast" role="status">AI video is being connected. Your credits are ready for when it opens.</p> : null}
    {recoveryError ? <p className="error small" role="status">{recoveryError}</p> : null}
    <form onSubmit={generate} className={`ai-video-form ${styles.form}`}>
      <div className={styles.layout}>
      <section className={styles.references} aria-label="Shot references">
        <h3 className={styles.sectionTitle}>Choose your frames</h3>
        <div className={styles.referencePair}>{picker(false)}{picker(true)}</div>
      </section>
      <section className={styles.direction} aria-label="Shot direction">
        <h3 className={styles.sectionTitle}>Shape the move</h3>
        <label className="field">Camera move
          <select className="text-input" value={direction ?? "custom"} disabled={busy || bridge} onChange={e => { resetGeneratedFrames(); setDirection(e.target.value === "custom" ? null : e.target.value as CameraKeyframeMove); if (e.target.value !== "custom") setMove(""); setMode("custom"); requestId.current = null; }}>
            {CAMERA_KEYFRAME_MOVES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="custom">Custom direction</option>
          </select>
        </label>
        <label className="field">Distance (about)
          <span className={styles.distance}><input className="text-input" aria-label="Approximate camera distance in metres" type="number" min={0.5} max={10} step={0.5} value={distanceM} disabled={busy || !direction || bridge}
            onChange={e => { const value = e.currentTarget.valueAsNumber; if (Number.isFinite(value)) { resetGeneratedFrames(); setDistanceM(Math.min(10, Math.max(0.5, value))); } }} />m</span>
        </label>
      <p className={styles.hint}>An approximate camera direction. Review unseen details in the image before video.</p>
      <label className="field">Length<select className="text-input" value={seconds} disabled={busy} onChange={e => { resetGeneratedFrames(); setChosenSeconds(Number(e.target.value) as 4 | 8); }}>
        <option value={4}>4 seconds</option><option value={8}>8 seconds</option>
      </select></label>
      <label className="field">Anything else? <span className="muted small">Optional</span><input className="text-input" maxLength={600} value={frameNotes} disabled={busy} placeholder="For example: dusk, with the same furniture"
        onChange={e => { resetGeneratedFrames(); setFrameNotes(e.target.value); }} /></label>
      </section>
      <section className={styles.preparation} aria-label="Review prepared images">
      <ShotKeyframePanel role="end" input={imageInput("end")} recoveryKey={recoveryKey} selectedAssetId={lastFrame?.assetId} disabled={busy || !draftLoaded}
        onAssets={receiveAssets} onBalance={receiveBalance} onBlocked={setEndImageBlocked} onUse={asset => useImage("end", asset)} onKeepSource={input => chooseSource(true, `asset:${input.source.assetId}`)} />
      <details className={styles.details}><summary>Prepare a different Start image</summary>
        <ShotKeyframePanel role="start" input={imageInput("start")} recoveryKey={recoveryKey} selectedAssetId={firstFrame?.assetId} disabled={busy || !draftLoaded}
          onAssets={receiveAssets} onBalance={receiveBalance} onBlocked={setStartImageBlocked} onUse={asset => useImage("start", asset)} onKeepSource={input => chooseSource(false, `asset:${input.source.assetId}`)} />
      </details>
      </section>
      <details className={`${styles.advanced} ${styles.details}`}><summary>More shot options</summary>
      <label className="field">Make a shot
        <select className="text-input" value={mode} disabled={busy} onChange={e => {
          const value = e.target.value as AiShotMode;
          resetGeneratedFrames(); setDirection(null); setMode(value);
          if (["gimbal", "drone"].includes(value) && allPhotos.find(a => a.id === firstFrame?.assetId)?.kind !== "IMAGE") setPhoto("");
        }}>
          {AI_SHOT_MODES.map(m => <option key={m} value={m}>{AI_SHOT_LABELS[m]}</option>)}
        </select>
      </label>
      {isCameraMove(mode) ? <p className="muted small">{AI_CAMERA_MOVE_RECIPES[mode].lens}. On a real shoot: {AI_CAMERA_MOVE_RECIPES[mode].hands} Start from a photo or a frame of the room; Veo makes the move from there.</p> : null}
      {mode === "drone" ? <p className="muted small">Choose an exterior photo with room above the roofline. A small rise is more faithful than a wide invented aerial view.</p> : null}
      {mode === "orbit" ? <p className="muted small">Choose an exterior with space around the building. An ending view from another angle helps guide the orbit; unseen sides are interpreted by AI.</p> : null}
      {mode === "fly-through" ? <p className="muted small">Use a wide view with visible openings. Add a landing frame from the next room to guide the flight.</p> : null}
      {mode === "day-night" ? <p className="muted small">A fixed view works best: daylight, moving shadows, sunset and glowing windows. An optional night reference guides the finish.</p> : null}
      {mode === "construction" ? <p className="muted small">Use before and after views from a similar angle. Creates an AI construction concept between them; the full build stays in the edit, so 8 seconds is recommended.</p> : null}
      {!bridge ? <label className="field">Camera move
        <select className="text-input" value={move} disabled={busy} data-testid="ai-move" onChange={e => {
          const value = e.target.value as MoveId | "";
          resetGeneratedFrames(); setDirection(null); setMove(value); setChosenSeconds(null); requestId.current = null;
          // The move's words become the prompt, to edit; clearing the move puts the usual line back.
          setPrompt(value ? movePrompt(value) : DEFAULT_PROMPT);
        }}>
          <option value="">None · the shot type's own movement</option>
          {MOVE_GROUPS.map(group => <optgroup key={group} label={MOVE_GROUP_LABELS[group]}>
            {MOVES.filter(m => m.group === group).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </optgroup>)}
        </select>
        {move ? <span className="muted small">{moveById(move).ai.lens}. On a real shoot: {moveById(move).ai.hands}{moveById(move).real ? " Also available on footage you already have: tap Motion on a shot." : ""}</span> : null}
      </label> : null}
      <label className="field">Quality
        <select className="text-input" value={draftMode ? "draft" : "final"} disabled={busy} data-testid="ai-quality" onChange={e => { setQuality(e.target.value as "draft" | "final"); requestId.current = null; }}>
          <option value="final">Full take · {aiClipCredits(seconds)} {aiClipCredits(seconds) === 1 ? "credit" : "credits"} · 1080p</option>
          <option value="draft" disabled={Boolean(noDraft)}>Draft preview · {AI_DRAFT_CREDITS} credit · 720p, silent</option>
        </select>
        <span className="muted small">{noDraft ?? (seconds === 8
          ? `A draft shows the move first for ${AI_DRAFT_CREDITS} credit instead of ${aiClipCredits(8)}. Make it final then costs the rest of the full price, so a draft you keep adds nothing.`
          : "A 4-second draft costs the same credit as the full take, so it only saves time. Use drafts on 8-second shots.")}</span>
      </label>
      <label className="field">Cinematic style
        <select className="text-input" value={style} disabled={busy} onChange={e => setStyle(e.target.value as AiShotStyle)}>
          {AI_SHOT_STYLES.map(value => <option key={value} value={value}>{AI_SHOT_STYLE_LABELS[value]}</option>)}
        </select>
      </label>
      <label className="field">Light and weather
        <select className="text-input" value={atmosphere} disabled={busy || mode === "day-night"} onChange={e => setAtmosphere(e.target.value as AiShotAtmosphere)}>
          {AI_SHOT_ATMOSPHERES.map(value => <option key={value} value={value}>{AI_SHOT_ATMOSPHERE_LABELS[value]}</option>)}
        </select>
        {mode === "day-night" ? <span className="muted small">Light progresses from day into night.</span> : null}
      </label>
      <label className="field">Energy
        <select className="text-input" value={energy} disabled={busy} onChange={e => setEnergy(e.target.value as "subtle" | "bold")}>
          <option value="subtle">Controlled and elegant</option><option value="bold">Bold and over the top</option>
        </select>
      </label>
      {onAdd && style !== "source" ? <label className="field"><span><input type="checkbox" checked={harmonize} disabled={busy} onChange={e => setHarmonize(e.target.checked)} /> Carry a matching colour grade through the real footage</span>
        <span className="muted small">Editable in Look. Weather and relighting apply to the AI shot.</span></label> : null}
      {onAdd ? <label className="field"><span><input type="checkbox" checked={polish} disabled={busy} onChange={e => setPolish(e.target.checked)} /> Finish the promo with luxury type and camera accents</span>
        <span className="muted small">Pairs editorial and clean fonts, soft lens edges and one snap zoom. Your words, footage and timing stay editable.</span></label> : null}
      {style === "auto" ? <p className="muted small">Suggested direction: {AI_SHOT_STYLE_LABELS[aiShotStyle({ mode, anchor, style })]}. AI handles lighting, depth and atmosphere within this look.</p> : null}
      <label className="field">Describe the shot
        <textarea className="text-input" rows={4} minLength={10} maxLength={2000} required value={currentPrompt}
          placeholder="A slow, smooth camera push into a bright living room, morning light through the windows. Keep the layout and furniture unchanged."
          disabled={busy} onChange={e => { resetGeneratedFrames(); setDirection(null); setPrompt(e.target.value); requestId.current = null; }} />
      </label>
      {anchor && reelId ? <label className="field"><span><input type="checkbox" checked={draft} disabled={busy} onChange={e => setDraft(e.target.checked)} /> Automatically make a separate promo draft</span>
        <span className="muted small">Completes while you are away. Keeps your original reel, music and captions. Changed boundaries wait for review.</span></label> : null}
      <p className="muted small">References use the original frame with a centre crop to portrait. Review joins, especially with zoom, colour effects or letterboxing.</p>
      </details>
      <footer className={styles.finish}>
      <p className="muted small">New images and videos use credits. Review generated property details before publishing.</p>
      {error ? <p className="error small" role="alert">{error}</p> : null}
      <button className="btn btn-block" type="submit" disabled={busy || !draftLoaded || startImageBlocked || endImageBlocked || !state?.enabled || state.balance.remaining < credits || state.jobs.filter(active).length >= AI_QUEUE_LIMIT || (!firstFrame && direction !== null) || (!!firstFrame && !assetFor(firstFrame)) || (!!lastFrame && !assetFor(lastFrame)) || ((bridge || useEndReference) && !lastFrame) || (mode !== "custom" && !firstFrame)}>
        {busy ? "Starting…" : `${draftMode ? "Draft" : "Generate video ·"} ${seconds}-second clip · ${credits} ${credits === 1 ? "credit" : "credits"}`}
      </button>
      <p className="muted small"><Link href="/account">Plans and more credits</Link></p>
      </footer>
      </div>
    </form>
    <div className="ai-video-results" aria-live="polite">
      {state?.jobs.map(job => <article className="ai-video-result" key={job.id}>
        <p className="small">{tierOf(job) === "draft" ? "Draft · " : tierOf(job) === "final" && (job.shot as { finalOf?: string }).finalOf ? "Final · " : ""}{aiShotSchema.safeParse(job.shot).success ? `${(job.shot as AiShot).move ? `${moveById((job.shot as AiShot).move!).label} · ` : ""}${AI_SHOT_LABELS[(job.shot as AiShot).mode]} · ${AI_SHOT_STYLE_LABELS[aiShotStyle(job.shot as AiShot)]}` : job.prompt}</p>
        {active(job) ? <p className="muted small" role="status">{job.status === "QUEUED" ? queueLabel(job.queue ?? null, at => at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) : job.status === "SUBMITTING" ? "Composing her into the frame and checking her face…" : "Generating your shot…"} You can leave and return later.</p> : null}
        {job.status === "FAILED" || job.status === "UNRESOLVED" ? <p className="error small">{job.error}</p> : null}
        {job.take?.wrongWords ? <p className="error small" role="alert">Wrong words: she said “{job.take.heard || "nothing we could hear"}”, not “{job.take.line}”.</p> : null}
        {job.asset && job.take && !job.take.wrongWords ? <p className="muted small">Trimmed to her line: {(job.take.startMs / 1000).toFixed(2)}–{(job.take.endMs / 1000).toFixed(2)} s{job.faceHeightPx ? ` · face ${job.faceHeightPx} px (${job.framing ?? "medium"})` : ""}</p> : null}
        {job.asset ? <>
          <video src={job.asset.url} controls playsInline preload="metadata" aria-label="Generated AI clip" />
          <p className="muted small">AI-generated · saved in your media library{tierOf(job) === "draft" ? " · 720p preview, silent" : ""}</p>
          {tierOf(job) === "draft" && !job.finalId && job.durationSeconds ? <button type="button" className="btn btn-block" data-testid="make-final" disabled={busy || !state?.enabled}
            onClick={() => makeFinal(job)}>Make it final · {finalCredits(job)} {finalCredits(job) === 1 ? "credit" : "credits"}</button> : null}
          {tierOf(job) === "draft" && job.finalId ? <p className="muted small">Made final.</p> : null}
          {job.draftId ? <Link className="btn btn-block" href={`/reels/${job.draftId}`}>Review blended promo draft</Link> : null}
          {job.asset && (job.shot as AiShot | null)?.draftReelId && !job.draftId ? <p className="muted small">The source boundary changed. Your clip is ready in the media library.</p> : null}
          {onAdd ? <button type="button" className="btn btn-block" onClick={() => { const recipe = aiShotSchema.safeParse(job.shot); onAdd(job.asset!, recipe.success ? recipe.data : undefined); }}>{(job.shot as AiShot | null)?.anchor ? "Place at source cut / replace still" : "Add to reel"}</button> :
            <Link className="btn btn-quiet btn-block" href="/">Open your reels to use this clip</Link>}
        </> : null}
      </article>)}
    </div>
  </div>;
}
