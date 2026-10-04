"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  acceptFor,
  canExport,
  captionFromDetails,
  DETAILS_PLACEMENTS,
  hasDetails,
  listingDetailsSchema,
  clipDurationMs,
  FILTERS,
  DEFAULT_PANO,
  MIN_CLIP_MS,
  MOTIONS,
  SPEEDS,
  TEXT_COLORS,
  TEXT_STYLES,
  type Clip,
  type Filter,
  type Issue,
  type ListingDetails,
  type Motion,
  type Music,
  type PanoView,
  type PlanOverlay,
  type TextOverlay,
  type TextStyle,
} from "@reelwalk/core";
import { FILTER_CSS, FILTER_LABELS, TEXT_STYLE_LABELS, textCss } from "@reelwalk/render/reel";
import { formatDuration } from "@/lib/format";
import type { LibraryAsset } from "@/lib/library";
import { saveCaption } from "@/app/actions";
import { CaptionEditor } from "../caption-editor";
import { AlertIcon, CloseIcon, PlusIcon } from "../icons";

// ── Shell ───────────────────────────────────────────────────────

export function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input, textarea, button:not(.sheet-close)")?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panel}>
        <span className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn sheet-close" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </>
  );
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  format = String,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange(value: T): void;
  format?: (value: T) => string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={String(option)} type="button" aria-pressed={option === value} onClick={() => onChange(option)}>
          {format(option)}
        </button>
      ))}
    </div>
  );
}

