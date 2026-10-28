"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ALTITUDE_CHOICES,
  altitudeAt,
  areaText,
  baseWindow,
  blockSvgBody,
  BUILDS,
  BUILD_PRESETS,
  blockCameraAt,
  drawBlock,
  groundYAt,
  initialPin,
  KNOWN_LENGTHS,
  OUTPUT,
  placeAt,
  projectPoint,
  revealDurationMs,
  scaleFromAltitude,
  scaleFromLength,
  sunVector,
  viewAt,
  type BlockPin,
  type BlockSolve,
  type BuildPreset,
  type ViewWindow,
} from "@reelwalk/core";
import { uploadFile } from "./editor/upload";
import { PauseIcon, PlayIcon } from "./icons";

/**
 * Walk the block (ADR 0093): one drone clip of the land becomes a reveal of what could stand on it, drawn to scale.
 *
 * Phone first, three moments. The clip uploads (the original: the 9:16 crop needs its pixels) while two questions are
 * answered with a thumb; the worker reads the land in 3D meanwhile. Then one full-screen frame of the land with the
 * outline at true size where the reading found open, level ground: drag it, turn it by its handle, drag the sun, or
 * measure a road to fix the scale. Play shows the reveal over the real clip, live. "Make it" draws it (free) and opens
 * the reel. The person places; the drawing obeys (owner, 2026-10-20).
 */

type Ready = { solve: BlockSolve; stillUrl: string; videoUrl: string };
type Phase =
  | { kind: "pick" }
  | { kind: "reading"; progress: number | null; note: string }
  | { kind: "refused"; message: string }
  | { kind: "pin" }
  | { kind: "failed"; message: string };

const ALTITUDE_UNSURE = 0;

