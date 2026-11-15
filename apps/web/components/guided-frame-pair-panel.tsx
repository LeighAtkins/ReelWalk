"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CameraKeyframeInput, CameraKeyframeJob, ShotFramePair } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { framePairMatches, newFramePair, savedFramePairInput } from "./guided-frame-pair";
import { ShotGenerationProgress } from "./shot-generation-progress";
import { ModalDialog } from "./sheet";
import styles from "./guided-frame-pair.module.css";

type Job = CameraKeyframeJob<LibraryAsset>;
type History = { enabled: boolean; reason: string | null; balanceRemaining: number; jobs: Job[] };
const active = (job?: Job) => !!job && ["QUEUED", "SUBMITTING", "UNKNOWN"].includes(job.status);
const finished = (job?: Job) => !!job && ["CANDIDATE", "USED"].includes(job.status);

export function GuidedFramePairPanel({ pair, input, disabled, reviewed, onSave, onReview, onAssets, onBalance, beforePrepare, controlsTarget }: {
  pair?: ShotFramePair; input: CameraKeyframeInput | null; disabled: boolean; reviewed: boolean;
  onSave(pair: ShotFramePair, expectedId?: string): Promise<boolean>;
  onReview(start: LibraryAsset, end: LibraryAsset, pair: ShotFramePair): void;
  onAssets(assets: LibraryAsset[]): void; onBalance(remaining: number): void; beforePrepare?(): Promise<boolean>;
  controlsTarget?: HTMLElement | null;
}) {
  const [jobs, setJobs] = useState<{ start?: Job; end?: Job }>({});
  const [admission, setAdmission] = useState<History>();
  const [historyReady, setHistoryReady] = useState(false), [imageAttempt, setImageAttempt] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState<string | null>(null), [lastCheckedAt, setLastCheckedAt] = useState<string>();
  const [loaded, setLoaded] = useState<Record<string, boolean>>({}), [previewFailure, setPreviewFailure] = useState<string>();
  const [enlarged, setEnlarged] = useState<"start" | "end" | null>(null);
  const live = useRef(true), lock = useRef(false), current = useRef({ pair, input, onSave, onAssets, onBalance });
  current.current = { pair, input, onSave, onAssets, onBalance };
  const matches = framePairMatches(pair, input);
  const bothReady = finished(jobs.start) && finished(jobs.end);
  const imageKey = `${pair?.id}:${jobs.start?.candidateUrl}:${jobs.end?.candidateUrl}:${imageAttempt}`;
  const previewError = previewFailure === imageKey;
  const visibleKey = useRef(imageKey); visibleKey.current = imageKey;
  const previewsReady = !previewError && loaded[`${imageKey}:start`] && loaded[`${imageKey}:end`];

  async function history(requestId?: string, recover = false, signal?: AbortSignal): Promise<History> {
    const query = new URLSearchParams({ ...(requestId ? { requestId } : {}), ...(recover ? { recover: "1" } : {}) });
    const response = await fetch(`/api/ai/keyframes?${query}`, { cache: "no-store", signal });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || "Could not check frame preparation.");
    return value;
  }
  async function refresh(recover = false, signal?: AbortSignal) {
    return readHistory(recover, signal);
  }
  async function readHistory(recover = false, signal?: AbortSignal) {
    const saved = current.current.pair;
    const [startState, endState] = await Promise.all([history(saved?.startRequestId, recover, signal), saved ? history(saved.endRequestId, recover, signal) : Promise.resolve(null)]);
    if (!live.current || signal?.aborted || saved?.id !== current.current.pair?.id) return;
    const start = saved ? startState.jobs.find(job => job.requestId === saved.startRequestId) : undefined;
    const end = saved ? endState?.jobs.find(job => job.requestId === saved.endRequestId) : undefined;
    setJobs({ start, end }); setAdmission(endState ?? startState); setHistoryReady(true); setLastCheckedAt(new Date().toISOString()); setConnectionError(null);
    current.current.onBalance((endState ?? startState).balanceRemaining);
    current.current.onAssets([start?.asset, end?.asset].filter((asset): asset is LibraryAsset => !!asset));
    const latest = current.current.pair;
    if (latest && (start && start.id !== latest.startJobId || end && end.id !== latest.endJobId || start?.asset && start.asset.id !== latest.startAssetId || end?.asset && end.asset.id !== latest.endAssetId)) {
      const receipt = { ...latest, ...(start ? { startJobId: start.id } : {}), ...(end ? { endJobId: end.id } : {}), ...(start?.asset ? { startAssetId: start.asset.id } : {}), ...(end?.asset ? { endAssetId: end.asset.id } : {}) };
      if (!await current.current.onSave(receipt, latest.id)) setError("Your results are saved on the server. Reopen this shot if its saved status cannot update.");
    }
    return { start, end };
  }
  useEffect(() => {
    live.current = true; setHistoryReady(false); setJobs({}); setLoaded({}); setPreviewFailure(undefined); setError("");
    const abort = new AbortController();
    void refresh(false, abort.signal).catch(() => { if (!abort.signal.aborted) setConnectionError("Your saved requests are retained. Check your connection and refresh status."); });
    return () => { live.current = false; abort.abort(); };
  }, [pair?.id]);
  useEffect(() => {
    if (!pair || bothReady || jobs.start?.status === "FAILED" || jobs.end?.status === "FAILED") return;
    const abort = new AbortController();
    const timer = setInterval(() => { void refresh(false, abort.signal).catch(() => { if (!abort.signal.aborted) setConnectionError("Progress could not refresh. No new generation will be submitted."); }); }, 5000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [pair?.id, bothReady, jobs.start?.status, jobs.end?.status]);

  async function post(value: object) {
    const response = await fetch("/api/ai/keyframes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "Preparation needs checking. Your saved request is retained.");
    return result;
  }
  async function prepare(retry = false) {
    if (disabled || lock.current || !input || !historyReady || !admission?.enabled || !retry && (admission.balanceRemaining < 2 || active(jobs.start) || active(jobs.end))) return;
    lock.current = true; setBusy(true); setError("");
    const original = pair?.id;
    try {
      if (beforePrepare && !await beforePrepare()) throw Error("Save this shot before preparing its frames.");
      const saved = retry && pair ? pair : newFramePair(input);
      if (!framePairMatches(saved, input)) throw Error("Restore this pair's reference and settings before continuing it.");
      if (!await onSave(saved, original)) throw Error("Save the frame request before preparing images.");
      if (retry) {
        const latest = await refresh(true);
        if (!latest) throw Error("The saved preparation could not be checked. Refresh its status before continuing.");
        if (latest?.end || latest?.start && !finished(latest.start)) return;
        if (latest?.start) await post({ action: "continue-pair", jobId: latest.start.id });
        else await post({ action: "generate", requestId: saved.startRequestId, ...savedFramePairInput(saved) });
      } else {
        await post({ action: "generate", requestId: saved.startRequestId, ...savedFramePairInput(saved) });
      }
      await refresh();
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Your requests are saved. Check status before trying again."); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  async function review() {
    if (!pair || !matches || !bothReady || !previewsReady || lock.current || disabled) return;
    lock.current = true; setBusy(true); setError("");
    const original = pair.id;
    try {
      const [start, end] = await Promise.all([post({ action: "use", jobId: jobs.start!.id }), post({ action: "use", jobId: jobs.end!.id })]);
      if (!live.current || current.current.pair?.id !== original || !framePairMatches(current.current.pair, current.current.input)) return;
      const selected = { ...current.current.pair, startAssetId: start.asset.id, endAssetId: end.asset.id };
      if (!await onSave(selected, original)) throw Error("Save this shot before using the prepared frames.");
      onAssets([start.asset, end.asset]); onReview(start.asset, end.asset, selected);
      await refresh();
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "The prepared frames are still saved. Check status to recover them."); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  const stage = bothReady ? "review" : finished(jobs.start) ? "end" : "start";
  const currentJob = stage === "end" ? jobs.end : jobs.start;
  const waitingForEnd = historyReady && finished(jobs.start) && !jobs.end;
  const status = bothReady ? "CANDIDATE" : currentJob?.status ?? (waitingForEnd ? "WAITING_END" : busy ? "PREPARING" : pair ? "CHECKING" : undefined);
  const progress = pair || connectionError ? <ShotGenerationProgress stage={stage} status={status} requestedAt={waitingForEnd ? undefined : currentJob?.createdAt ?? pair?.requestedAt} lastCheckedAt={lastCheckedAt} connectionError={connectionError} /> : null;
  const controls = <div className={styles.controls}>
      {!pair ? <button className="btn btn-block" type="button" disabled={disabled || busy || !input || !admission?.enabled || admission.balanceRemaining < 2} onClick={() => void prepare()}>Prepare Start and End · 2 credits</button> : null}
    </div>;
  return <section className={styles.pair} aria-label="Prepare both frames">
    {controlsTarget ? createPortal(progress, controlsTarget) : progress}
    {!pair && connectionError ? <button className="btn btn-quiet" type="button" onClick={() => void refresh(false).catch(() => setConnectionError("Could not check preparation. Check your connection and retry status."))}>Retry status check</button> : null}
    {controls}
    {jobs.start?.error || jobs.end?.error || jobs.start?.continuationError ? <p className="error" role="alert">{jobs.end?.error || jobs.start?.continuationError || jobs.start?.error}</p> : null}
    {pair && !bothReady ? <button className="btn btn-quiet" type="button" disabled={busy} onClick={() => void refresh(true).catch(() => setConnectionError("Could not check the saved pair."))}>Check saved preparation</button> : null}
    {pair && matches && !jobs.end && !active(jobs.start) && jobs.start?.status !== "FAILED" ? <button className="btn btn-quiet" type="button" disabled={disabled || busy || !historyReady} onClick={() => void prepare(true)}>Continue saved preparation</button> : null}
    <p className={styles.hint}>We prepare both images from your reference, then use Start to keep End consistent. Review the pair before making your video.</p>
    <div className={styles.images}>
      {(["start", "end"] as const).map(role => <figure key={role}>
        {jobs[role]?.candidateUrl ? <img key={`${imageKey}:${role}`} src={jobs[role]!.candidateUrl!} alt={`Prepared ${role === "start" ? "Start" : "End"} frame`} onLoad={() => { if (visibleKey.current === imageKey) setLoaded(old => ({ ...old, [`${imageKey}:${role}`]: true })); }} onError={() => { if (visibleKey.current === imageKey) setPreviewFailure(imageKey); }} /> : <div className={styles.placeholder}>{role === "start" ? "Start frame" : "End frame"}</div>}
        <figcaption>{role === "start" ? "Start frame" : "End frame"}</figcaption>
        {jobs[role]?.candidateUrl ? <button type="button" className="btn btn-quiet" onClick={() => setEnlarged(role)}>Inspect {role === "start" ? "Start" : "End"}</button> : null}
      </figure>)}
    </div>
    {previewError ? <p role="alert">A preview could not load. The result is saved. <button type="button" onClick={() => { setPreviewFailure(undefined); setLoaded({}); setImageAttempt(value => value + 1); void refresh(true).catch(() => setConnectionError("Could not refresh previews.")); }}>Reload previews</button></p> : null}
    {pair && !matches ? <p role="status">The reference or camera settings changed. This pair is saved; prepare a new pair for the new settings.</p> : null}
    {bothReady && matches ? <button className="btn btn-block" type="button" disabled={disabled || busy || !previewsReady || reviewed} onClick={() => void review()}>{reviewed ? "Frames selected for video" : "Use these frames"}</button> : null}
    {pair && historyReady && (bothReady || jobs.start?.status === "FAILED" || jobs.end?.status === "FAILED" || !matches && finished(jobs.start) && !jobs.end && !!jobs.start?.continuationError) ? <button className="btn btn-quiet" type="button" disabled={disabled || busy || !input || !admission?.enabled || admission.balanceRemaining < 2} onClick={() => void prepare()}>Prepare another pair · 2 credits</button> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    {admission && !admission.enabled ? <p role="status">{admission.reason || "Image preparation is paused."}</p> : null}
    {enlarged && jobs[enlarged]?.candidateUrl ? <ModalDialog className={styles.inspection} aria-label={`Inspect prepared ${enlarged} frame`} onRequestClose={() => setEnlarged(null)}>
      <button type="button" className="btn" onClick={() => setEnlarged(null)}>Close image</button>
      <img src={jobs[enlarged]!.candidateUrl!} alt={`Prepared ${enlarged} frame, enlarged`} />
    </ModalDialog> : null}
  </section>;
}
