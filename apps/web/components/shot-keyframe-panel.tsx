"use client";

import { useEffect, useRef, useState } from "react";
import type { CameraKeyframeInput, CameraKeyframeJob } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import styles from "./shot-workspace.module.css";

type Job = CameraKeyframeJob<LibraryAsset>;
type State = { enabled: boolean; reason: string | null; balanceRemaining: number; jobs: Job[] };
type SavedRequest = { requestId: string; inputKey: string; input?: CameraKeyframeInput };
const running = (job: Job) => ["QUEUED", "SUBMITTING", "UNKNOWN"].includes(job.status);

/** Both the pending request and candidate approval belong to these exact visible choices. */
export function keyframeInputKey(input: CameraKeyframeInput): string {
  return JSON.stringify([input.role, input.source.assetId, input.source.atMs, input.continuity?.assetId ?? null,
    input.continuity?.atMs ?? null, input.move, input.distanceM, input.durationSeconds, input.prompt?.trim() || null, ...(input.cinematography ? [input.cinematography] : []), ...(input.furnitureStage ? [input.furnitureStage] : [])]);
}

export function keyframeMatches(job: Pick<CameraKeyframeJob, "input">, input: CameraKeyframeInput | null): boolean {
  return !!input && keyframeInputKey(job.input) === keyframeInputKey(input);
}

export function savedKeyframeInput(saved: SavedRequest, current: CameraKeyframeInput | null): CameraKeyframeInput | null {
  const frozen = saved.input ?? current;
  return frozen && keyframeInputKey(frozen) === saved.inputKey ? frozen : null;
}

