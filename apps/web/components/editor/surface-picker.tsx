"use client";

import { useEffect, useRef, useState } from "react";
import { findSurfaces, titleAspect, TRACK_HEIGHT, TRACK_WIDTH, type Clip, type SurfaceCandidate, type SurfaceHints, type TextOverlay, type TitleOnSurface } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { frameService, luminance } from "./frame-service";
import { pinTitle } from "./sheets";

/**
 * "Put on a surface" (ADR 0075), at the top of the Pin sheet: one tap shows the three best surfaces in the
 * shot's first frame, drawn on it; one more tap lays the title on the one chosen, in the house serif with an
 * ink chosen from the surface, and follows it through the whole shot with the Pin tracker. The result is one
 * edit (one undo). A surface with nothing to follow, or one the tracker loses, is offered as a fixed placement
 * in the same perspective, said plainly; the title is never dropped. The corners can then be dragged with the
 * existing handles ("Place the corners full screen").
 */
const COLORS = ["#ffb000", "#27c4e8", "#e24bd0"];
const LOOK_W = 576, LOOK_H = 1024;

type Found = { jpeg: string; candidates: SurfaceCandidate[]; vision: "model" | "edges"; note?: string };

const points = (q: readonly number[]) => [0, 1, 2, 3].map((i) => `${q[i * 2].toFixed(4)},${(q[i * 2 + 1] * (LOOK_H / LOOK_W)).toFixed(4)}`).join(" ");

