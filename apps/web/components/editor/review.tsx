"use client";

import { useEffect, useRef, useState } from "react";
import {
  FILTERS,
  PACES,
  REEL_LENGTHS_S,
  currentLook,
  currentPace,
  timelineDurationMs,
  type Filter,
  type InstagramAudioTrack,
  type TextOverlay,
  type Timeline,
} from "@reelwalk/core";
import { FILTER_LABELS } from "@reelwalk/render/reel";
import { formatDuration } from "@/lib/format";
import { AskIcon, MusicIcon, PauseIcon, PlayIcon, TextIcon } from "../icons";
import { Sheet } from "../sheet";

/**
 * The draft review (ADR 0022). A reel made for you opens here, not in the
 * timeline: full screen, playing with its music, and under it the few things
 * people change: the text, the pace, the music, the look, or anything in
 * words. Export is in the corner for when it is right; the full editor is one
 * tap away for those who want it.
 */
export type ReviewChange = "text" | "timing" | "music" | "look" | "ask";

const CHANGES: { id: ReviewChange; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "timing", label: "Timing" },
  { id: "music", label: "Music" },
  { id: "look", label: "Look" },
  { id: "ask", label: "Ask" },
];

export function ReviewBar({ timeline, polishing = false, onChange, onFullEditor }: { timeline: Timeline; /** The model's cut is still on its way (ADR 0024). */ polishing?: boolean; onChange(change: ReviewChange): void; onFullEditor(): void }) {
  return (
    <div className="review-bar" data-testid="review-bar" data-polishing={polishing || undefined}>
      <p className="review-summary muted small">
        {formatDuration(timelineDurationMs(timeline))} · {timeline.clips.length} shots{timeline.music ? "" : " · no music yet"}.{" "}
        {polishing ? (
          <span className="review-polishing" data-testid="review-polishing">
            <span className="music-spinner" aria-hidden="true" /> Polishing with AI…
          </span>
        ) : (
          "Tap what you want different."
        )}
      </p>
      <div className="review-changes" role="group" aria-label="Change">
        {CHANGES.map((change) => (
          <button key={change.id} type="button" className="review-change" onClick={() => onChange(change.id)} data-testid={`review-${change.id}`}>
            {change.id === "text" ? <TextIcon size={20} /> : change.id === "music" ? <MusicIcon size={20} /> : change.id === "ask" ? <AskIcon size={20} /> : change.id === "timing" ? <ClockGlyph /> : <LookGlyph />}
            {change.label}
          </button>
        ))}
      </div>
      <button type="button" className="link review-full" onClick={onFullEditor} data-testid="review-full-editor">
        Open the full editor
      </button>
    </div>
  );
}

const ClockGlyph = () => (
  <svg className="icon" width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2.5 2.5M9 2.5h6" />
  </svg>
);
const LookGlyph = () => (
  <svg className="icon" width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <circle cx="9" cy="10" r="5.5" />
    <circle cx="15" cy="10" r="5.5" />
    <circle cx="12" cy="15" r="5.5" />
  </svg>
);

