"use client";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CameraKeyframeInput, CameraKeyframeJob, ShotFramePair } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { activeEndRequestId, framePairIntent, framePairMatches, newEndRevision, newFramePair, savedEndRevisionInput, savedFramePairInput } from "./guided-frame-pair";
import { ModalDialog } from "./sheet";
import styles from "./guided-frame-pair.module.css";

type Job = CameraKeyframeJob<LibraryAsset>;
type History = { enabled: boolean; reason: string | null; balanceRemaining: number; jobs: Job[] };
const active = (job?: Job) => !!job && ["QUEUED", "SUBMITTING", "UNKNOWN"].includes(job.status);
const finished = (job?: Job) => !!job && ["CANDIDATE", "USED"].includes(job.status);

export function sameFrameOperation(a?: ShotFramePair, b?: ShotFramePair): boolean {
  return a?.id === b?.id && (!a || !!b && activeEndRequestId(a) === activeEndRequestId(b));
}
export function canReviseEnd(pair: ShotFramePair | undefined, historyReady: boolean, start?: Job, end?: Job): boolean {
  return !!pair && historyReady && finished(start) && !!start?.asset && !active(end)
    && (!!end && (finished(end) || end.status === "FAILED") || !pair.endRevision && !end && !!start?.continuationError);
}
export function frameCardLabel(job: Job | undefined, waiting = false): string {
  if (job?.status === "QUEUED") return "Queued";
  if (job?.status === "SUBMITTING") return "Creating image";
  if (job?.status === "UNKNOWN") return "Checking saved result";
  if (job?.status === "FAILED") return "Needs attention";
  return finished(job) ? "Ready" : waiting ? "Waiting for Start" : "Not started";
}
export function framePairReceipt(pair: ShotFramePair, start?: Job, end?: Job): ShotFramePair {
  return { ...pair, ...(start ? { startJobId: start.id } : {}), ...(start?.asset ? { startAssetId: start.asset.id } : {}),
    ...(pair.endRevision ? { endRevision: { ...pair.endRevision, ...(end ? { jobId: end.id } : {}), ...(end?.asset ? { assetId: end.asset.id } : {}) } }
      : { ...(end ? { endJobId: end.id } : {}), ...(end?.asset ? { endAssetId: end.asset.id } : {}) }) };
}