function Range({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange(value: number): void;
}) {
  const id = useId();
  return (
    <div className="field">
      <span className="field-row">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{display}</output>
      </span>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}

// ── Media ───────────────────────────────────────────────────────

type LibraryFilter = "all" | "360" | "video" | "photo";
const FILTER_NAMES: Record<LibraryFilter, string> = { all: "All", "360": "360 photos", video: "Videos", photo: "Photos" };

export function MediaSheet({
  library,
  onUpload,
  onPick,
  onClose,
}: {
  library: LibraryAsset[];
  onUpload(files: File[]): void;
  onPick(assets: LibraryAsset[]): void;
  onClose(): void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const everything = library.filter((asset) => asset.kind !== "AUDIO");
  const typeOf = (asset: LibraryAsset): LibraryFilter => (asset.isPano ? "360" : asset.kind === "VIDEO" ? "video" : "photo");
  const visual = filter === "all" ? everything : everything.filter((asset) => typeOf(asset) === filter);
  const filters = (["all", "360", "video", "photo"] as const).filter((name) => name === "all" || everything.some((asset) => typeOf(asset) === name));
  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  return (
    <Sheet title="Add photos and videos" onClose={onClose}>
      <label className="btn btn-signal btn-block picker-btn">
        <PlusIcon size={18} />
        Choose from your phone
        <input
          type="file"
          multiple
          accept={acceptFor(["IMAGE", "VIDEO"])}
          data-testid="add-media-input"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) onUpload(files);
          }}
        />
      </label>
      {everything.length > 0 ? (
        <>
          <p className="muted small">Or pick from your library. Tap in the order you want them.</p>
          {filters.length > 2 ? (
            <Segmented<LibraryFilter>
              label="Show"
              options={filters}
              value={filter}
              onChange={setFilter}
              format={(name) => FILTER_NAMES[name]}
            />
          ) : null}
          <div className="library-grid">
            {visual.map((asset) => {
              const order = picked.indexOf(asset.id);
              return (
                <button
                  key={asset.id}
                  type="button"
                  className="library-item"
                  aria-pressed={order >= 0}
                  aria-label={asset.fileName}
                  title={asset.credit ? `${asset.fileName} (${asset.credit})` : asset.fileName}
                  data-testid="library-item"
                  onClick={() => toggle(asset.id)}
                >
                  {asset.thumbUrl ? <img src={asset.thumbUrl} alt="" /> : null}
                  <span className="chip timecode">{order >= 0 ? order + 1 : asset.isPano ? "360" : asset.durationMs ? formatDuration(asset.durationMs) : "Photo"}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="btn btn-block"
            disabled={picked.length === 0}
            onClick={() => onPick(picked.map((id) => everything.find((asset) => asset.id === id)!))}
          >
            {picked.length === 0 ? "Select media to add" : `Add ${picked.length} to the reel`}
          </button>
        </>
      ) : null}
    </Sheet>
  );
}

// ── Clip tools ──────────────────────────────────────────────────

export function TrimSheet({
  clip,
  asset,
  onChange,
  onClose,
}: {
  clip: Clip;
  asset: LibraryAsset | undefined;
  onChange(window: { sourceStartMs: number; sourceEndMs: number }): void;
  onClose(): void;
}) {
  if (clip.kind === "IMAGE") {
    const duration = clip.sourceEndMs - clip.sourceStartMs;
    return (
      <Sheet title="Photo length" onClose={onClose}>
        <Range
          label="On screen for"
          value={duration}
          min={MIN_CLIP_MS}
          max={15_000}
          step={100}
          display={formatDuration(duration, true)}
          onChange={(value) => onChange({ sourceStartMs: 0, sourceEndMs: value })}
        />
      </Sheet>
    );
  }

  const sourceLength = Math.max(asset?.durationMs ?? clip.sourceEndMs, clip.sourceEndMs);
  const minWindow = Math.ceil(MIN_CLIP_MS * clip.speed);
  const pct = (ms: number) => `${(ms / sourceLength) * 100}%`;
  return (
    <Sheet title="Trim" onClose={onClose}>
      <div className="trim-clip">
        <div className="trim-strip" style={{ backgroundImage: asset?.thumbUrl ? `url("${asset.thumbUrl}")` : undefined }}>
          <span
            className="trim-window"
            style={{ left: pct(clip.sourceStartMs), width: `calc(${pct(clip.sourceEndMs - clip.sourceStartMs)})` }}
          />
        </div>
      </div>
      <Range
        label="Start"
        value={clip.sourceStartMs}
        min={0}
        max={sourceLength - minWindow}
        step={100}
        display={formatDuration(clip.sourceStartMs, true)}
        onChange={(value) => onChange({ sourceStartMs: value, sourceEndMs: Math.max(clip.sourceEndMs, value + minWindow) })}
      />
      <Range
        label="End"
        value={clip.sourceEndMs}
        min={minWindow}
        max={sourceLength}
        step={100}
        display={formatDuration(clip.sourceEndMs, true)}
        onChange={(value) => onChange({ sourceStartMs: Math.min(clip.sourceStartMs, value - minWindow), sourceEndMs: value })}
      />
      <p className="muted small">
        Plays for {formatDuration(clipDurationMs(clip), true)}
        {clip.speed !== 1 ? ` at ${clip.speed}×` : ""}, from a {formatDuration(sourceLength)} video.
      </p>
    </Sheet>
  );
}

export function SpeedSheet({ clip, onChange, onClose }: { clip: Clip; onChange(speed: number): void; onClose(): void }) {
  return (
    <Sheet title="Speed" onClose={onClose}>
      <Segmented label="Playback speed" options={SPEEDS} value={clip.speed as (typeof SPEEDS)[number]} onChange={onChange} format={(speed) => `${speed}×`} />
      <p className="muted small">
        The clip now plays for {formatDuration(clipDurationMs(clip), true)}. Faster clips suit walk-throughs; 0.5× suits a reveal.
      </p>
    </Sheet>
  );
}

export function VolumeSheet({ title, value, onChange, onClose }: { title: string; value: number; onChange(value: number): void; onClose(): void }) {
  return (
    <Sheet title={title} onClose={onClose}>
      <Range label="Volume" value={Math.round(value * 100)} min={0} max={100} step={5} display={`${Math.round(value * 100)}%`} onChange={(v) => onChange(v / 100)} />
      <Segmented label="Presets" options={[0, 50, 100] as const} value={Math.round(value * 100) as 0 | 50 | 100} onChange={(v) => onChange(v / 100)} format={(v) => (v === 0 ? "Mute" : `${v}%`)} />
    </Sheet>
  );
}

export function LookSheet({
  clip,
  asset,
  onChange,
  onApplyAll,
  onClose,
}: {
  clip: Clip;
  asset: LibraryAsset | undefined;
  onChange(filter: Filter): void;
  onApplyAll(): void;
  onClose(): void;
}) {
  return (
    <Sheet title="Look" onClose={onClose}>
      <div className="look-strip" role="group" aria-label="Colour filters">
        {FILTERS.map((filter) => (
          <button key={filter} type="button" className="look" aria-pressed={clip.filter === filter} onClick={() => onChange(filter)}>
            <span className="look-preview">
              {asset?.thumbUrl ? <img src={asset.thumbUrl} alt="" style={{ filter: FILTER_CSS[filter] }} /> : null}
            </span>
            {FILTER_LABELS[filter]}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-quiet btn-block" onClick={onApplyAll}>
        Use {FILTER_LABELS[clip.filter]} on every clip
      </button>
    </Sheet>
  );
}

const MOTION_LABELS: Record<Motion, string> = { none: "Still", "zoom-in": "Zoom in", "zoom-out": "Zoom out", pan: "Pan" };

export function MotionSheet({ clip, onChange, onClose }: { clip: Clip; onChange(motion: Motion): void; onClose(): void }) {
  return (
    <Sheet title="Photo motion" onClose={onClose}>
      <Segmented label="Motion" options={MOTIONS} value={clip.motion} onChange={onChange} format={(motion) => MOTION_LABELS[motion]} />
      <p className="muted small">A slow zoom or pan keeps a still photo of a room from looking frozen.</p>
    </Sheet>
  );
}

const SWEEPS = [
  { label: "Quarter turn", degrees: 90 },
  { label: "Half turn", degrees: 180 },
  { label: "Full spin", degrees: 360 },
] as const;

/** Camera move through a 360 photo. */
export function PanoSheet({
  clip,
  onChange,
  onPreview,
  onClose,
}: {
  clip: Clip;
  onChange(pano: PanoView | null): void;
  onPreview(): void;
  onClose(): void;
}) {
  const pano = clip.pano;
  if (!pano) {
    return (
      <Sheet title="360 view" onClose={onClose}>
        <p className="muted">This photo is shown flat. Turn on the 360 view to move a camera through the room.</p>
        <button type="button" className="btn btn-signal btn-block" onClick={() => onChange(DEFAULT_PANO)}>
          Show as 360
        </button>
      </Sheet>
    );
  }
  const turn = Math.round(pano.yawEnd - pano.yawStart);
  return (
    <Sheet title="360 view" onClose={onClose}>
      <Range
        label="Start looking"
        value={pano.yawStart}
        min={-180}
        max={180}
        step={5}
        display={`${pano.yawStart}°`}
        onChange={(yawStart) => onChange({ ...pano, yawStart, yawEnd: yawStart + turn })}
      />
      <Range
        label="Turn by"
        value={turn}
        min={-180}
        max={180}
        step={5}
        display={turn === 0 ? "Still" : `${Math.abs(turn)}° ${turn > 0 ? "right" : "left"}`}
        onChange={(degrees) => onChange({ ...pano, yawEnd: pano.yawStart + degrees })}
      />
      <div className="segmented" role="group" aria-label="Turn presets">
        {SWEEPS.map((sweep) => (
          <button
            key={sweep.degrees}
            type="button"
            aria-pressed={Math.abs(turn) === sweep.degrees}
            onClick={() => onChange({ ...pano, yawStart: Math.min(pano.yawStart, 360 - sweep.degrees), yawEnd: Math.min(pano.yawStart, 360 - sweep.degrees) + sweep.degrees })}
          >
            {sweep.label}
          </button>
        ))}
      </div>
      <Range
        label="Tilt"
        value={pano.pitch}
        min={-45}
        max={45}
        step={5}
        display={pano.pitch === 0 ? "Level" : `${Math.abs(pano.pitch)}° ${pano.pitch > 0 ? "up" : "down"}`}
        onChange={(pitch) => onChange({ ...pano, pitch })}
      />
      <Range
        label="Zoom"
        value={130 - pano.fov}
        min={10}
        max={90}
        step={5}
        display={pano.fov <= 65 ? "Close" : pano.fov >= 100 ? "Wide" : "Normal"}
        onChange={(value) => onChange({ ...pano, fov: 130 - value })}
      />
      <div className="segmented">
        <button type="button" onClick={onPreview}>
          Play this clip
        </button>
        <button type="button" onClick={() => onChange(null)}>
          Show flat instead
        </button>
      </div>
    </Sheet>
  );
}

export function TransitionSheet({
  clip,
  onChange,
  onClose,
}: {
  clip: Clip;
  onChange(transition: Clip["transitionIn"]): void;
  onClose(): void;
}) {
  return (
    <Sheet title="Transition in" onClose={onClose}>
      <Segmented
        label="Transition"
        options={["cut", "fade"] as const}
        value={clip.transitionIn}
        onChange={onChange}
        format={(transition) => (transition === "cut" ? "Cut" : "Fade through black")}
      />
    </Sheet>
  );
}

// ── Property details ────────────────────────────────────────────

const PLACEMENT_NAMES: Record<ListingDetails["placement"], string> = { end: "At the end", start: "At the start", both: "Both" };

export function DetailsSheet({
  reelId,
  details,
  onChange,
  onCaption,
  onClose,
}: {
  reelId: string;
  details: ListingDetails | null;
  onChange(details: ListingDetails | null): void;
  onCaption(caption: string): void;
  onClose(): void;
}) {
  const current = details ?? listingDetailsSchema.parse({});
  const set = (patch: Partial<ListingDetails>) => onChange({ ...current, ...patch });
  const field = (key: "price" | "beds" | "baths" | "area" | "address" | "contact", label: string, placeholder: string, max: number, mode?: "numeric") => (
    <label className="field">
      {label}
      <input className="text-input" value={current[key]} maxLength={max} placeholder={placeholder} inputMode={mode} onChange={(event) => set({ [key]: event.target.value })} />
    </label>
  );

  return (
    <Sheet title="Property details" onClose={onClose}>
      <p className="muted small">Shown as a card over the video. Leave a field empty to leave it off the card.</p>
      {field("price", "Price", "¥48,000,000", 24)}
      <div className="field-grid">
        {field("beds", "Beds", "3", 6, "numeric")}
        {field("baths", "Baths", "2", 6, "numeric")}
        {field("area", "Size", "92 m²", 16)}
      </div>
      {field("address", "Address or area", "Kanda, Chiyoda", 80)}
      {field("contact", "Contact", "@your_agency or a phone number", 60)}
      <div className="field">
        Show the card
        <Segmented<ListingDetails["placement"]> label="Show the card" options={DETAILS_PLACEMENTS} value={current.placement} onChange={(placement) => set({ placement })} format={(value) => PLACEMENT_NAMES[value]} />
      </div>
      <button
        type="button"
        className="btn btn-quiet btn-block"
        disabled={!hasDetails(current)}
        onClick={async () => {
          const caption = captionFromDetails(current);
          await saveCaption({ id: reelId, caption });
          onCaption(caption);
        }}
      >
        Write the post caption from these details
      </button>
    </Sheet>
  );
}

// ── Floor plan ──────────────────────────────────────────────────

export function PlanSheet({
  overlay,
  located,
  total,
  roomLabels,
  canLabel,
  onChange,
  onRoomLabels,
  onRemove,
  onClose,
}: {
  overlay: PlanOverlay;
  located: number;
  total: number;
  roomLabels: boolean;
  canLabel: boolean;
  onChange(patch: Partial<Pick<PlanOverlay, "corner" | "visible">>): void;
  onRoomLabels(on: boolean): void;
  onRemove(): void;
  onClose(): void;
}) {
  return (
    <Sheet title="Floor plan" onClose={onClose}>
      <p className="muted small">
        A marker on the floor plan shows where each shot was taken and which way the camera looks.{" "}
        {located === total ? "Every clip in this reel has a position." : `${located} of ${total} clips have a position; the marker waits at the last known one for the others.`}
      </p>
      <div className="field">
        Show on the video
        <Segmented<"on" | "off"> label="Show floor plan" options={["on", "off"]} value={overlay.visible ? "on" : "off"} onChange={(value) => onChange({ visible: value === "on" })} format={(value) => (value === "on" ? "Shown" : "Hidden")} />
      </div>
      <div className="field">
        Position
        <Segmented<PlanOverlay["corner"]>
          label="Position"
          options={["top-left", "top-right"]}
          value={overlay.corner}
          onChange={(corner) => onChange({ corner })}
          format={(corner) => (corner === "top-left" ? "Top left" : "Top right")}
        />
      </div>
      {canLabel ? (
        <div className="field">
          Room names
          <Segmented<"on" | "off"> label="Room names" options={["on", "off"]} value={roomLabels ? "on" : "off"} onChange={(value) => onRoomLabels(value === "on")} format={(value) => (value === "on" ? "Label each room" : "No labels")} />
        </div>
      ) : null}
      <button type="button" className="btn btn-quiet btn-block" onClick={onRemove}>
        Remove floor plan from this reel
      </button>
    </Sheet>
  );
}

// ── Text ────────────────────────────────────────────────────────

export type TextDraft = Pick<TextOverlay, "text" | "style" | "color" | "size">;

export function TextSheet({
  initial,
  onSave,
  onClose,
}: {
  initial: TextDraft | null;
  onSave(draft: TextDraft): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState<TextDraft>(initial ?? { text: "", style: "plain", color: "#ffffff", size: 1 });
  const previewCss = textCss(draft.style, draft.color, draft.size);

  return (
    <Sheet title={initial ? "Edit text" : "Add text"} onClose={onClose}>
      <textarea
        className="text-area"
        rows={2}
        maxLength={200}
        value={draft.text}
        placeholder="Just listed · 3LDK near Kanda Station"
        aria-label="Text to show"
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
      />
      <div className="text-style-preview" aria-hidden="true">
        <span style={{ ...previewCss, zoom: 0.32 }}>{draft.text || "Your text"}</span>
      </div>
      <Segmented label="Style" options={TEXT_STYLES} value={draft.style} onChange={(style: TextStyle) => setDraft({ ...draft, style })} format={(style) => TEXT_STYLE_LABELS[style]} />
      <div className="swatches" role="group" aria-label="Colour">
        {TEXT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className="swatch"
            aria-label={color}
            aria-pressed={draft.color === color}
            style={{ background: color }}
            onClick={() => setDraft({ ...draft, color })}
          />
        ))}
      </div>
      <Range label="Size" value={draft.size} min={0.5} max={2.5} step={0.1} display={`${Math.round(draft.size * 100)}%`} onChange={(size) => setDraft({ ...draft, size })} />
      <button type="button" className="btn btn-signal btn-block" disabled={!draft.text.trim()} onClick={() => onSave({ ...draft, text: draft.text.trim() })}>
        {initial ? "Save text" : "Add text"}
      </button>
    </Sheet>
  );
}

export function TimingSheet({
  text,
  totalMs,
  playheadMs,
  onChange,
  onClose,
}: {
  text: TextOverlay;
  totalMs: number;
  playheadMs: number;
  onChange(timing: { startMs: number; endMs: number }): void;
  onClose(): void;
}) {
  return (
    <Sheet title="Text timing" onClose={onClose}>
      <Range
        label="Appears at"
        value={text.startMs}
        min={0}
        max={Math.max(0, totalMs - 100)}
        step={100}
        display={formatDuration(text.startMs, true)}
        onChange={(startMs) => onChange({ startMs, endMs: Math.max(text.endMs, startMs + 100) })}
      />
      <Range
        label="Disappears at"
        value={text.endMs}
        min={100}
        max={totalMs}
        step={100}
        display={formatDuration(text.endMs, true)}
        onChange={(endMs) => onChange({ startMs: Math.min(text.startMs, endMs - 100), endMs })}
      />
      <div className="segmented">
        <button type="button" onClick={() => onChange({ startMs: Math.min(playheadMs, totalMs - 100), endMs: Math.max(text.endMs, playheadMs + 100) })}>
          Start at playhead
        </button>
        <button type="button" onClick={() => onChange({ startMs: Math.min(text.startMs, playheadMs - 100), endMs: Math.max(playheadMs, 100) })}>
          End at playhead
        </button>
        <button type="button" onClick={() => onChange({ startMs: 0, endMs: totalMs })}>
          Whole reel
        </button>
      </div>
    </Sheet>
  );
}

// ── Music ───────────────────────────────────────────────────────

export function MusicSheet({
  library,
  music,
  uploading,
  onPick,
  onSnap,
  onUpload,
  onChange,
  onRemove,
  onClose,
}: {
  library: LibraryAsset[];
  music: Music | null;
  uploading: boolean;
  onPick(asset: LibraryAsset): void;
  /** Move every cut onto a beat of the song. */
  onSnap(): void;
  onUpload(file: File): void;
  onChange(patch: Partial<Music>): void;
  onRemove(): void;
  onClose(): void;
}) {
  const tracks = library.filter((asset) => asset.kind === "AUDIO");
  const current = music ? library.find((asset) => asset.id === music.assetId) : undefined;
  return (
    <Sheet title="Music" onClose={onClose}>
      {music ? (
        <>
          <p>
            <strong>{current?.fileName ?? "Track"}</strong>
          </p>
          <Range
            label="Music volume"
            value={Math.round(music.volume * 100)}
            min={0}
            max={100}
            step={5}
            display={`${Math.round(music.volume * 100)}%`}
            onChange={(value) => onChange({ volume: value / 100 })}
          />
          {current?.durationMs ? (
            <Range
              label="Start the song at"
              value={music.sourceStartMs}
              min={0}
              max={Math.max(0, current.durationMs - 1000)}
              step={500}
              display={formatDuration(music.sourceStartMs)}
              onChange={(sourceStartMs) => onChange({ sourceStartMs })}
            />
          ) : null}
          {music.bpm ? (
            <button type="button" className="btn btn-signal btn-block" onClick={onSnap} data-testid="snap-to-beat">
              Snap cuts to the beat ({Math.round(music.bpm)} bpm)
            </button>
          ) : (
            <p className="muted small">No steady beat was found in this song, so cuts cannot snap to it.</p>
          )}
          <button type="button" className="btn btn-quiet btn-block" onClick={onRemove}>
            Remove music
          </button>
        </>
      ) : null}

      <label className="btn btn-block picker-btn" data-busy={uploading}>
        <PlusIcon size={18} />
        {uploading ? "Uploading…" : music ? "Use a different song" : "Choose a song"}
        <input
          type="file"
          accept={acceptFor(["AUDIO"])}
          disabled={uploading}
          data-testid="music-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onUpload(file);
          }}
        />
      </label>
      {tracks.length > 0 ? (
        <div className="segmented" role="group" aria-label="Your songs">
          {tracks.map((track) => (
            <button key={track.id} type="button" aria-pressed={music?.assetId === track.id} onClick={() => onPick(track)}>
              {track.fileName}
            </button>
          ))}
        </div>
      ) : null}
      <p className="muted small">
        Use music you have the rights to. Instagram can mute reels that use copyrighted songs; its own music library is
        added when you post in the app.
      </p>
    </Sheet>
  );
}

// ── Caption and export ──────────────────────────────────────────

export function CaptionSheet({
  reelId,
  caption,
  onChange,
  onClose,
}: {
  reelId: string;
  caption: string;
  onChange(caption: string): void;
  onClose(): void;
}) {
  return (
    <Sheet title="Post caption" onClose={onClose}>
      <p className="muted small">The text for your Instagram post. It is copied for you when you share the video.</p>
      <CaptionEditor reelId={reelId} initial={caption} onChange={onChange} />
    </Sheet>
  );
}

export function ExportSheet({
  issues,
  durationMs,
  busy,
  error,
  onExport,
  onShowIssue,
  onClose,
}: {
  issues: Issue[];
  durationMs: number;
  busy: boolean;
  error: string | null;
  onExport(): void;
  onShowIssue(issue: Issue): void;
  onClose(): void;
}) {
  const ready = canExport(issues);
  return (
    <Sheet title={ready ? "Export for Instagram" : "Not ready to export"} onClose={onClose}>
      <p className="muted">
        {formatDuration(durationMs, true)} reel, rendered as a 1080×1920 MP4 at 30 fps. You can keep editing while it renders.
      </p>
      {issues.length > 0 ? (
        <ul className="issue-list">
          {issues.map((issue) => (
            <li key={`${issue.code}-${issue.textId ?? ""}`} className="issue" data-level={issue.level}>
              <AlertIcon size={18} />
              <span>
                {issue.message}
                {issue.textId ? (
                  <>
                    {" "}
                    <button type="button" className="btn btn-quiet" style={{ minHeight: 30, marginTop: 6 }} onClick={() => onShowIssue(issue)}>
                      Show me
                    </button>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <button type="button" className="btn btn-signal btn-block" disabled={!ready || busy} onClick={onExport} data-testid="confirm-export">
        {busy ? "Starting export…" : "Export video"}
      </button>
    </Sheet>
  );
}