export function ShotKeyframePanel({ role, input, recoveryKey, durableRecovery, onRecovery, selectedAssetId, variant, disabled = false, onUse, onKeepSource, onAssets, onBalance, onBlocked }: {
  durableRecovery?: Record<string, string>; onRecovery?(key: string, value: string): Promise<boolean>;
  role: "start" | "end"; input: CameraKeyframeInput | null; recoveryKey: string; disabled?: boolean;
  selectedAssetId?: string; variant?: "furniture";
  onUse(asset: LibraryAsset, input: CameraKeyframeInput): void;
  onKeepSource(input: CameraKeyframeInput): void;
  onAssets(assets: LibraryAsset[]): void; onBalance(remaining: number): void; onBlocked(blocked: boolean): void;
}) {
  const concept = variant === "furniture";
  const title = concept ? "Furniture concept" : role === "start" ? "Start" : "End";
  const [manualReview, setManualReview] = useState<string>();
  const [state, setState] = useState<State>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [historyReady, setHistoryReady] = useState(false), [selected, setSelected] = useState<string>();
  const [dismissed, setDismissed] = useState<string>();
  const [pending, setPending] = useState<SavedRequest>();
  const [imageAttempt, setImageAttempt] = useState(0), [loaded, setLoaded] = useState<Record<string, boolean>>({}), [failed, setFailed] = useState<string | null>(null);
  const mounted = useRef(true), locked = useRef(false), currentInput = useRef(input), currentProps = useRef({ onAssets, onUse, onBalance });
  currentInput.current = input; currentProps.current = { onAssets, onUse, onBalance };
  const key = input ? keyframeInputKey(input) : "";
  const storageKey = `shot-keyframe-request:${recoveryKey}:${role}`;
  const choiceKey = `shot-keyframe-choice:${recoveryKey}:${role}`;
  const recoveryRef = useRef(durableRecovery); recoveryRef.current = durableRecovery;
  const read = (key: string, storage: Storage) => onRecovery ? recoveryRef.current?.[key] || null : storage.getItem(key);
  const write = async (key: string, value: string, storage: Storage) => {
    if (onRecovery) { if (!await onRecovery(key, value)) throw Error("Save the card before preparing an image."); }
    else storage.setItem(key, value);
  };
  const clear = async (key: string, storage: Storage) => {
    if (onRecovery) { if (!await onRecovery(key, "")) throw Error("Could not save recovered image status."); }
    else storage.removeItem(key);
  };
  const currentScope = useRef(storageKey); currentScope.current = storageKey;
  const matching = state?.jobs.filter(job => keyframeMatches(job, input)) ?? [];
  const job = matching.find(item => item.id === selected);
  const blockingJob = concept ? state?.jobs.find(item => !!item.input.furnitureStage && running(item)) ?? job : job;
  const isSelected = job?.status === "USED" && !!job.asset && job.asset.id === selectedAssetId;
  const candidateKey = job?.candidateUrl ? `${job.id}:${job.candidateUrl}:${job.sourceUrl}:${imageAttempt}` : "";
  const visibleKey = useRef(candidateKey); visibleKey.current = candidateKey;
  const manualApproved = !concept || manualReview === candidateKey;
  const ready = !!candidateKey && !!loaded[`${candidateKey}:source`] && !!loaded[`${candidateKey}:candidate`] && failed !== candidateKey;
  const unresolved = !!pending;
  const blocked = busy || unresolved || !!blockingJob && running(blockingJob) || !!job && (running(job) || job.status === "CANDIDATE" && dismissed !== job.id);

  async function refresh(signal?: AbortSignal, recover = false) {
    const query = new URLSearchParams(recover ? { recover: "1" } : {});
    const savedPending = read(storageKey, sessionStorage), savedChoice = read(choiceKey, localStorage);
    if (savedPending) query.set("requestId", (JSON.parse(savedPending) as SavedRequest).requestId);
    if (savedChoice) query.set("jobId", (JSON.parse(savedChoice) as { id: string }).id);
    const response = await fetch(`/api/ai/keyframes?${query}`, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load your saved frames.");
    if (!mounted.current || signal?.aborted || currentScope.current !== storageKey) return;
    try {
      const choice = read(choiceKey, localStorage);
      if (choice) {
        const parsed = JSON.parse(choice) as { id?: unknown; keepSource?: unknown };
        if (typeof parsed?.id !== "string") throw new Error("The saved frame choice could not be read.");
        setSelected(parsed.id); setDismissed(parsed.keepSource === true ? parsed.id : undefined);
      }
      const saved = read(storageKey, sessionStorage);
      if (saved) {
        const recovered = JSON.parse(saved) as SavedRequest;
        if (typeof recovered?.requestId !== "string" || typeof recovered?.inputKey !== "string") throw new Error("The saved image request could not be read. Keep this page open and check status.");
        const found = data.jobs.find((item: Job) => item.requestId === recovered.requestId);
        if (found) {
          await write(choiceKey, JSON.stringify({ id: found.id }), localStorage);
          await clear(storageKey, sessionStorage); setPending(undefined); setSelected(found.id); setDismissed(undefined);
        }
        else setPending(recovered);
      }
    } catch (e) { setHistoryReady(false); throw e; }
    setState(data); setHistoryReady(true);
    currentProps.current.onBalance(data.balanceRemaining);
    currentProps.current.onAssets(data.jobs.flatMap((item: Job) => item.asset ? [item.asset] : []));
  }
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    setHistoryReady(false); setState(undefined); setSelected(undefined); setPending(undefined); setDismissed(undefined);
    void refresh(abort.signal).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => { mounted.current = false; abort.abort(); };
  }, [storageKey]);
  useEffect(() => { setFailed(null); setLoaded({}); }, [key]);
  useEffect(() => { onBlocked(blocked); }, [blocked, onBlocked]);
  useEffect(() => {
    if (!state?.jobs.some(running) && !pending) return;
    const abort = new AbortController();
    const timer = setInterval(() => { void refresh(abort.signal).catch(() => { if (!abort.signal.aborted) setError("Progress could not refresh. Your request is saved; it will not be submitted again."); }); }, 5000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [state?.jobs, pending, storageKey]);

  async function generate(retry = false) {
    const frozen = retry && pending ? savedKeyframeInput(pending, input) : input;
    if (!frozen || locked.current || disabled || !historyReady || (!retry && (!state?.enabled || state.balanceRemaining < 1 || unresolved || blockingJob && running(blockingJob)))) return;
    locked.current = true; setBusy(true); setError(""); setDismissed(undefined); setFailed(null); setLoaded({});
    const inputKey = keyframeInputKey(frozen), requestId = retry && pending ? pending.requestId : crypto.randomUUID();
    let sent = false;
    try {
      // A failed storage write stops before a paid request, rather than losing its recovery identity.
      await write(storageKey, JSON.stringify({ requestId, inputKey, input: frozen }), sessionStorage);
      setPending({ requestId, inputKey, input: frozen });
      sent = true;
      const response = await fetch("/api/ai/keyframes", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", requestId, ...frozen }) });
      if (response.status >= 400 && response.status < 500) { await clear(storageKey, sessionStorage); setPending(undefined); }
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Could not prepare this frame. Check status before trying again.");
      }
      await write(choiceKey, JSON.stringify({ id: result.job.id }), localStorage);
      await clear(storageKey, sessionStorage);
      if (mounted.current && currentScope.current === storageKey) { setPending(undefined); setSelected(result.job.id); setState(old => old ? { ...old, balanceRemaining: Math.max(0, old.balanceRemaining - 1), jobs: [result.job, ...old.jobs.filter(j => j.id !== result.job.id)] } : old); }
      await refresh();
    } catch (e) {
      if (!sent) setPending(undefined);
      if (mounted.current) setError(e instanceof Error ? e.message : "The request could not be checked. Refresh status before making another image.");
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  }

  async function use() {
    if (!job || !input || !ready || !manualApproved || !keyframeMatches(job, input) || locked.current || disabled) return;
    const originalKey = keyframeInputKey(input), candidateId = job.id;
    locked.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/ai/keyframes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "use", jobId: candidateId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not use this frame.");
      if (mounted.current && currentScope.current === storageKey && currentInput.current && keyframeInputKey(currentInput.current) === originalKey) currentProps.current.onUse(result.asset, job.input);
      await refresh();
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "This frame is still saved. Check status to recover it."); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }

  async function retryPreview() {
    setFailed(null); setLoaded({}); setImageAttempt(n => n + 1);
    try { await refresh(); } catch { setError("Could not refresh the saved image links. No new image was generated."); }
  }
  const image = (kind: "source" | "candidate", url: string) => <img key={`${candidateKey}:${kind}`} src={url} alt={kind === "source" ? "Original portrait source" : `Generated ${title}`}
    className={styles.keyframeImage}
    onLoad={() => { if (visibleKey.current === candidateKey) setLoaded(old => ({ ...old, [`${candidateKey}:${kind}`]: true })); }}
    onError={() => { if (visibleKey.current === candidateKey) { setFailed(candidateKey); setLoaded({}); } }} />;

  return <section aria-label={concept ? "Prepare furniture concept" : `Prepare ${role} image`} className={styles.keyframe}>
    <p className="muted small">{concept ? "Generate one disclosed furniture concept. Review architectural details inside the edit area before using it. The original outside the rectangle is restored; this is not a current-property photograph." : role === "end" ? "Make the ending image first. Review it before spending video credits." : "Optionally prepare a new starting view from this photo."}</p>
    {!input ? <p className="muted small">Choose a photo to prepare this frame.</p> : null}
    {isSelected && !concept ? <p role="status" className={styles.selectedStatus}>Selected as {role === "start" ? "Start" : "End"}.</p> : job?.candidateUrl && job.sourceUrl ? <>
      <div className={styles.comparison}>
        <figure>{image("source", job.sourceUrl)}<figcaption className={styles.caption}>Original</figcaption></figure>
        <figure>{image("candidate", job.candidateUrl)}<figcaption className={styles.caption}>{concept ? "Furniture concept ? AI furnished" : role === "start" ? "New Start" : "New End"}</figcaption></figure>
      </div>
      {failed === candidateKey ? <p className="error small" role="alert">The image preview could not load. Your image is saved. <button type="button" disabled={busy} onClick={retryPreview}>Retry preview</button></p> : null}
      {concept ? <label><input type="checkbox" checked={manualReview === candidateKey} disabled={disabled || busy || !ready} onChange={event => setManualReview(event.target.checked ? candidateKey : undefined)} /> I compared walls, openings, flooring, built-ins and lighting inside the furnishing area. This is my manual concept review.</label> : null}
      <button className="btn btn-block" type="button" disabled={disabled || busy || !ready || !manualApproved} onClick={use}>Use this {concept ? "concept as Start" : role === "start" ? "Start" : "End"}</button>
      {job.status === "CANDIDATE" ? <button className="btn btn-quiet" type="button" disabled={disabled || busy} onClick={async () => { if (input) {
        try { await write(choiceKey, JSON.stringify({ id: job.id, keepSource: true }), localStorage); setDismissed(job.id); onKeepSource(input); }
        catch { setError("This browser could not save the choice. Your generated image is still saved."); }
      } }}>Use original photo instead</button> : null}
    </> : null}
    {job && running(job) ? <p role="status" className="muted small">{job.status === "UNKNOWN" ? "The provider outcome needs checking. The request will not be submitted again." : "Making your image. You can leave and reopen this shot."}</p> : null}
    {job?.error ? <p className="error small">{job.error}</p> : null}
    {pending ? <p role="status" className="muted small">Your image request is saved. Check its status or retry the same request.
      <button type="button" className="btn btn-quiet" disabled={disabled || busy || !historyReady || !savedKeyframeInput(pending, input)} onClick={() => generate(true)}>Retry saved request</button>
    </p> : null}
    {state && !state.enabled ? <p className="muted small">{state.reason || "Image preparation is not enabled on this installation yet."}</p> : null}
    <button className="btn btn-quiet" type="button" disabled={disabled || busy || !input || !historyReady || !state?.enabled || state.balanceRemaining < 1 || unresolved || !!blockingJob && running(blockingJob)} onClick={() => generate()}>
      {busy ? "Working…" : `${job?.candidateUrl ? "Try another" : `Generate ${concept ? "furniture concept" : role === "start" ? "Start" : "End"}${concept ? "" : " image"}`} · 1 credit`}
    </button>
    {job || error || unresolved ? <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => refresh(undefined, true).then(() => setError("")).catch(e => setError(e.message))}>Refresh status</button> : null}
    {matching.length ? <details className={styles.details}><summary>Saved images</summary>{matching.map(item => <button key={item.id} type="button" disabled={busy} onClick={async () => {
      try { await write(choiceKey, JSON.stringify({ id: item.id }), localStorage); setSelected(item.id); setDismissed(undefined); setLoaded({}); setFailed(null); }
      catch { setError("This browser could not save the frame choice."); }
    }}>Image {matching.length - matching.indexOf(item)} · {item.status.toLowerCase()}</button>)}</details> : null}
    {error ? <p className="error small" role="alert">{error}</p> : null}
  </section>;
}