export function GuidedFramePairPanel({ pair, input, disabled, reviewed, onSave, onReview, onAssets, onBalance, beforePrepare, endControls, inputValid = true }: {
  pair?: ShotFramePair; input: CameraKeyframeInput | null; disabled: boolean; reviewed: boolean;
  onSave(pair: ShotFramePair, expectedId?: string, expectedEndRequestId?: string): Promise<boolean>;
  onReview(start: LibraryAsset, end: LibraryAsset, pair: ShotFramePair): void;
  onAssets(assets: LibraryAsset[]): void; onBalance(remaining: number): void; beforePrepare?(): Promise<boolean>;
  endControls?: ReactNode; inputValid?: boolean;
}) {
  const [jobs, setJobs] = useState<{ start?: Job; end?: Job }>({});
  const [admission, setAdmission] = useState<History>();
  const [historyReady, setHistoryReady] = useState(false), [imageAttempt, setImageAttempt] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, boolean>>({}), [previewFailure, setPreviewFailure] = useState<string>();
  const [enlarged, setEnlarged] = useState<"start" | "end" | null>(null);
  const [endEditing, setEndEditing] = useState(false);
  const editor = useRef<HTMLDetailsElement>(null), historyScope = useRef(pair?.id);
  const live = useRef(true), lock = useRef(false), current = useRef({ pair, input, onSave, onAssets, onBalance });
  current.current = { pair, input, onSave, onAssets, onBalance };
  const matches = framePairMatches(pair, input);
  const bothReady = finished(jobs.start) && finished(jobs.end);
  let endRequest: string | undefined, pairError = "";
  try { endRequest = pair ? activeEndRequestId(pair) : undefined; }
  catch { pairError = "This saved preparation could not be read. Your generated images remain saved in Media."; }
  const imageKeys = { start: `${pair?.id}:${jobs.start?.candidateUrl}:${imageAttempt}`, end: `${pair?.id}:${endRequest}:${jobs.end?.candidateUrl}:${imageAttempt}` };
  const previewError = Object.values(imageKeys).includes(previewFailure ?? "");
  const visibleKeys = useRef(imageKeys); visibleKeys.current = imageKeys;
  const previewsReady = !previewError && loaded[imageKeys.start] && loaded[imageKeys.end];

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
    const savedEndRequest = saved ? activeEndRequestId(saved) : undefined;
    const [startState, endState] = await Promise.all([history(saved?.startRequestId, recover, signal), saved ? history(savedEndRequest, recover, signal) : Promise.resolve(null)]);
    if (!live.current || signal?.aborted || !sameFrameOperation(saved, current.current.pair)) return;
    const start = saved ? startState.jobs.find(job => job.requestId === saved.startRequestId) : undefined;
    const end = saved ? endState?.jobs.find(job => job.requestId === savedEndRequest) : undefined;
    setJobs({ start, end }); setAdmission(endState ?? startState); setHistoryReady(true); setConnectionError(null);
    current.current.onBalance((endState ?? startState).balanceRemaining);
    current.current.onAssets([start?.asset, end?.asset].filter((asset): asset is LibraryAsset => !!asset));
    const latest = current.current.pair;
    const receipt = latest ? framePairReceipt(latest, start, end) : undefined;
    if (latest && receipt && JSON.stringify(receipt) !== JSON.stringify(latest)) {
      if (!await current.current.onSave(receipt, latest.id, savedEndRequest)) setError("Your results are saved. Reopen this shot to reconnect them.");
    }
    return { start, end, pair: receipt };
  }
  useEffect(() => {
    live.current = true; setHistoryReady(false);
    const sameStart = historyScope.current === pair?.id; historyScope.current = pair?.id;
    setJobs(previous => sameStart ? { start: previous.start } : {}); setLoaded(previous => sameStart ? previous : {}); setPreviewFailure(undefined); setError("");
    const abort = new AbortController();
    void refresh(false, abort.signal).catch(() => { if (!abort.signal.aborted) setConnectionError("Your saved requests are retained. Check your connection and refresh status."); });
    return () => { live.current = false; abort.abort(); };
  }, [pair?.id, endRequest]);
  useEffect(() => {
    if (!pair || bothReady || jobs.start?.status === "FAILED" || jobs.end?.status === "FAILED") return;
    const abort = new AbortController();
    const timer = setInterval(() => { void refresh(false, abort.signal).catch(() => { if (!abort.signal.aborted) setConnectionError("Progress could not refresh. No new generation will be submitted."); }); }, 5000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [pair?.id, endRequest, bothReady, jobs.start?.status, jobs.end?.status]);

  async function post(value: object) {
    const response = await fetch("/api/ai/keyframes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "Preparation needs checking. Your saved request is retained.");
    return result;
  }
  async function prepare(retry = false) {
    if (disabled || lock.current || !input || !inputValid || !historyReady || !admission?.enabled || !retry && (admission.balanceRemaining < 2 || active(jobs.start) || active(jobs.end) || !!pair?.endRevision && !jobs.end)) return;
    lock.current = true; setBusy(true); setError("");
    const original = pair?.id;
    try {
      if (beforePrepare && !await beforePrepare()) throw Error("Save this shot before preparing its frames.");
      const saved = retry && pair ? pair : newFramePair(input);
      if (!saved.endRevision && !framePairMatches(saved, input)) throw Error("Restore this pair's reference and settings before continuing it.");
      if (!await onSave(saved, original, pair ? activeEndRequestId(pair) : undefined)) throw Error("Save the frame request before preparing images.");
      if (retry) {
        const latest = await refresh(true);
        if (!latest) throw Error("The saved preparation could not be checked. Refresh its status before continuing.");
        if (latest?.end || latest?.start && !finished(latest.start)) return;
        if (saved.endRevision) await post({ action: "generate", requestId: saved.endRevision.requestId, ...savedEndRevisionInput(saved)! });
        else if (latest?.start) await post({ action: "continue-pair", jobId: latest.start.id });
        else await post({ action: "generate", requestId: saved.startRequestId, ...savedFramePairInput(saved) });
      } else {
        await post({ action: "generate", requestId: saved.startRequestId, ...savedFramePairInput(saved) });
      }
      await refresh();
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Your requests are saved. Check status before trying again."); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  async function refineEnd() {
    if (disabled || lock.current || !pair || !input || !inputValid || !historyReady || !admission?.enabled || admission.balanceRemaining < 1 || !canReviseEnd(pair, historyReady, jobs.start, jobs.end)) return;
    const original = pair, intent = framePairIntent(input);
    lock.current = true; setBusy(true); setError("");
    try {
      if (beforePrepare && !await beforePrepare()) throw Error("Save this shot before adjusting End.");
      const latest = await refresh(true);
      if (!latest || !sameFrameOperation(original, current.current.pair) || !current.current.input || framePairIntent(current.current.input) !== intent) throw Error("The shot changed. Review its current settings first.");
      if (!canReviseEnd(original, true, latest.start, latest.end)) throw Error("Wait for the saved result before making another End.");
      const base = latest.pair ?? original;
      const saved = newEndRevision(base, input, latest.start!.asset!.id);
      if (!latest.end?.candidateUrl && saved.endRevision) saved.endRevision.previousJobId = original.endRevision?.previousJobId ?? original.endJobId;
      if (!await onSave(saved, original.id, activeEndRequestId(original))) throw Error("Save the End request before generating it.");
      await post({ action: "generate", requestId: saved.endRevision!.requestId, ...savedEndRevisionInput(saved)! });
      setEndEditing(false); await refresh();
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Your End request is saved. Reconnect to check it."); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  async function review() {
    if (!pair || !inputValid || !matches || !bothReady || !previewsReady || lock.current || disabled) return;
    lock.current = true; setBusy(true); setError("");
    const original = pair;
    try {
      const [start, end] = await Promise.all([post({ action: "use", jobId: jobs.start!.id }), post({ action: "use", jobId: jobs.end!.id })]);
      if (!live.current || !sameFrameOperation(original, current.current.pair) || !framePairMatches(current.current.pair, current.current.input)) return;
      const latest = current.current.pair!;
      const selected = { ...latest, startAssetId: start.asset.id, ...(latest.endRevision ? { endRevision: { ...latest.endRevision, assetId: end.asset.id } } : { endAssetId: end.asset.id }) };
      if (!await onSave(selected, original.id, activeEndRequestId(original))) throw Error("Save this shot before using the prepared frames.");
      onAssets([start.asset, end.asset]); onReview(start.asset, end.asset, selected);
      await refresh();
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "The prepared frames are still saved. Check status to recover them."); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  if (pairError) return <p role="alert" className={styles.notice}>{pairError}</p>;
  const sameSource = !!pair && input?.source.assetId === pair.sourceAssetId;
  const revisable = sameSource && canReviseEnd(pair, historyReady, jobs.start, jobs.end);
  const checkStatus = () => void refresh(true).catch(() => setConnectionError("Could not reconnect. Your images and requests are saved."));
  return <section className={styles.pair} aria-label="Prepare both frames">
    <ol className={styles.steps} aria-label="Shot progress">
      <li data-ready={finished(jobs.start)}><span>1</span>Start {finished(jobs.start) ? "✓" : ""}</li>
      <li data-ready={finished(jobs.end)}><span>2</span>End {finished(jobs.end) ? "✓" : ""}</li>
      <li data-ready={reviewed}><span>3</span>Video {reviewed ? "→" : ""}</li>
    </ol>
    {!pair ? <button className="btn btn-block" type="button" disabled={disabled || busy || !inputValid || !input || !admission?.enabled || admission.balanceRemaining < 2} onClick={() => void prepare()}>Prepare Start and End · 2 credits</button> : null}
    {connectionError ? <div className={styles.notice} role="alert"><p>{connectionError}</p><button className="btn" type="button" onClick={() => void refresh(false).catch(() => setConnectionError("Could not reconnect. Your requests are saved."))}>Retry status check</button></div> : null}
    <div className={styles.images}>
      {(["start", "end"] as const).map(role => {
        const job = jobs[role], title = role === "start" ? "Start" : "End", key = imageKeys[role];
        const processing = job?.status === "QUEUED" || job?.status === "SUBMITTING";
        const previousUrl = role === "end" && !job?.candidateUrl && pair?.endRevision?.previousJobId ? `/api/ai/keyframes?job=${encodeURIComponent(pair.endRevision.previousJobId)}&artifact=candidate` : null;
        const problem = job?.error || (role === "end" && !job ? jobs.start?.continuationError : null);
        return <figure key={role} className={styles.frame} aria-label={`${title} frame`} aria-busy={processing}>
          <figcaption><strong>{title}</strong><span role="status">{reviewed && matches ? "Selected" : frameCardLabel(job, role === "end" && !!pair && !finished(jobs.start))}</span></figcaption>
          <div className={styles.picture}>
            {job?.candidateUrl ? <img key={key} src={job.candidateUrl} alt={`Prepared ${title} frame`} onLoad={() => { if (visibleKeys.current[role] === key) setLoaded(old => ({ ...old, [key]: true })); }} onError={() => { if (visibleKeys.current[role] === key) setPreviewFailure(key); }} />
              : previousUrl ? <><img src={previousUrl} alt="Previous End version" /><span className={styles.previous}>Previous version</span></>
                : <div className={styles.placeholder}><span aria-hidden="true">{role === "start" ? "1" : "2"}</span>{role === "end" && pair ? "End view" : `${title} view`}</div>}
            {processing ? <div className={styles.loading} role="progressbar" aria-label={`${title} image progress`} aria-valuetext={frameCardLabel(job)}><span /></div> : null}
          </div>
          <div className={styles.actions}>
            {job?.candidateUrl ? <button type="button" className="btn btn-quiet" onClick={() => setEnlarged(role)}>Inspect {title}</button> : null}
            {role === "start" && finished(job) ? <span className={styles.kept}>✓ Kept when End changes</span> : null}
            {role === "end" && revisable ? <button type="button" className="btn" disabled={disabled || busy} onClick={() => { setEndEditing(true); setTimeout(() => editor.current?.scrollIntoView({ block: "nearest" }), 0); }}>Adjust End only</button> : null}
            {role === "end" && pair && !job && (pair.endRevision || matches && finished(jobs.start)) ? <button type="button" className="btn" disabled={disabled || busy || !historyReady || !inputValid} onClick={() => void prepare(true)}>Resume saved End</button> : null}
            {role === "start" && pair && !job && historyReady ? <button type="button" className="btn" disabled={disabled || busy || !inputValid} onClick={() => void prepare(true)}>Resume saved preparation</button> : null}
            {job?.status === "UNKNOWN" ? <button type="button" className="btn" disabled={busy} onClick={checkStatus}>Check saved result</button> : null}
            {problem ? <details className={styles.issue}><summary>{title === "End" && !job ? "End needs attention" : "Image needs attention"}</summary><p>{problem}</p></details> : null}
          </div>
        </figure>;
      })}
    </div>
    {pair && endControls ? <details ref={editor} className={styles.endEditor} open={endEditing} onToggle={event => setEndEditing(event.currentTarget.open)}>
      <summary>Adjust End · Start stays unchanged</summary>
      {endControls}
      <button className="btn btn-block" type="button" disabled={disabled || busy || !inputValid || !input || !admission?.enabled || admission.balanceRemaining < 1 || !revisable} onClick={() => void refineEnd()}>{busy ? "Saving request…" : "Generate End only · 1 credit"}</button>
    </details> : null}
    {previewError ? <p role="alert">A preview could not load. The result is saved. <button type="button" onClick={() => { setPreviewFailure(undefined); setLoaded({}); setImageAttempt(value => value + 1); void refresh(true).catch(() => setConnectionError("Could not refresh previews.")); }}>Reload previews</button></p> : null}
    {pair && !matches ? <p className={styles.hint} role="status">{sameSource ? "End settings changed. Start is kept; generate End only to apply them." : "Reference changed. Prepare new Start and End images for this photo."}</p> : null}
    {bothReady && matches && !endEditing ? <button className="btn btn-block" type="button" disabled={disabled || busy || !inputValid || !previewsReady || reviewed} onClick={() => void review()}>{reviewed ? "Frames selected for video" : "Use these frames"}</button> : null}
    {pair && historyReady && (!pair.endRevision || !!jobs.end) && (bothReady || jobs.start?.status === "FAILED" || jobs.end?.status === "FAILED" || !matches && finished(jobs.start) && !jobs.end && !!jobs.start?.continuationError) ? <details className={styles.reset}><summary>Replace Start and End</summary><p>Creates two new images. Your previous results stay saved.</p><button className="btn btn-quiet" type="button" disabled={disabled || busy || !inputValid || !input || !admission?.enabled || admission.balanceRemaining < 2 || active(jobs.start) || active(jobs.end)} onClick={() => void prepare()}>Prepare another pair · 2 credits</button></details> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    {admission && !admission.enabled ? <p className={styles.hint} role="status">{admission.reason || "Image preparation is paused."}</p> : null}
    {enlarged && jobs[enlarged]?.candidateUrl ? <ModalDialog className={styles.inspection} aria-label={`Inspect prepared ${enlarged} frame`} onRequestClose={() => setEnlarged(null)}>
      <button type="button" className="btn" onClick={() => setEnlarged(null)}>Close image</button>
      <img src={jobs[enlarged]!.candidateUrl!} alt={`Prepared ${enlarged} frame, enlarged`} />
    </ModalDialog> : null}
  </section>;
}
