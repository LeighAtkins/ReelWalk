"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  instagramAudioLabel,
  instagramAudioMix,
  INSTAGRAM_AUDIO_QUERY_MAX,
  type InstagramAudioChoice,
  type InstagramAudioTrack,
  type InstagramAudioType,
} from "@reelwalk/core";
import { searchInstagramSounds } from "@/app/instagram-audio-actions";
import { formatDuration } from "@/lib/format";
import { CheckIcon, CloseIcon, MusicIcon, PauseIcon, PlayIcon } from "./icons";
import { Sheet } from "./sheet";

export const SOUND_TABS: { type: InstagramAudioType; label: string; placeholder: string }[] = [
  { type: "music", label: "Music", placeholder: "Search Instagram's music" },
  { type: "original_sound", label: "Trending sounds", placeholder: "Search sounds or paste an audio link" },
];

type Search = { step: "loading" } | { step: "ready"; tracks: InstagramAudioTrack[] } | { step: "error"; error: string };

/**
 * Picks a sound from Instagram's own licensed library (ADR 0018) for a post.
 * Instagram mixes it in when it publishes, so the reel with the sound cannot
 * be previewed here; the sound alone can.
 *
 * `value` is the chosen sound or null; the button shows it, and a cross
 * clears it. Used by the export screen (Post now and Schedule share one) and
 * by each upcoming row on /scheduled.
 */
