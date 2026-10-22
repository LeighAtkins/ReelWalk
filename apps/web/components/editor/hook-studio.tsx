"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Player } from "@remotion/player";
import { HOOK_FRAME_MS, openingMoments, REEL_FORMAT, type Command, type HookPattern, type Timeline } from "@reelwalk/core";
import { ReelComposition, reelDurationInFrames, type ReelAsset } from "@reelwalk/render/reel";
import type { LibraryAsset } from "@/lib/library";
import { timelineFrames } from "./frame-service";
import { emptyMeasure, measureOpenings, type OpeningMeasure } from "./hook-motion";
import { hookCommand, initialPattern, studioCards } from "./hook-studio-cards";

/** The cards loop the first 1.5 s. */
const CARD_FRAMES = Math.round((1.5 * REEL_FORMAT.fps));
const STRIP_WIDTH = 72, STRIP_HEIGHT = 128;

/**
 * The Hook studio (ADR 0068): the five patterns as live cards, each playing
 * the reel's first 1.5 s under that pattern from the shared composition; a
 * strip of the chosen one's frames at 0, 0.5, 1.0 and 1.5 s with the rules
 * it passes; the hook line and the promise; one tap applies it as one
 * command (one undo). "Write me 5 hooks" asks the ideas route for lines.
 */