export function SurfacePicker({ text, clip, asset, clipStartMs, placementVersionNow, onPlace }: {
  text: TextOverlay; clip: Clip | null; asset: LibraryAsset | undefined; clipStartMs: number;
  placementVersionNow?(): string;
  /** The title was put on a surface: everything it needs, to be written as one edit. */
  onPlace(placement: TitleOnSurface): void;
}) {
  const [phase, setPhase] = useState<"idle" | "looking" | "choose" | "tracking">("idle");
  const [found, setFound] = useState<Found | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [fallback, setFallback] = useState<{ candidate: SurfaceCandidate; why: string } | null>(null);
  const run = useRef<AbortController | null>(null);
  useEffect(() => () => run.current?.abort(), []);
  const canLook = Boolean(clip && asset);

  async function look() {
    if (!clip || !asset) return;
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    setPhase("looking"); setFallback(null); setFound(null); setStatus("Looking for surfaces in the shot…");
    try {
      const speed = clip.speed || 1;
      const sourceMs = Math.min(clip.sourceStartMs + Math.max(0, text.startMs - clipStartMs) * speed, Math.max(clip.sourceStartMs, clip.sourceEndMs - 40));
      const target = { clip, media: { src: asset.url, kind: asset.kind } };
      const [view, analysis] = await Promise.all([
        frameService.frameAt(target, sourceMs, { width: LOOK_W, height: LOOK_H, purpose: "view" }),
        frameService.frameAt(target, sourceMs, { width: TRACK_WIDTH, height: TRACK_HEIGHT, purpose: "analysis" }),
      ]);
      if (!view || !analysis) { setPhase("idle"); setStatus("The video could not be read."); return; }
      const jpeg = view.toDataURL("image/jpeg", 0.8);
      let hints: SurfaceHints = {};
      let vision: Found["vision"] = "edges", note: string | undefined;
      try {
        const response = await fetch("/api/ai/surface-regions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ frame: jpeg }), signal: controller.signal });
        const body = (await response.json().catch(() => ({}))) as { regions?: SurfaceHints["regions"]; horizonY?: number | null; error?: string };
        if (response.ok) { hints = { regions: body.regions ?? [], horizonY: body.horizonY ?? null }; vision = "model"; }
        else note = body.error ?? "The model could not look; using the picture's edges.";
      } catch {
        if (controller.signal.aborted) return;
        note = "The model could not be reached; using the picture's edges.";
      }
      if (controller.signal.aborted) return;
      const search = findSurfaces(luminance(analysis), { aspect: titleAspect(text.text, text.tracking !== undefined ? { tracking: text.tracking } : {}) }, hints, { top: 3 });
      setFound({ jpeg, candidates: search.candidates, vision, note });
      setPhase("choose");
      setStatus(search.candidates.length
        ? `${search.candidates.length === 1 ? "One surface" : `${search.candidates.length} surfaces`} found${vision === "edges" ? " from the picture's edges alone" : ""}. Tap one to put the title on it.`
        : "No surface in this frame is large and clear enough for the words. Try a different shot, a shorter title, or set the four corners by hand below.");
    } catch {
      if (!controller.signal.aborted) { setPhase("idle"); setStatus("Looking for surfaces failed. Set the four corners by hand below."); }
    }
  }

  /** Lays the title on the candidate; with `track` it is followed through the shot first. */
  async function choose(candidate: SurfaceCandidate, track: boolean) {
    if (!clip || !asset) return;
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    const base: TitleOnSurface = { corners: candidate.placement, ink: { color: candidate.ink.color, shadow: candidate.ink.shadow } };
    setFallback(null);
    if (!track || candidate.tracking === "fixed" || clip.kind !== "VIDEO") {
      onPlace(base);
      setPhase("idle"); setFound(null);
      setStatus(!track ? "Placed on the surface without following it: it stays where it is on screen. Drag the corners if it is off."
        : clip.kind !== "VIDEO" ? "Placed on the surface. The shot is a photo, so there is nothing to follow."
        : `Placed on the ${candidate.label.toLowerCase()}, but it has too little detail to follow (${candidate.texture.points} points), so it keeps its place on screen. Drag the corners if it is off.`);
      return;
    }
    const version = placementVersionNow?.() ?? "";
    setPhase("tracking"); setStatus("Following the surface through the shot…");
    const cx = candidate.placement.reduce((s, v, i) => s + (i % 2 === 0 ? v : 0), 0) / 4, cy = candidate.placement.reduce((s, v, i) => s + (i % 2 === 1 ? v : 0), 0) / 4;
    const target = { ...text, x: cx, y: cy, surface: candidate.placement, support: candidate.plane } as TextOverlay;
    const result = await pinTitle({ text: target, clip, asset, clipStartMs, wholeShot: true, lean: { yaw: 0, pitch: 0 }, signal: controller.signal, onProgress: (f) => setStatus(`Following the surface through the shot… ${Math.round(f * 100)}%`) });
    if (controller.signal.aborted) return;
    if ("error" in result) {
      // Never silently dropped: say why and offer the same placement without tracking.
      setPhase("choose");
      setFallback({ candidate, why: result.error });
      setStatus(`${result.error} You can place the title here without following the camera, or try another surface.`);
      return;
    }
    if (placementVersionNow && placementVersionNow() !== version) { setPhase("choose"); setStatus("The title or its shot changed while tracking, so that track was discarded. Tap the surface again."); return; }
    onPlace({ ...base, pinned: { path: result.pinned.path!, pin: result.pinned.pin! }, timing: { startMs: result.patch.startMs ?? text.startMs, endMs: result.patch.endMs ?? text.endMs } });
    setPhase("idle"); setFound(null);
    setStatus(`Put on the ${candidate.label.toLowerCase()} and followed through the shot. ${result.status} One undo takes it back; drag the corners below if it is off.`);
  }

  const busy = phase === "looking" || phase === "tracking";
  return (
    <section aria-label="Put on a surface" data-testid="surface-picker" style={{ marginBottom: 12 }}>
      <button type="button" className="btn btn-signal btn-block" disabled={!canLook || busy} onClick={look} data-testid="put-on-surface">
        {phase === "looking" ? "Looking…" : phase === "tracking" ? "Following…" : phase === "choose" ? "Look again" : "Put on a surface"}
      </button>
      {!canLook ? <p className="muted small">Put on a surface needs the title to start on a shot.</p> : <p className="muted small">One tap: the app finds a wall, floor, sky or snow in this shot and paints the title on it, in its perspective, following the camera.</p>}
      {found ? (
        <div data-testid="surface-candidates" style={{ marginTop: 8 }}>
          <svg viewBox={`0 0 1 ${LOOK_H / LOOK_W}`} role="img" aria-label="The first frame of the shot with the surfaces found drawn on it" style={{ width: "100%", maxHeight: "52vh", display: "block", borderRadius: 8, background: "#14110d" }}>
            <image href={found.jpeg} x="0" y="0" width="1" height={LOOK_H / LOOK_W} preserveAspectRatio="xMidYMid slice" />
            {found.candidates.map((c, i) => (
              <g key={c.id} onClick={() => !busy && choose(c, true)} style={{ cursor: busy ? "default" : "pointer" }}>
                <polygon points={points(c.plane)} fill="none" stroke={COLORS[i % 3]} strokeWidth="0.006" strokeDasharray="0.02 0.014" />
                <polygon points={points(c.placement)} fill={COLORS[i % 3]} fillOpacity="0.5" stroke={COLORS[i % 3]} strokeWidth="0.007" />
                <circle cx={(c.placement[0] + c.placement[4]) / 2} cy={((c.placement[1] + c.placement[5]) / 2) * (LOOK_H / LOOK_W)} r="0.04" fill="#000" fillOpacity="0.7" />
                <text x={(c.placement[0] + c.placement[4]) / 2} y={((c.placement[1] + c.placement[5]) / 2) * (LOOK_H / LOOK_W) + 0.018} fontSize="0.05" fontWeight="700" fill={COLORS[i % 3]} textAnchor="middle">{i + 1}</text>
              </g>
            ))}
          </svg>
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {found.candidates.map((c, i) => (
              <button key={c.id} type="button" className="btn btn-block" disabled={busy} onClick={() => choose(c, true)} data-testid={`surface-${i + 1}`} style={{ minHeight: 48, borderLeft: `6px solid ${COLORS[i % 3]}`, textAlign: "left" }}>
                <strong>{i + 1}. {c.label}</strong> <span className="muted small">{c.tracking === "surface" ? "follows the camera" : "fixed: nothing to follow"} · {Math.round(c.area * 100)}% of the frame</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {fallback ? (
        <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
          <button type="button" className="btn btn-signal btn-block" onClick={() => choose(fallback.candidate, false)} data-testid="place-fixed">Place it here without following the camera</button>
        </div>
      ) : null}
      {found?.note ? <p className="muted small">{found.note}</p> : null}
      {status ? <p role="status" className="small" data-testid="surface-status">{status}</p> : null}
    </section>
  );
}
