"use client";

import { useState, type CSSProperties } from "react";
import { aiBoundary, type Clip } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import styles from "./shot-workspace.module.css";

export type ShotSourcePickerProps = {
  label: string; value: string; frame?: { assetId: string; atMs: number };
  photos: LibraryAsset[]; clips: Clip[]; allowVideos?: boolean; allowNone?: boolean; disabled?: boolean;
  onChange(value: string): void; onTimeChange(atMs: number): void;
};

const picture: CSSProperties = { display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: "center" };

/** The selected preview uses the same centred portrait framing as the video input. */
function SourcePicture({ asset, atMs, thumbnail = false, disabled = false }: { asset: LibraryAsset; atMs: number; thumbnail?: boolean; disabled?: boolean }) {
  const [original, setOriginal] = useState(!thumbnail || !asset.thumbUrl);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (failed) return <span role="status" className={styles.sourceHint}>
    Preview unavailable. {!thumbnail ? <><button type="button" disabled={disabled} onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>Retry preview</button>
      <span> If it still fails, reload the page to refresh the media link.</span></> : <span>Tap to preview.</span>}
  </span>;
  const image = asset.kind === "IMAGE" || !original;
  return image ? <img key={attempt} src={original ? asset.url : asset.thumbUrl!} alt="" style={picture} loading={thumbnail ? "lazy" : "eager"}
    onError={() => { if (!original) setOriginal(true); else setFailed(true); }} /> :
    <video key={attempt} src={asset.url} muted playsInline preload="metadata" style={picture} aria-label={`Source frame at ${(atMs / 1000).toFixed(3)} seconds`}
      onLoadedMetadata={e => {
        const video = e.currentTarget;
        const upper = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : atMs / 1000;
        try { video.currentTime = Math.max(0, Math.min(atMs / 1000, upper)); } catch { setFailed(true); }
      }} onError={() => setFailed(true)} />;
}

export function ShotSourcePicker({ label, value, frame, photos, clips, allowVideos = true, allowNone = false, disabled = false, onChange, onTimeChange }: ShotSourcePickerProps) {
  const available = photos.filter(a => !a.isPano && (a.kind === "IMAGE" && /\.(jpe?g|png)$/i.test(a.fileName) || allowVideos && a.kind === "VIDEO"));
  const selected = available.find(a => a.id === frame?.assetId);
  // The existing panel uses the source clip's last frame for Start, and its first for End.
  const ending = /\b(end|ending|last)\b/i.test(label);
  const videoTime = selected?.kind === "VIDEO" && value.startsWith("asset:");
  const maxMs = Math.max(0, (selected?.durationMs ?? 0) - 1);
  const options = [
    ...clips.flatMap((clip, index) => {
      const asset = available.find(a => a.id === clip.assetId);
      return !clip.pano && asset ? [{ value: `clip:${clip.id}`, asset, atMs: aiBoundary(clip, !ending).atMs, caption: `Shot ${index + 1} · ${ending ? "first" : "last"} frame`, group: "Reel" }] : [];
    }),
    ...available.map(asset => ({ value: `asset:${asset.id}`, asset, atMs: 0, caption: asset.kind === "VIDEO" ? "Video" : "Photo", group: "Library" })),
  ];
  return <section aria-label={`${label} reference`} className={styles.source}>
    <strong className={styles.sourceTitle}>{label}</strong>
    <figure className={styles.sourceFigure}>
      <div className={styles.previewFrame}>
        {selected && frame ? <SourcePicture key={`${selected.id}:${selected.url}:${frame.atMs}`} asset={selected} atMs={frame.atMs} disabled={disabled} /> :
          <p role="status" className={styles.emptyPreview}>{value ? "This reference is unavailable. Choose another below." : "Choose a reference below."}</p>}
      </div>
      {selected ? <figcaption className={styles.caption}>{selected.fileName}{selected.kind === "VIDEO" && frame ? ` · ${(frame.atMs / 1000).toFixed(3)}s` : ""}</figcaption> : null}
    </figure>
    {selected ? <p className={styles.sourceHint}>Portrait framing · centre crop · outside edges are excluded.</p> : null}
    {videoTime ? <label className="field">Frame time (seconds)
      <input className="text-input" type="number" min={0} max={maxMs / 1000} step="0.001" value={(frame?.atMs ?? 0) / 1000} disabled={disabled}
        onChange={e => { const seconds = e.currentTarget.valueAsNumber; if (Number.isFinite(seconds)) onTimeChange(Math.min(maxMs, Math.max(0, Math.round(seconds * 1000)))); }} />
    </label> : selected?.kind === "VIDEO" && frame ? <p className="muted small">Uses the trimmed shot&apos;s {ending ? "first" : "last"} source frame.</p> : null}
    {allowNone ? <button className="btn btn-quiet" type="button" disabled={disabled} aria-pressed={!value} onClick={() => onChange("")}>No reference</button> : null}
    <div role="group" aria-label={`Choose ${label} reference`} className={styles.sourceChoices}>
      {options.map(option => <button key={option.value} type="button" disabled={disabled} aria-pressed={value === option.value}
        aria-label={`${option.group}: ${option.caption} · ${option.asset.fileName}`} onClick={() => onChange(option.value)}
        className={styles.sourceChoice}>
        <span className={styles.choiceImage}>
          <SourcePicture key={`${option.value}:${option.asset.url}:${option.asset.thumbUrl}`} asset={option.asset} atMs={option.atMs} thumbnail />
        </span>
        <span className={styles.choiceLabel}>{value === option.value ? <span className={styles.selectedMark} aria-hidden="true">✓ </span> : null}{option.group} · {option.caption}</span>
      </button>)}
    </div>
    {!options.length ? <p role="status">Add a JPEG or PNG photo{allowVideos ? " or video" : ""} to your media library first.</p> : null}
  </section>;
}