export function TimingChoices({ timeline, onPace, onLength, onClose }: { timeline: Timeline; onPace(shotMs: number): void; onLength(totalMs: number): void; onClose(): void }) {
  const pace = currentPace(timeline);
  const total = Math.round(timelineDurationMs(timeline) / 1000);
  return (
    <Sheet title="Timing" onClose={onClose}>
      <p className="muted small">How long each shot stays on screen. The cuts stay on the beat and the text moves with its shot.</p>
      <div className="choice-row">
        {PACES.map((choice) => (
          <button key={choice.id} type="button" className="choice" aria-pressed={pace === choice.id} onClick={() => onPace(choice.shotMs)} data-testid={`pace-${choice.id}`}>
            <strong>{choice.label}</strong>
            <span className="muted small">{choice.shotMs / 1000} s shots</span>
          </button>
        ))}
      </div>
      <p className="muted small">Or the whole reel's length (now {total} s):</p>
      <div className="choice-row">
        {REEL_LENGTHS_S.map((seconds) => (
          <button key={seconds} type="button" className="choice" aria-pressed={Math.abs(total - seconds) <= 1} onClick={() => onLength(seconds * 1000)} data-testid={`length-${seconds}`}>
            <strong>{seconds} s</strong>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function LookChoices({ timeline, onLook, onClose }: { timeline: Timeline; onLook(filter: Filter): void; onClose(): void }) {
  const look = currentLook(timeline);
  return (
    <Sheet title="Look" onClose={onClose}>
      <div className="choice-row choice-wrap">
        {FILTERS.map((filter) => (
          <button key={filter} type="button" className="choice" aria-pressed={look === filter} onClick={() => onLook(filter)} data-testid={`look-${filter}`}>
            <strong>{FILTER_LABELS[filter] ?? filter}</strong>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/** Each line of the reel's text: reword it, or take one of three suggestions. Room labels go on or off as a set. */
export function TextChoices({
  reelId,
  texts,
  roomLabels,
  canLabel,
  onText,
  onRoomLabels,
  onClose,
}: {
  reelId: string;
  texts: TextOverlay[];
  roomLabels: boolean;
  canLabel: boolean;
  onText(id: string, text: string): void;
  onRoomLabels(on: boolean): void;
  onClose(): void;
}) {
  const lines = texts.filter((text) => !text.id.startsWith("room-"));
  const [open, setOpen] = useState<string | null>(lines[0]?.id ?? null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [ideas, setIdeas] = useState<Record<string, string[] | "loading" | string>>({});

  async function suggest(line: TextOverlay) {
    setIdeas((current) => ({ ...current, [line.id]: "loading" }));
    const result = await fetch(`/api/reels/${reelId}/ideas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "text", text: draft[line.id] ?? line.text }) })
      .then((response) => response.json() as Promise<{ ok: true; options: string[] } | { ok: false; message: string }>)
      .catch(() => ({ ok: false as const, message: "Could not reach ReelWalk. Try again." }));
    setIdeas((current) => ({ ...current, [line.id]: result.ok ? result.options : result.message }));
  }

  return (
    <Sheet title="Text" onClose={onClose}>
      {lines.length === 0 ? <p className="muted small">This reel has no text of its own. Use Ask to add some, for example “Add Just listed at the start”.</p> : null}
      {lines.map((line) => {
        const value = draft[line.id] ?? line.text;
        const lineIdeas = ideas[line.id];
        return (
          <div key={line.id} className="text-choice" data-open={open === line.id || undefined}>
            <button type="button" className="text-choice-head" onClick={() => setOpen(open === line.id ? null : line.id)} aria-expanded={open === line.id}>
              <span>{line.text.replace(/\n/g, " ")}</span>
              <span className="muted small">{formatDuration(line.startMs)}</span>
            </button>
            {open === line.id ? (
              <div className="text-choice-body">
                <textarea className="text-area" rows={2} value={value} maxLength={200} onChange={(event) => setDraft({ ...draft, [line.id]: event.target.value })} data-testid="review-text-input" />
                <div className="choice-row">
                  <button type="button" className="btn btn-block" disabled={!value.trim() || value === line.text} onClick={() => onText(line.id, value.trim())} data-testid="review-text-save">
                    Use these words
                  </button>
                  <button type="button" className="btn btn-quiet btn-block" onClick={() => suggest(line)} disabled={lineIdeas === "loading"} data-testid="review-text-ideas">
                    {lineIdeas === "loading" ? "Thinking…" : "3 ideas"}
                  </button>
                </div>
                {Array.isArray(lineIdeas) ? (
                  <div className="choice-col">
                    {lineIdeas.map((idea) => (
                      <button
                        key={idea}
                        type="button"
                        className="choice choice-left"
                        onClick={() => {
                          setDraft({ ...draft, [line.id]: idea });
                          onText(line.id, idea);
                        }}
                      >
                        {idea}
                      </button>
                    ))}
                  </div>
                ) : typeof lineIdeas === "string" && lineIdeas !== "loading" ? (
                  <p className="error small">{lineIdeas}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {canLabel ? (
        <label className="check">
          <input type="checkbox" checked={roomLabels} onChange={(event) => onRoomLabels(event.target.checked)} data-testid="review-room-labels" />
          <span>Room names on each shot</span>
        </label>
      ) : null}
    </Sheet>
  );
}

type MusicIdea = { track: InstagramAudioTrack; mood: string | null };

/** Three Instagram songs of different moods, each to hear first; "Three more" moves on. */
export function MusicChoices({
  reelId,
  currentAudioId,
  busyId,
  onPick,
  onMore,
  onClose,
}: {
  reelId: string;
  currentAudioId: string | null;
  busyId: string | null;
  onPick(track: InstagramAudioTrack): void;
  /** The full Music sheet: search, chips, your own songs. */
  onMore(): void;
  onClose(): void;
}) {
  const [page, setPage] = useState(0);
  const [state, setState] = useState<{ step: "loading" } | { step: "ready"; ideas: MusicIdea[] } | { step: "error"; message: string }>({ step: "loading" });
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let live = true;
    setState({ step: "loading" });
    fetch(`/api/reels/${reelId}/ideas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "music", currentAudioId, page }) })
      .then((response) => response.json() as Promise<{ ok: true; music: MusicIdea[] } | { ok: false; message: string }>)
      .then((result) => live && setState(result.ok ? { step: "ready", ideas: result.music } : { step: "error", message: result.message }))
      .catch(() => live && setState({ step: "error", message: "Could not reach ReelWalk. Try again." }));
    return () => {
      live = false;
    };
  }, [reelId, currentAudioId, page]);

  useEffect(() => {
    const element = audio.current;
    return () => element?.pause();
  }, []);

  function preview(track: InstagramAudioTrack) {
    const element = audio.current;
    if (!element || !track.previewUrl) return;
    if (playing === track.id) {
      element.pause();
      setPlaying(null);
      return;
    }
    element.src = track.previewUrl;
    element.play().then(
      () => setPlaying(track.id),
      () => setPlaying(null),
    );
  }

  return (
    <Sheet title="Music" onClose={onClose}>
      <audio ref={audio} preload="none" onEnded={() => setPlaying(null)} onPause={() => setPlaying(null)} hidden />
      {busyId ? (
        <p className="music-loading" role="status">
          <span className="music-spinner" aria-hidden="true" />
          Adding it from Instagram and moving the cuts to its beat…
        </p>
      ) : null}
      {state.step === "loading" ? (
        <p className="music-loading">
          <span className="music-spinner" aria-hidden="true" />
          Finding three songs on Instagram…
        </p>
      ) : state.step === "error" ? (
        <p className="error small">{state.message}</p>
      ) : (
        <ul className="sound-list" data-testid="review-music-ideas">
          {state.ideas.map(({ track, mood }) => (
            <li key={track.id} className="sound-row">
              <button type="button" className="sound-pick" disabled={busyId !== null} onClick={() => onPick(track)} data-testid="review-music-pick">
                <span className="sound-meta">
                  <span className="sound-title">{track.title}</span>
                  <span className="muted small sound-artist">{busyId === track.id ? "Getting the sound…" : [track.artist, mood].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
              <button type="button" className="icon-btn sound-play" onClick={() => preview(track)} disabled={!track.previewUrl} aria-label={`${playing === track.id ? "Pause" : "Play"} ${track.title}`}>
                {playing === track.id ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="choice-row">
        {state.step === "error" ? null : (
          <button type="button" className="btn btn-quiet btn-block" onClick={() => setPage(page + 1)} disabled={state.step === "loading"} data-testid="review-music-more">
            Three more
          </button>
        )}
        <button type="button" className="btn btn-quiet btn-block" onClick={onMore}>
          Search Instagram
        </button>
      </div>
    </Sheet>
  );
}