export function InstagramSoundPicker({
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: InstagramAudioChoice | null;
  onChange(choice: InstagramAudioChoice | null): void;
  disabled?: boolean;
  /** A small "Sound" button for list rows, instead of the full-width one. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const label = value ? instagramAudioLabel(value) : null;

  return (
    <div className={compact ? "sound-control sound-control-compact" : "sound-control"} data-testid="sound-control" data-audio-id={value?.audioId ?? ""}>
      <button
        type="button"
        className={`btn btn-quiet sound-button${value ? " sound-button-set" : ""}`}
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-label={label ? `Instagram sound: ${label}. Change` : "Add an Instagram sound"}
        data-testid="sound-open"
      >
        <MusicIcon size={18} />
        <span className="sound-button-text" data-testid="sound-chosen">
          {label ?? (compact ? "Sound" : "Add Instagram sound")}
        </span>
      </button>
      {value ? (
        <button type="button" className="icon-btn sound-clear" aria-label={`Remove the sound ${label}`} onClick={() => onChange(null)} disabled={disabled} data-testid="sound-clear">
          <CloseIcon size={18} />
        </button>
      ) : null}
      {open ? (
        <SoundSheet
          value={value}
          onClose={close}
          onPick={(choice) => {
            onChange(choice);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function SoundSheet({ value, onClose, onPick }: { value: InstagramAudioChoice | null; onClose(): void; onPick(choice: InstagramAudioChoice): void }) {
  const [type, setType] = useState<InstagramAudioType>("music");
  const [selected, setSelected] = useState<{ audioId: string; title: string; artist: string | null } | null>(
    value ? { audioId: value.audioId, title: value.title, artist: value.artist } : null,
  );
  const [keepReelAudio, setKeepReelAudio] = useState(value ? value.videoVolume > 0 : false);
  const keepId = useId();

  function confirm() {
    if (!selected) return;
    onPick({ ...selected, ...instagramAudioMix(keepReelAudio) });
  }

  return (
    <Sheet title="Instagram sound" onClose={onClose}>
      <div className="segmented" role="group" aria-label="Kind of sound">
        {SOUND_TABS.map((entry) => (
          <button
            key={entry.type}
            type="button"
            aria-pressed={entry.type === type}
            onClick={() => setType(entry.type)}
            data-testid={entry.type === "music" ? "sound-tab-music" : "sound-tab-trending"}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <InstagramSoundBrowser
        type={type}
        selectedId={selected?.audioId ?? null}
        onSelect={(track) => setSelected({ audioId: track.id, title: track.title, artist: track.artist })}
        hint="Instagram adds the sound when it publishes; tap play to hear the sound on its own."
      />

      <label className="check" htmlFor={keepId}>
        <input id={keepId} type="checkbox" checked={keepReelAudio} onChange={(event) => setKeepReelAudio(event.target.checked)} data-testid="sound-keep-reel" />
        <span>
          Keep my reel&apos;s own music under it
          <span className="muted small" style={{ display: "block" }}>
            {keepReelAudio ? "Your reel's soundtrack stays, quieter, under the Instagram sound." : "The Instagram sound replaces your reel's soundtrack."}
          </span>
        </span>
      </label>

      <button type="button" className="btn btn-signal btn-block sheet-sticky" onClick={confirm} disabled={!selected} data-testid="sound-confirm">
        {selected ? `Use “${selected.title}”` : "Pick a sound"}
      </button>
    </Sheet>
  );
}

/**
 * Search box and results for one kind of Instagram sound, each with cover
 * art, title, artist, length and a play button. Shared by the export
 * screen's picker and the editor's Music sheet. Previews play Instagram's
 * own preview link in an <audio> element (no CORS needed to play it); only
 * one plays at a time, and nothing keeps playing once this is closed.
 */
export function InstagramSoundBrowser({
  type,
  selectedId,
  busyId = null,
  disabled = false,
  onSelect,
  hint,
}: {
  type: InstagramAudioType;
  selectedId: string | null;
  /** A sound being fetched after it was picked; its row says so. */
  busyId?: string | null;
  disabled?: boolean;
  onSelect(track: InstagramAudioTrack): void;
  /** One line under the search box about what picking does here. */
  hint: string;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<Search>({ step: "loading" });
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const request = useRef(0);
  const tab = SOUND_TABS.find((entry) => entry.type === type)!;

  // Searches after a short pause in typing; an answer to an older search is dropped.
  useEffect(() => {
    const id = ++request.current;
    setSearch({ step: "loading" });
    const timer = setTimeout(
      async () => {
        const result = await searchInstagramSounds({ type, query }).catch(() => ({ ok: false as const, error: "Could not reach ReelWalk. Try again." }));
        if (id !== request.current) return;
        setSearch(result.ok ? { step: "ready", tracks: result.tracks } : { step: "error", error: result.error });
      },
      query ? 350 : 0,
    );
    return () => clearTimeout(timer);
  }, [type, query]);

  // Nothing keeps playing once the list is gone.
  useEffect(() => {
    const element = audio.current;
    return () => element?.pause();
  }, []);

  function togglePreview(track: InstagramAudioTrack) {
    const element = audio.current;
    if (!element || !track.previewUrl) return;
    if (playing === track.id) {
      element.pause();
      setPlaying(null);
      return;
    }
    // One <audio> for the whole list, so only one sound plays at a time.
    element.src = track.previewUrl;
    element.play().then(
      () => setPlaying(track.id),
      () => setPlaying(null),
    );
  }

  return (
    <>
      <input
        className="text-input"
        type="search"
        inputMode="search"
        enterKeyHint="search"
        maxLength={INSTAGRAM_AUDIO_QUERY_MAX}
        placeholder={tab.placeholder}
        aria-label={tab.placeholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        data-testid="sound-search"
      />

      <p className="muted small sound-hint">
        {query.trim() ? "Results from Instagram's library." : type === "music" ? "Trending in Instagram's music for business accounts." : "Trending creator sounds."} {hint}
      </p>

      <audio ref={audio} preload="none" onEnded={() => setPlaying(null)} onPause={() => setPlaying(null)} hidden />

      <div aria-live="polite" aria-busy={search.step === "loading"} data-testid="sound-results" data-state={search.step}>
        {search.step === "loading" ? (
          <p className="muted small">Looking…</p>
        ) : search.step === "error" ? (
          <p className="error small" role="alert" data-testid="sound-error">
            {search.error}
          </p>
        ) : search.tracks.length === 0 ? (
          <p className="muted small" data-testid="sound-empty">
            Nothing found. Try another word, or clear the search for what is trending.
          </p>
        ) : (
          <ul className="sound-list" aria-label={`${tab.label} results`}>
            {search.tracks.map((track) => {
              const isSelected = selectedId === track.id;
              const isBusy = busyId === track.id;
              return (
                <li key={track.id} className="sound-row" data-selected={isSelected || undefined}>
                  <button
                    type="button"
                    className="sound-pick"
                    aria-pressed={isSelected}
                    aria-busy={isBusy || undefined}
                    disabled={disabled}
                    onClick={() => onSelect(track)}
                    data-testid="sound-option"
                    data-audio-id={track.id}
                  >
                    <span className="sound-cover" aria-hidden="true">
                      {track.coverUrl ? <img src={track.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <MusicIcon size={20} />}
                      {isSelected ? (
                        <span className="sound-tick">
                          <CheckIcon size={16} />
                        </span>
                      ) : null}
                    </span>
                    <span className="sound-meta">
                      <span className="sound-title">{track.title}</span>
                      <span className="muted small sound-artist">
                        {isBusy ? (
                          "Getting the sound…"
                        ) : (
                          <>
                            {track.artist ?? "Unknown artist"}
                            {track.durationMs ? <span className="timecode"> · {formatDuration(track.durationMs)}</span> : null}
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn sound-play"
                    onClick={() => togglePreview(track)}
                    disabled={!track.previewUrl}
                    aria-label={`${playing === track.id ? "Pause" : "Play"} a preview of ${track.title}`}
                    title={track.previewUrl ? undefined : "No preview for this sound"}
                    data-testid="sound-preview"
                  >
                    {playing === track.id ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