export function HookStudio({ timeline, assets, library, reelId, headline, wantLines = null, onApply, onClose }: {
  timeline: Timeline;
  assets: Record<string, ReelAsset>;
  library: Record<string, LibraryAsset>;
  reelId: string;
  headline: string | null;
  /** Lines were asked for in the Ask box ("write me 5 hooks"): fetch that many as the studio opens. */
  wantLines?: number | null;
  /** Runs the command through the document; true when it landed. */
  onApply(command: Command): boolean;
  onClose(): void;
}) {
  const [line, setLine] = useState(timeline.opening?.titles[0] ?? "");
  const [promise, setPromise] = useState(timeline.opening?.promise ?? "");
  const [measure, setMeasure] = useState<OpeningMeasure>(emptyMeasure);
  const [measuring, setMeasuring] = useState(true);
  const [lines, setLines] = useState<string[]>([]);
  const [linesState, setLinesState] = useState<"idle" | "busy" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  // Motion and brightness of every clip's opening, once per visit; the cards re-plan as it lands.
  useEffect(() => {
    let live = true;
    measureOpenings(timeline, library, emptyMeasure(), () => live)
      .then((measured) => { if (live) setMeasure(measured); })
      .catch(() => undefined)
      .finally(() => { if (live) setMeasuring(false); });
    return () => { live = false; };
    // Once: the sheet is remounted when the reel changes under it.
  }, []);

  const studio = useMemo(() => ({ line, promise, headline, measure }), [line, promise, headline, measure]);
  const cards = useMemo(() => studioCards(timeline, library, studio), [timeline, library, studio]);
  const [pattern, setPattern] = useState<HookPattern>(() => initialPattern(timeline, cards));
  const chosen = cards.find((card) => card.pattern === pattern) ?? cards[0];

  async function writeLines(count: number) {
    setLinesState("busy");
    try {
      const rooms = [...new Set(timeline.clips.map((clip) => clip.room).filter((room): room is string => Boolean(room)))];
      const titles = timeline.texts.filter((text) => !text.id.startsWith("room-") && !text.id.startsWith("hook-")).map((text) => text.text).slice(0, 12);
      const response = await fetch(`/api/reels/${reelId}/ideas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "hooks", count, rooms, titles }) });
      const data = (await response.json()) as { ok: true; lines: string[] } | { ok: false; message: string };
      if (!data.ok) throw new Error(data.message);
      setLines(data.lines);
      setLinesState("idle");
    } catch {
      setLinesState("failed");
    }
  }

  // Asked for from the Ask box: fetch as the studio opens.
  const asked = useRef(false);
  useEffect(() => {
    if (!wantLines || asked.current) return;
    asked.current = true;
    void writeLines(wantLines);
  }, [wantLines]);

  function apply() {
    if (!chosen.plan) return;
    setError(null);
    if (onApply(hookCommand(chosen.pattern, library, studio))) onClose();
    else setError("That opening could not be made. Try another pattern.");
  }

  return (
    <div className="hook-studio" data-testid="hook-studio">
      <p className="muted small">The first three seconds decide whether anyone stays. Each card plays the opening under one pattern; tap one, then Use it. Undo takes it back.</p>
      <div className="hook-cards" role="radiogroup" aria-label="Hook pattern">
        {cards.map((card) => (
          <button key={card.pattern} type="button" role="radio" aria-checked={card.pattern === pattern} className="hook-card" disabled={!card.plan} onClick={() => setPattern(card.pattern)} data-testid={`hook-card-${card.pattern}`}>
            <span className="hook-card-stage" aria-hidden="true">
              {card.plan ? <CardPlayer timeline={card.plan.timeline} assets={assets} /> : <span className="hook-card-off">—</span>}
            </span>
            <strong>{card.label}</strong>
            <span className="small">{card.plan ? `${card.passes}/${card.judged} rules` : card.unavailable}</span>
          </button>
        ))}
      </div>
      {chosen.plan ? (
        <>
          <p className="small hook-note" data-testid="hook-note">{chosen.description} {chosen.plan.note}</p>
          <FrameStrip key={`${chosen.pattern}-${Object.keys(measure.motion).length}`} timeline={chosen.plan.timeline} assets={assets} />
          <ul className="hook-rules" aria-label="Hook rules">
            {chosen.rules.map((rule, index) => (
              <li key={`${rule.rule}-${index}`} data-ok={rule.unknown ? "unknown" : rule.ok ? "yes" : "no"}>{rule.reason}</li>
            ))}
          </ul>
        </>
      ) : null}
      <label className="field">Hook line<input className="text-input" value={line} maxLength={80} placeholder={chosen.pattern === "question" ? "Would you live here?" : "Wait for the garden"} onChange={(event) => setLine(event.target.value)} data-testid="hook-line" /></label>
      {lines.length > 0 ? (
        <div className="ask-examples" aria-label="Hook lines">
          {lines.map((option) => (
            <button key={option} type="button" className="chip chip-btn" aria-pressed={option === line} onClick={() => setLine(option)}>{option}</button>
          ))}
        </div>
      ) : null}
      <button type="button" className="btn btn-quiet btn-block" disabled={linesState === "busy"} onClick={() => writeLines(5)} data-testid="hook-write-lines">
        {linesState === "busy" ? "Writing…" : lines.length ? "Write 5 more" : "Write me 5 hooks"}
      </button>
      {linesState === "failed" ? <p className="error" role="alert">No hooks came back. Try again.</p> : null}
      <label className="field">What they get by staying<input className="text-input" value={promise} maxLength={120} placeholder="Every room in 15 seconds" onChange={(event) => setPromise(event.target.value)} data-testid="hook-promise" /></label>
      {measuring ? <p className="muted small" role="status">Measuring how each shot moves…</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <button type="button" className="btn btn-signal btn-block" disabled={!chosen.plan} onClick={apply} data-testid="hook-use">
        {timeline.opening ? `Use ${chosen.label}` : `Use ${chosen.label} as the opening`}
      </button>
      {timeline.opening ? (
        <button type="button" className="btn btn-quiet btn-block" onClick={() => { if (onApply({ type: "hook", pattern: null })) onClose(); }} data-testid="hook-remove">
          Take the opening out
        </button>
      ) : null}
    </div>
  );
}

/** The first 1.5 s under one pattern, looping, from the shared composition. */
function CardPlayer({ timeline, assets }: { timeline: Timeline; assets: Record<string, ReelAsset> }) {
  const total = reelDurationInFrames(timeline, REEL_FORMAT.fps);
  return (
    <Player
      component={ReelComposition}
      inputProps={{ timeline, assets }}
      durationInFrames={total}
      inFrame={0}
      outFrame={Math.min(total - 1, CARD_FRAMES)}
      fps={REEL_FORMAT.fps}
      compositionWidth={REEL_FORMAT.width}
      compositionHeight={REEL_FORMAT.height}
      style={{ width: "100%", height: "100%" }}
      controls={false}
      clickToPlay={false}
      autoPlay
      loop
      initiallyMuted
      acknowledgeRemotionLicense
    />
  );
}

/** The chosen opening at 0, 0.5, 1.0 and 1.5 s: the footage through the frame service, the titles as labels. */
function FrameStrip({ timeline, assets }: { timeline: Timeline; assets: Record<string, ReelAsset> }) {
  const moments = useMemo(() => openingMoments(timeline), [timeline]);
  const [thumbs, setThumbs] = useState<Record<number, string | null>>({});
  useEffect(() => {
    let live = true;
    const service = timelineFrames(timeline, assets);
    (async () => {
      for (const moment of moments) {
        const canvas = await service.frameAt(moment.clipId, moment.sourceMs, { width: STRIP_WIDTH, height: STRIP_HEIGHT, purpose: "view" }).catch(() => null);
        if (!live) return;
        let url: string | null = null;
        try { url = canvas ? canvas.toDataURL("image/jpeg", 0.7) : null; } catch { url = null; }
        setThumbs((current) => ({ ...current, [moment.atMs]: url }));
      }
    })();
    return () => { live = false; };
  }, [timeline, assets, moments]);
  return (
    <div className="hook-strip" aria-label="Opening frames" data-testid="hook-strip">
      {HOOK_FRAME_MS.map((atMs) => {
        const moment = moments.find((m) => m.atMs === atMs);
        const thumb = thumbs[atMs];
        return (
          <figure key={atMs} className="hook-frame">
            <span className="hook-frame-pic">
              {thumb ? <img src={thumb} alt="" /> : null}
              {moment?.texts.map((text) => (
                <span key={text.id} className="hook-frame-title" style={{ left: `${text.x * 100}%`, top: `${text.y * 100}%` }}>{text.text}</span>
              ))}
            </span>
            <figcaption className="small">{(atMs / 1000).toFixed(1)} s</figcaption>
          </figure>
        );
      })}
    </div>
  );
}
