"use client";
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Clip, HeadLock } from '@reelwalk/core';
import type { LibraryAsset } from '@/lib/library';
import { Sheet } from '../sheet';
import { trackHead } from './head-tracking';
import { loadVideo, releaseVideo, seekVideo } from './frame-service';

/** Pick a face on the first played frame, then make one undoable clip edit. */
export function HeadLockControl({ clip, asset, onChange }: { clip: Clip; asset: LibraryAsset | undefined; onChange(lock: HeadLock | null): void }) {
  const [open, setOpen] = useState(false);
  if (clip.kind !== 'VIDEO' || !asset) return null;
  return <>
    <button type="button" className="btn btn-quiet btn-block" data-testid="head-lock-open" onClick={() => setOpen(true)}>{clip.headLock ? 'Head tracking on' : 'Lock on head'}</button>
    {clip.headLock ? <button type="button" className="btn btn-quiet btn-block" onClick={() => onChange(null)}>Remove head tracking</button> : null}
    {open ? createPortal(<HeadPicker key={`${clip.id}-${clip.sourceStartMs}`} clip={clip} asset={asset} onClose={() => setOpen(false)} onChange={lock => { onChange(lock); setOpen(false); }} />, document.body) : null}
  </>;
}
function HeadPicker({ clip, asset, onClose, onChange }: { clip: Clip; asset: LibraryAsset; onClose(): void; onChange(lock: HeadLock): void }) {
  const canvas = useRef<HTMLCanvasElement>(null), abort = useRef<AbortController | null>(null);
  const seed = asset.face?.track?.find(s => s.ms >= clip.sourceStartMs - 30) ?? (clip.sourceStartMs < 50 ? asset.face?.box : null);
  const [centre, setCentre] = useState({ x: seed ? (seed.x0 + seed.x1) / 2 : .5, y: seed ? (seed.y0 + seed.y1) / 2 : .3 });
  const [size, setSize] = useState(seed ? seed.y1 - seed.y0 : .16);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState<string | null>(null);
  const aspect = (asset.width || 1080) / (asset.height || 1920);
  useEffect(() => {
    let active = true;
    void (async () => {
      let video: HTMLVideoElement | null = null;
      try {
        video = await loadVideo(asset.url); await seekVideo(video, clip.sourceStartMs + 1);
        if (!active || !canvas.current) return;
        const c = canvas.current; c.width = 360; c.height = Math.round(360 / aspect);
        c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height); setReady(true);
      } catch { if (active) setError('The first frame could not be read.'); }
      finally { if (video) releaseVideo(video); }
    })();
    return () => { active = false; abort.current?.abort(); };
  }, [asset.url, clip.sourceStartMs, aspect]);
  const w = size * .75 / aspect;
  return <Sheet title="Lock on head" onClose={() => { abort.current?.abort(); onClose(); }}>
    <p className="muted small">Tap the face on this first frame. Fit the box around the face, then track. The head stays in place and the background moves. The picture crops closer to keep every edge filled.</p>
    <div style={{ position: 'relative', maxWidth: 200, margin: '0 auto', touchAction: 'none' }} onPointerDown={e => {
      if (busy) return; const r = e.currentTarget.getBoundingClientRect(); setCentre({ x: Math.max(w / 2, Math.min(1 - w / 2, (e.clientX - r.left) / r.width)), y: Math.max(size / 2, Math.min(1 - size / 2, (e.clientY - r.top) / r.height)) });
    }}>
      <canvas ref={canvas} style={{ width: '100%', display: 'block' }} aria-label="Tap the face to track" />
      <div style={{ position: 'absolute', pointerEvents: 'none', left: `${(centre.x - w / 2) * 100}%`, top: `${(centre.y - size / 2) * 100}%`, width: `${w * 100}%`, height: `${size * 100}%`, border: '2px solid #56dfc0' }} />
    </div>
    <label className="field">Face box size<input type="range" min="0.06" max="0.35" step="0.005" value={size} disabled={busy} onChange={e => setSize(Number(e.target.value))} /></label>
    {error ? <p className="error small" role="alert">{error}</p> : null}
    <button type="button" className="btn btn-block" data-testid="head-lock-track" disabled={!ready || busy} onClick={async () => {
      const controller = new AbortController(); abort.current = controller; setBusy(true); setError(null);
      try { const lock = await trackHead(asset.url, clip, { x0: centre.x - w / 2, x1: centre.x + w / 2, y0: centre.y - size / 2, y1: centre.y + size / 2 }, controller.signal, setProgress); if (!controller.signal.aborted) onChange(lock); }
      catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Tracking failed.'); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }}>{busy ? `Tracking ${Math.round(progress * 100)}%` : 'Track head'}</button>
    <p className="muted small">Use a clear face and a source section up to 6 seconds on phones, 12 seconds on desktop. No AI credits used.</p>
  </Sheet>;
}