async function pollJob(jobId: string, signal: { stopped: boolean }): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
  for (;;) {
    if (signal.stopped) return { ok: false, message: "Stopped." };
    const response = await fetch(`/api/ai-jobs/${jobId}`, { cache: "no-store" }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { status?: string; result?: unknown; error?: string } | null;
    if (body?.status === "DONE") return { ok: true, result: body.result };
    if (body?.status === "FAILED" || body?.status === "UNRESOLVED") return { ok: false, message: body.error ?? "That did not work. Try again." };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export function WalkBlock({ initialAssetId = null }: { initialAssetId?: string | null }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(initialAssetId ? { kind: "reading", progress: null, note: "Reading your land in 3D…" } : { kind: "pick" });
  const [assetId, setAssetId] = useState<string | null>(initialAssetId);
  const [build, setBuild] = useState<BuildPreset | null>(null);
  const [altitude, setAltitude] = useState<number | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const stop = useRef({ stopped: false });
  useEffect(() => {
    // Set again on every mount: a remount (React's development double mount, a fast refresh) must not stay stopped.
    const flag = { stopped: false };
    stop.current = flag;
    return () => void (flag.stopped = true);
  }, []);

  // Read the land as soon as the clip is in storage; the questions are answered meanwhile.
  useEffect(() => {
    if (!assetId) return;
    let cancelled = false;
    (async () => {
      setPhase((p) => (p.kind === "reading" ? { ...p, note: "Reading your land in 3D… about a minute" } : p));
      const start = await fetch(`/api/blocks/${assetId}`, { method: "POST" }).catch(() => null);
      let body = (await start?.json().catch(() => null)) as { ok?: boolean; status?: string; jobId?: string; message?: string } | null;
      if (body?.status === "pending" && body.jobId) {
        const done = await pollJob(body.jobId, stop.current);
        if (!done.ok) return void (!cancelled && setPhase({ kind: "failed", message: done.message }));
        body = (await (await fetch(`/api/blocks/${assetId}`, { cache: "no-store" })).json().catch(() => null)) as typeof body;
      }
      if (cancelled) return;
      const state = body as ({ status?: string; message?: string } & Partial<Ready>) | null;
      if (state?.status === "ready" && state.solve && state.stillUrl && state.videoUrl) setReady({ solve: state.solve, stillUrl: state.stillUrl, videoUrl: state.videoUrl });
      else if (state?.status === "refused") setPhase({ kind: "refused", message: state.message ?? "This clip cannot be read in 3D." });
      else setPhase({ kind: "failed", message: state?.message ?? "Could not read the land. Check your connection and try again." });
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  // Both answers in and the land read: the pin screen.
  useEffect(() => {
    if (ready && build && altitude !== null && phase.kind === "reading") setPhase({ kind: "pin" });
  }, [ready, build, altitude, phase.kind]);

  async function pick(file: File) {
    setPhase({ kind: "reading", progress: 0, note: "Uploading your clip…" });
    try {
      const asset = await uploadFile(file, (fraction) => setPhase((p) => (p.kind === "reading" ? { ...p, progress: fraction } : p)), { shrink: false });
      setPhase({ kind: "reading", progress: null, note: "Reading your land in 3D…" });
      setAssetId(asset.id);
    } catch (error) {
      setPhase({ kind: "failed", message: error instanceof Error ? error.message : "The upload did not finish." });
    }
  }

  if (phase.kind === "pin" && ready && build && assetId)
    return (
      <PinScreen
        ready={ready}
        build={build}
        altitude={altitude || null}
        onMake={async (pin) => {
          const requestId = `walk-${crypto.randomUUID()}`;
          const response = await fetch(`/api/blocks/${assetId}/reveal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, pin }) }).catch(() => null);
          const body = (await response?.json().catch(() => null)) as { jobId?: string; message?: string } | null;
          if (!body?.jobId) return setPhase({ kind: "failed", message: body?.message ?? "Could not start the reveal. Try again." });
          const done = await pollJob(body.jobId, stop.current);
          if (!done.ok) return setPhase({ kind: "failed", message: done.message });
          const { reelId } = done.result as { reelId: string };
          router.push(`/reels/${reelId}`);
        }}
      />
    );

  return (
    <section className="walk" aria-label="Walk the block">
      {phase.kind === "pick" ? (
        <label className="start-primary start-auto walk-drop" data-testid="walk-drop">
          <span className="start-text">
            <span className="start-title">Drop your drone clip</span>
            <span className="start-sub">One pass over the land, landscape, the drone moving forward or sideways. Nothing is spent: no AI credits.</span>
          </span>
          <input
            type="file"
            accept="video/*"
            aria-label="Pick a drone clip of the land"
            data-testid="walk-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void pick(file);
            }}
          />
        </label>
      ) : null}

      {phase.kind === "reading" ? (
        <div className="walk-status" role="status" aria-live="polite">
          <span className="walk-dot" aria-hidden="true" />
          <span>{phase.note}</span>
          {phase.progress !== null ? <progress max={1} value={phase.progress} aria-label="Upload" /> : null}
        </div>
      ) : null}

      {phase.kind === "reading" ? (
        <>
          <fieldset className="walk-q">
            <legend>What would you build here?</legend>
            <div className="vibe-chips" role="radiogroup">
              {BUILD_PRESETS.map((id) => (
                <button key={id} type="button" role="radio" aria-checked={build === id} className="vibe-chip" onClick={() => setBuild(id)} data-testid={`walk-build-${id}`}>
                  {BUILDS[id].label}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="walk-q">
            <legend>How high was the drone?</legend>
            <div className="vibe-chips" role="radiogroup">
              {ALTITUDE_CHOICES.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={altitude === m} className="vibe-chip" onClick={() => setAltitude(m)} data-testid={`walk-alt-${m}`}>
                  About {m} m
                </button>
              ))}
              <button type="button" role="radio" aria-checked={altitude === ALTITUDE_UNSURE} className="vibe-chip" onClick={() => setAltitude(ALTITUDE_UNSURE)} data-testid="walk-alt-unsure">
                Not sure
              </button>
            </div>
            <p className="muted small">It sets the scale. Not sure is fine: measure a road on the next screen.</p>
          </fieldset>
        </>
      ) : null}

      {phase.kind === "refused" || phase.kind === "failed" ? (
        <div className="walk-q">
          <p className="error" role="alert">
            {phase.message}
          </p>
          <button type="button" className="btn btn-quiet" onClick={() => (setAssetId(null), setReady(null), setPhase({ kind: "pick" }))}>
            Try another clip
          </button>
        </div>
      ) : null}
    </section>
  );
}

type Drag = { kind: "move"; dx: number; dz: number } | { kind: "turn" } | { kind: "sun" } | null;

/** Output pixels (the 1080 × 1920 stage) of a pointer event on the stage. */
function stagePoint(event: ReactPointerEvent<Element>, stage: SVGSVGElement): [number, number] {
  const box = stage.getBoundingClientRect();
  return [((event.clientX - box.left) / box.width) * OUTPUT.width, ((event.clientY - box.top) / box.height) * OUTPUT.height];
}

function PinScreen({ ready, build, altitude, onMake }: { ready: Ready; build: BuildPreset; altitude: number | null; onMake: (pin: BlockPin) => Promise<void> }) {
  const { solve } = ready;
  const [pin, setPin] = useState<BlockPin>(() =>
    initialPin(solve, build, altitude ? { factor: scaleFromAltitude(solve, altitude), basis: "stated" } : { factor: 1, basis: "assumed" }),
  );
  const [drag, setDrag] = useState<Drag>(null);
  const [measure, setMeasure] = useState<{ a: [number, number] | null; b: [number, number] | null } | null>(null);
  const [playMs, setPlayMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const stage = useRef<SVGSVGElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const win: ViewWindow = useMemo(() => baseWindow(solve, pin.cropX), [solve, pin.cropX]);
  const shownWin = playMs === null ? win : viewAt(solve, pin, playMs);
  const shapes = useMemo(
    () => (playMs === null ? drawBlock(solve, pin, 0, { still: { rise: 1, label: true }, window: win }) : drawBlock(solve, pin, playMs)),
    [solve, pin, win, playMs],
  );
  const scale = { x: OUTPUT.width / shownWin.w, y: OUTPUT.height / shownWin.h };
  const { width, height } = solve.intrinsics;

  // Handles, in stage pixels on the still: the end of the long side (turn) and the sun, out past the corner it lights.
  const handles = useMemo(() => {
    const cam = blockCameraAt(solve, solve.still.t);
    const y = groundYAt(solve, pin.x, pin.z);
    const at = (x: number, z: number) => {
      const q = projectPoint(cam, [x, y, z]);
      return q.z > 0 ? ([((q.u - win.x) * OUTPUT.width) / win.w, ((q.v - win.y) * OUTPUT.height) / win.h] as [number, number]) : null;
    };
    const a = (pin.yawDeg * Math.PI) / 180;
    const half = (pin.length / 2 + 4) / pin.scale.factor;
    const sun = sunVector(pin.sun);
    const h = Math.hypot(sun[0], sun[2]) || 1;
    const reach = (Math.max(pin.length, pin.width) * 0.85) / pin.scale.factor;
    return {
      turn: at(pin.x + Math.cos(a) * half, pin.z - Math.sin(a) * half),
      sun: at(pin.x + (sun[0] / h) * reach, pin.z + (sun[2] / h) * reach),
      centre: at(pin.x, pin.z),
    };
  }, [solve, pin, win]);

  // The live preview: the real clip, cropped and pushed in as the render will be, the drawing on top.
  const tick = useCallback(() => {
    const v = video.current;
    if (!v) return;
    const t = v.currentTime * 1000;
    if (t >= revealDurationMs(solve) || v.ended) {
      v.pause();
      setPlayMs(null);
      return;
    }
    setPlayMs(t);
    requestAnimationFrame(tick);
  }, [solve]);

  function play() {
    const v = video.current;
    if (!v) return;
    if (playMs !== null) {
      v.pause();
      setPlayMs(null);
      return;
    }
    v.currentTime = solve.still.t;
    setPlayMs(0);
    void v.play().then(() => requestAnimationFrame(tick)).catch(() => setPlayMs(null));
  }

  function down(event: ReactPointerEvent<SVGSVGElement>) {
    if (!stage.current || playMs !== null) return;
    const [x, y] = stagePoint(event, stage.current);
    if (measure) {
      const p: [number, number] = [(win.x + (x / OUTPUT.width) * win.w) / width, (win.y + (y / OUTPUT.height) * win.h) / height];
      setMeasure(measure.a && !measure.b ? { ...measure, b: p } : { a: p, b: null });
      return;
    }
    const near = (h: [number, number] | null) => h && Math.hypot(h[0] - x, h[1] - y) < 90;
    stage.current.setPointerCapture(event.pointerId);
    if (near(handles.sun)) return setDrag({ kind: "sun" });
    if (near(handles.turn)) return setDrag({ kind: "turn" });
    const hit = placeAt(solve, win, x, y);
    if (hit) setDrag({ kind: "move", dx: pin.x - hit.x, dz: pin.z - hit.z });
  }

  function move(event: ReactPointerEvent<SVGSVGElement>) {
    if (!drag || !stage.current) return;
    const [x, y] = stagePoint(event, stage.current);
    const hit = placeAt(solve, win, x, y);
    if (!hit) return;
    if (drag.kind === "move") setPin((p) => ({ ...p, x: hit.x + drag.dx, z: hit.z + drag.dz }));
    else {
      const deg = (Math.atan2(-(hit.z - pin.z), hit.x - pin.x) * 180) / Math.PI;
      if (drag.kind === "turn") setPin((p) => ({ ...p, yawDeg: Math.round(deg) }));
      else setPin((p) => ({ ...p, sun: { ...p.sun, azimuthDeg: Math.round((deg + 360) % 360) } }));
    }
  }

  function setLength(metres: number) {
    if (!measure?.a || !measure.b) return;
    const factor = scaleFromLength(solve, measure.a, measure.b, metres);
    if (factor) setPin((p) => ({ ...p, scale: { factor, basis: "measured" } }));
    setMeasure(null);
  }

  const resize = (key: "length" | "width", by: number) => setPin((p) => ({ ...p, [key]: Math.min(120, Math.max(3, p[key] + by)) }));
  const area = areaText(pin);
  const altitudeNow = Math.round(altitudeAt(solve, pin.scale.factor));
  const scaleNote = pin.scale.basis === "measured" ? `Measured: drone ${altitudeNow} m up` : pin.scale.basis === "stated" ? `Drone ${altitudeNow} m up (you said)` : `Scale estimated (drone ~${altitudeNow} m)`;

  return (
    <section className="walk-pin" aria-label="Place the house on your land">
      <div className="walk-stage">
        <video ref={video} src={ready.videoUrl} muted playsInline preload="auto" className="walk-video" aria-hidden="true"
          style={playMs === null ? { display: "none" } : {
            left: `${(-shownWin.x * scale.x * 100) / OUTPUT.width}%`,
            top: `${(-shownWin.y * scale.y * 100) / OUTPUT.height}%`,
            width: `${(width * scale.x * 100) / OUTPUT.width}%`,
            height: `${(height * scale.y * 100) / OUTPUT.height}%`,
          }} />
        <svg ref={stage} className="walk-svg" viewBox={`0 0 ${OUTPUT.width} ${OUTPUT.height}`} onPointerDown={down} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} data-testid="walk-stage">
          {playMs === null ? <image href={ready.stillUrl} x={-win.x * scale.x} y={-win.y * scale.y} width={width * scale.x} height={height * scale.y} preserveAspectRatio="none" /> : null}
          <g dangerouslySetInnerHTML={{ __html: blockSvgBody(shapes) }} />
          {playMs === null && !measure ? (
            <>
              {handles.turn ? (
                <g className="walk-handle" transform={`translate(${handles.turn[0]} ${handles.turn[1]})`}>
                  <circle r="34" />
                  <path d="M-12 -4a13 13 0 1 1 4 13M-12 -4v-10M-12 -4h10" />
                </g>
              ) : null}
              {handles.sun ? (
                <g className="walk-handle walk-sun" transform={`translate(${handles.sun[0]} ${handles.sun[1]})`}>
                  <circle r="30" />
                  <circle r="11" className="walk-sun-core" />
                </g>
              ) : null}
            </>
          ) : null}
          {measure?.a ? <circle cx={(measure.a[0] * width - win.x) * scale.x} cy={(measure.a[1] * height - win.y) * scale.y} r="14" className="walk-mark" /> : null}
          {measure?.b ? <circle cx={(measure.b[0] * width - win.x) * scale.x} cy={(measure.b[1] * height - win.y) * scale.y} r="14" className="walk-mark" /> : null}
          {measure?.a && measure.b ? (
            <line x1={(measure.a[0] * width - win.x) * scale.x} y1={(measure.a[1] * height - win.y) * scale.y} x2={(measure.b[0] * width - win.x) * scale.x} y2={(measure.b[1] * height - win.y) * scale.y} className="walk-measure-line" />
          ) : null}
        </svg>
        <button type="button" className="walk-scale" onClick={() => setMeasure(measure ? null : { a: null, b: null })} aria-pressed={measure !== null} data-testid="walk-measure">
          {measure ? "Cancel measuring" : scaleNote}
        </button>
        <button type="button" className="walk-play icon-btn" onClick={play} aria-label={playMs === null ? "Play the reveal" : "Stop"} data-testid="walk-play">
          {playMs === null ? <PlayIcon size={22} /> : <PauseIcon size={22} />}
        </button>
      </div>

      <div className="walk-bar">
        {measure ? (
          measure.a && measure.b ? (
            <div className="vibe-chips" role="group" aria-label="What did you measure?">
              {KNOWN_LENGTHS.map((k) => (
                <button key={k.id} type="button" className="vibe-chip" onClick={() => setLength(k.metres)}>
                  {k.label} · {k.metres} m
                </button>
              ))}
            </div>
          ) : (
            <p className="walk-hint">Tap both edges of a road or driveway on the ground.</p>
          )
        ) : (
          <>
            <div className="walk-size">
              <span className="walk-area">{area.text}</span>
              <span className="walk-dims">
                <button type="button" className="walk-step" onClick={() => resize("length", -1)} aria-label="Shorter">−</button>
                {pin.length} m
                <button type="button" className="walk-step" onClick={() => resize("length", 1)} aria-label="Longer">+</button>
                ×
                <button type="button" className="walk-step" onClick={() => resize("width", -1)} aria-label="Narrower">−</button>
                {pin.width} m
                <button type="button" className="walk-step" onClick={() => resize("width", 1)} aria-label="Wider">+</button>
              </span>
            </div>
            <p className="walk-hint">Drag the outline onto your site. Turn it by its handle; drag the sun to match the shadows.</p>
            <button type="button" className="btn btn-block" disabled={busy} onClick={() => (setBusy(true), void onMake(pin))} data-testid="walk-make">
              {busy ? "Drawing your reveal…" : "Make it · free"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
