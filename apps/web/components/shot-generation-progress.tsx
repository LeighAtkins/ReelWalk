"use client";

import { useEffect, useState } from "react";
import styles from "./shot-generation-progress.module.css";

export type ShotGenerationProgressProps = {
  stage: "start" | "end" | "review" | "video" | "ready";
  status?: string;
  requestedAt?: string;
  lastCheckedAt?: string;
  connectionError?: string | null;
  queueLabel?: string | null;
};

const complete = new Set(["CANDIDATE", "USED", "SUCCEEDED", "FAILED", "CANCELLED"]);
const working = new Set(["QUEUED", "SUBMITTING", "RUNNING", "SAVING", "PREPARING"]);

/** Total wall time since the saved request, including any queue wait. */
export function formatShotElapsed(requestedAt: string | undefined, now: number): string | null {
  if (!requestedAt || !Number.isFinite(now)) return null;
  const start = Date.parse(requestedAt);
  if (!Number.isFinite(start)) return null;
  const seconds = Math.floor(Math.max(0, now - start) / 1000);
  const minutes = Math.floor(seconds / 60), remainder = String(seconds % 60).padStart(2, "0");
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}

export function shotProgressSummary({ stage, status, connectionError, queueLabel }: ShotGenerationProgressProps): { title: string; detail: string; active: boolean; attention: boolean; terminal: boolean } {
  const state = status?.toUpperCase();
  const subject = stage === "start" ? "Start frame" : stage === "end" ? "End frame" : "video";
  if (state === "FAILED" || state === "CANCELLED") return { title: `${subject === "video" ? "Video" : subject} ${state === "FAILED" ? "could not finish" : "cancelled"}`, detail: "Check the saved request before trying again.", active: false, attention: true, terminal: true };
  if (state === "UNKNOWN" || state === "UNRESOLVED") return { title: `Checking ${subject}`, detail: "The outcome is not confirmed. Your saved request will not be submitted again automatically.", active: false, attention: true, terminal: false };
  if (connectionError) return { title: "Connection interrupted", detail: connectionError, active: false, attention: true, terminal: false };
  if (state === "WAITING_END") return { title: "Start saved · End has not started", detail: "No End request was found. Check saved preparation, then continue it below. Your Start image is retained.", active: false, attention: true, terminal: false };
  if (state === "CHECKING") return { title: `Checking saved ${subject}`, detail: "Checking the saved request. No new generation is being submitted.", active: false, attention: false, terminal: false };
  if (stage === "review") return { title: "Review Start and End", detail: "Check both images before making your video.", active: false, attention: false, terminal: true };
  if (stage === "ready") return { title: "Your video is ready", detail: "Review the result before using it in your shot.", active: false, attention: false, terminal: true };
  if (state && complete.has(state)) return { title: `${subject === "video" ? "Video" : subject} ready`, detail: "Your result is saved and ready to review.", active: false, attention: false, terminal: true };
  if (state === "QUEUED") return { title: `${subject === "video" ? "Video" : subject} queued`, detail: queueLabel || "Waiting to start. You can leave and return to this shot.", active: true, attention: false, terminal: false };
  if (state && working.has(state)) return { title: `${state === "RUNNING" ? "Generating" : "Preparing"} ${subject}`, detail: "You can leave and reopen this shot without starting it again.", active: true, attention: false, terminal: false };
  return { title: `Ready to prepare ${subject}`, detail: "Review the results before making your video.", active: false, attention: false, terminal: false };
}

export function ShotGenerationProgress(props: ShotGenerationProgressProps) {
  const [now, setNow] = useState(() => Date.now());
  const summary = shotProgressSummary(props);
  const elapsed = !summary.terminal ? formatShotElapsed(props.requestedAt, now) : null;
  const checked = !summary.terminal ? formatShotElapsed(props.lastCheckedAt, now) : null;
  const ticking = elapsed !== null || checked !== null;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return <section className={`${styles.progress} ${summary.attention ? styles.attention : ""}`} aria-label="Generation progress">
    <div className={styles.heading}>
      {summary.active ? <span className={styles.spinner} aria-hidden="true" /> : null}
      <strong role="status" aria-live="polite">{summary.title}</strong>
      {elapsed ? <span className={styles.elapsed} role="timer" aria-live="off" aria-label="Elapsed since request">Elapsed {elapsed}</span> : null}
    </div>
    <p className={styles.detail}>{summary.detail}</p>
    {checked ? <p className={styles.checked} aria-live="off">Last checked {checked === "0:00" ? "just now" : `${checked} ago`}</p> : null}
  </section>;
}
