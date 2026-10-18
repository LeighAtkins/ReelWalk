"use client";

import { useId, useRef, useState, type CSSProperties } from "react";
import {
  acceptFor,
  canExport,
  captionFromDetails,
  CORNERS,
  DETAILS_PLACEMENTS,
  fitTextSize,
  hasDetails,
  listingDetailsSchema,
  clipDurationMs,
  clipSourceAvailability,
  FILTERS,
  DEFAULT_PANO,
  INSTAGRAM_MUSIC_SUGGESTIONS,
  ROOM_NAMES,
  formatArea,
  formatPrice,
  isInstagramMusic,
  MIN_CLIP_MS,
  minTextSize,
  MOTIONS,
  SPEEDS,
  TEXT_ANIMATIONS,
  TEXT_COLORS,
  TEXT_SIZE_MAX,
  TEXT_STYLES,
  ZOOM_MAX,
  type Clip,
  type Corner,
  type Filter,
  type Logo,
  type InstagramAudioTrack,
  type InstagramAudioType,
  type Issue,
  type ListingDetails,
  type Motion,
  type Music,
  type PanoView,
  type PlanOverlay,
  type TextAnimation,
  type TextOverlay,
  type TextStyle,
} from "@reelwalk/core";
import { ClipSourceInfo } from "./clip-source-info";
import { ELEGANT_FONT_FAMILY, FILTER_CSS, FILTER_LABELS, TEXT_ANIMATION_LABELS, TEXT_STYLE_LABELS, textTreatmentCss } from "@reelwalk/render/reel";
import { formatDuration } from "@/lib/format";
import type { LibraryAsset } from "@/lib/library";
import Link from "next/link";
import { saveCaption } from "@/app/actions";
import { CaptionEditor } from "../caption-editor";
import { AlertIcon, CloseIcon, InstagramIcon, PlusIcon } from "../icons";
import { InstagramSoundBrowser } from "../instagram-sound-picker";
import { Sheet } from "../sheet";

// ── Shell ───────────────────────────────────────────────────────

// The shell lives in ../sheet so screens outside the editor can use it.
export { Sheet };

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  format = String,
  optionStyle,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange(value: T): void;
  format?: (value: T) => string;
  /** Lets an option show what it does, such as a text style in its own typeface. */
  optionStyle?: (value: T) => CSSProperties | undefined;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={String(option)} type="button" aria-pressed={option === value} style={optionStyle?.(option)} onClick={() => onChange(option)}>
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

/**
 * A rough render time for the export sheet: about a minute to start a
 * machine, then roughly ten seconds of rendering per second of reel.
 */
function renderMinutes(durationMs: number): string {
  const minutes = Math.max(2, Math.round(1 + (durationMs / 1000) * (10 / 60)));
  return `${minutes} minutes`;
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
      <label className="btn btn-block picker-btn">
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
                  {asset.isAiGenerated ? <span className="library-ai-badge ai-source-badge">AI</span> : null}
                  <span className="chip timecode">{order >= 0 ? order + 1 : asset.isPano ? "360" : asset.durationMs ? formatDuration(asset.durationMs) : "Photo"}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="btn btn-block sheet-sticky"
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

  const available = clipSourceAvailability(clip, asset?.durationMs);
  const sourceLength = Math.max(asset?.durationMs ?? clip.sourceEndMs, clip.sourceEndMs);
  const minWindow = Math.ceil(MIN_CLIP_MS * clip.speed);
  const pct = (ms: number) => `${(ms / sourceLength) * 100}%`;
  return (
    <Sheet title={asset?.isAiGenerated ? "Trim AI shot" : "Trim"} onClose={onClose}>
      <ClipSourceInfo clip={clip} asset={asset} />
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
      {available.sourceMs !== null && (available.beforeMs > 0 || (available.afterMs ?? 0) > 0) ? (
        <button type="button" className="btn btn-block" onClick={() => onChange({ sourceStartMs: 0, sourceEndMs: available.sourceMs! })}>Use full source</button>
      ) : null}
      {asset?.isAiGenerated ? <p className="muted small">Unused footage uses no new AI credits. Preview it before extending; it may contain changes. Going beyond the full source requires a new generation.</p> : null}
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
  onLens,
  onLuxury,
  onClose,
}: {
  clip: Clip;
  asset: LibraryAsset | undefined;
  onChange(filter: Filter): void;
  onApplyAll(): void;
  onLens?(value: number): void;
  onLuxury?(variant: "refined" | "modern"): void;
  onClose(): void;
}) {
  return (
    <Sheet title="Look" onClose={onClose}>
      {onLuxury ? <div className="field"><span>Finish the whole reel</span><div className="segmented">
        <button type="button" onClick={() => onLuxury("refined")}>Refined luxury</button>
        <button type="button" onClick={() => onLuxury("modern")}>Modern luxury</button>
      </div><p className="muted small">Adds text contrast, one snap zoom, matching colour and soft lens edges. Keeps your text size and typeface. Keeps your clips and timing. Undo restores the previous edit.</p></div> : null}
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
      {onLens ? <Range label="Soft lens edges" value={clip.lensSoftness ?? 0} min={0} max={1} step={0.05} display={`${Math.round((clip.lensSoftness ?? 0) * 100)}%`} onChange={onLens} /> : null}
    </Sheet>
  );
}

const MOTION_LABELS: Record<Motion, string> = { none: "Still", "zoom-in": "Zoom in", "zoom-out": "Zoom out", pan: "Pan", "snap-in": "Snap in", "snap-out": "Snap out" };

/** A closer crop of one shot, about its centre. */
export function ZoomSheet({ clip, onChange, onClose }: { clip: Clip; onChange(zoom: number): void; onClose(): void }) {
  return (
    <Sheet title="Zoom" onClose={onClose}>
      <Range label="Closer" value={clip.zoom} min={1} max={ZOOM_MAX} step={0.05} display={clip.zoom === 1 ? "Whole picture" : `${Math.round(clip.zoom * 100)}%`} onChange={onChange} />
      <p className="muted small">Crops into the middle of the shot. Any zoom or pan motion still plays on top of it.</p>
      <button type="button" className="btn btn-quiet btn-block" disabled={clip.zoom === 1} onClick={() => onChange(1)}>
        Show the whole picture
      </button>
    </Sheet>
  );
}

const CORNER_NAMES: Record<Corner, string> = { "top-left": "Top left", "top-right": "Top right", "bottom-left": "Bottom left", "bottom-right": "Bottom right" };

/** The agency's or agent's logo in a corner for the whole reel: pick an image from the library or upload one. */
export function LogoSheet({
  library,
  logo,
  onChange,
  onUpload,
  onClose,
}: {
  library: LibraryAsset[];
  logo: Logo | null;
  onChange(logo: Logo | null): void;
  onUpload(file: File): Promise<LibraryAsset>;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Your own stills (library media with a credit line belongs to someone else).
  const images = library.filter((asset) => asset.kind === "IMAGE" && !asset.isPano && !asset.credit);
  const current = logo ?? { assetId: "", corner: "top-right" as Corner, size: 0.2 };
  return (
    <Sheet title="Logo" onClose={onClose}>
      <p className="muted small">A logo or headshot stays in one corner for the whole reel, inside the area Instagram leaves clear. A PNG with a transparent background looks best.</p>
      <label className="btn btn-quiet btn-block">
        {busy ? "Uploading…" : "Upload a logo"}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          disabled={busy}
          data-testid="logo-input"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setError(null);
            try {
              const asset = await onUpload(file);
              onChange({ ...current, assetId: asset.id });
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "Could not upload that.");
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {error ? <p className="error small">{error}</p> : null}
      {images.length > 0 ? (
        <div className="look-strip" role="group" aria-label="Your images">
          {images.slice(0, 24).map((asset) => (
            <button key={asset.id} type="button" className="look" aria-pressed={logo?.assetId === asset.id} onClick={() => onChange({ ...current, assetId: asset.id })} data-testid="logo-pick">
              <span className="look-preview">{asset.thumbUrl ? <img src={asset.thumbUrl} alt="" /> : null}</span>
              {asset.fileName.replace(/\.[a-z0-9]+$/i, "").slice(0, 14)}
            </button>
          ))}
        </div>
      ) : null}
      {logo ? (
        <>
          <div className="field">
            Corner
            <Segmented<Corner> label="Corner" options={CORNERS} value={logo.corner} onChange={(corner) => onChange({ ...logo, corner })} format={(corner) => CORNER_NAMES[corner]} />
          </div>
          <Range label="Size" value={logo.size} min={0.1} max={0.4} step={0.02} display={`${Math.round(logo.size * 100)}%`} onChange={(size) => onChange({ ...logo, size })} />
          <button type="button" className="btn btn-quiet btn-block" onClick={() => onChange(null)}>
            Remove the logo
          </button>
        </>
      ) : null}
    </Sheet>
  );
}

export function MotionSheet({ clip, onChange, onClose }: { clip: Clip; onChange(motion: Motion): void; onClose(): void }) {
  return (
    <Sheet title="Camera motion" onClose={onClose}>
      <Segmented label="Motion" options={MOTIONS} value={clip.motion} onChange={onChange} format={(motion) => MOTION_LABELS[motion]} />
      <p className="muted small">Use a gentle push or pan, or a short snap zoom to accent a cut. Works on photos and video.</p>
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
        <button type="button" className="btn btn-block" onClick={() => onChange(DEFAULT_PANO)}>
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
  canWalkHere,
  onChange,
  onDirection,
  onClose,
}: {
  clip: Clip;
  /** True when this clip and the one before are 360 photos with known positions. */
  canWalkHere: boolean;
  onChange(transition: Clip["transitionIn"]): void;
  onDirection(value: NonNullable<Clip["whipDirection"]>): void;
  onClose(): void;
}) {
  return (
    <Sheet title="Transition in" onClose={onClose}>
      <Segmented
        label="Transition"
        options={canWalkHere ? (["cut", "fade", "whip", "walk"] as const) : (["cut", "fade", "whip"] as const)}
        value={clip.transitionIn === "walk" && !canWalkHere ? "cut" : clip.transitionIn}
        onChange={onChange}
        format={(transition) => (transition === "cut" ? "Cut" : transition === "fade" ? "Fade through black" : transition === "whip" ? "Whip pan" : "Walk there")}
      />
      {clip.transitionIn === "whip" ? <Segmented label="Camera pan direction" options={["left", "right", "up", "down"] as const} value={clip.whipDirection ?? "right"} onChange={onDirection} format={direction => direction[0].toUpperCase() + direction.slice(1)} /> : null}
      <p className="muted small">Whip is silent. Choose the camera pan direction to match the footage; use a clean cut when the shots do not share a move.</p>
      {canWalkHere ? <p className="muted small">Walk there moves the camera across the floor plan from the last 360 photo to this one.</p> : null}
    </Sheet>
  );
}

// ── Property details ────────────────────────────────────────────

const PLACEMENT_NAMES: Record<ListingDetails["placement"], string> = { end: "At the end", start: "At the start", both: "Both", throughout: "Strip, whole reel", none: "Keep, don't show" };

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
      <p className="muted small">Shown as a card over the video, or as a thin strip at the top for the whole reel. Leave a field empty to leave it off.</p>
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

export type TextDraft = Pick<TextOverlay, "text" | "style" | "color" | "size" | "animation" | "font" | "tracking" | "path" | "shadow">;

/** The "Elegant" style chip, set in the serif it puts on the reel. */
const ELEGANT_CHIP: CSSProperties = { fontFamily: ELEGANT_FONT_FAMILY, fontWeight: 500, fontSize: "1.12em", letterSpacing: "0.06em" };

export function TextSheet({
  initial,
  onSave,
  onClose,
}: {
  initial: TextDraft | null;
  onSave(draft: TextDraft): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState<TextDraft>(initial ?? { text: "", style: "plain", color: "#ffffff", size: 1, animation: "auto" });
  const previewCss = textTreatmentCss(draft);

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
      <Segmented
        label="Style"
        options={TEXT_STYLES}
        value={draft.style}
        onChange={(style: TextStyle) => setDraft({ ...draft, style, size: fitTextSize(style, draft.size) })}
        format={(style) => TEXT_STYLE_LABELS[style]}
        optionStyle={(style) => (style === "elegant" ? ELEGANT_CHIP : undefined)}
      />
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
      <Range label="Size" value={draft.size} min={minTextSize(draft.style)} max={TEXT_SIZE_MAX} step={0.1} display={`${Math.round(draft.size * 100)}%`} onChange={(size) => setDraft({ ...draft, size })} />
      <Segmented label="Typeface" options={["auto", "serif", "sans", "editorial"] as const} value={draft.font ?? "auto"} onChange={font => setDraft({ ...draft, font })}
        format={font => ({ auto: "Style default", serif: "Cormorant", sans: "Archivo", editorial: "Bodoni" })[font]} />
      <Segmented label="Text shadow" options={["auto", "soft", "strong", "none"] as const} value={draft.shadow ?? "auto"} onChange={shadow => setDraft({ ...draft, shadow })} format={shadow => ({ auto: "Auto contrast", soft: "Soft", strong: "Strong", none: "None" })[shadow]} />
      <p className="muted small">Auto contrast protects small text over bright footage without changing its size or font.</p>
      <Range label="Letter spacing" value={draft.tracking ?? 0.06} min={-0.04} max={0.24} step={0.01} display={`${(draft.tracking ?? 0.06).toFixed(2)}em`} onChange={tracking => setDraft({ ...draft, tracking })} />
      <label className="field">Text movement<select className="text-input" value={draft.path ? "path" : "still"} onChange={event => {
        const move = event.target.value;
        setDraft({ ...draft, path: move === "still" ? undefined : move === "path" ? draft.path : [{ t: 0, x: 0, y: 0 }, { t: 1, x: move === "left" ? -0.04 : 0.04, y: 0 }] });
      }}><option value="still">Still</option>{draft.path ? <option value="path">Keep current motion path</option> : null}<option value="left">Drift left</option><option value="right">Drift right</option></select></label>
      <Segmented<TextAnimation> label="Arrives" options={TEXT_ANIMATIONS} value={draft.animation} onChange={(animation) => setDraft({ ...draft, animation })} format={(animation) => TEXT_ANIMATION_LABELS[animation]} />
      <button type="button" className="btn btn-block" disabled={!draft.text.trim()} onClick={() => onSave({ ...draft, text: draft.text.trim() })}>
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

/**
 * Whether the Music sheet offers Instagram's sounds: null when this
 * deployment cannot reach Instagram at all (no tabs), otherwise the reason the
 * workspace cannot use them yet (not connected, plan) or null when it can.
 */
export type InstagramSoundAccess = { problem: string | null } | null;

/**
 * Music (ADR 0021): Instagram first. Its library opens on what is popular
 * with business accounts, with one-tap searches that are known to return
 * good listing music; picking a sound fetches it, says so while it does,
 * and snaps the cuts to its beat. The song in use is one row at the top.
 * Your own songs are a small link at the bottom, and the whole sheet when
 * Instagram is not connected.
 */
export function MusicSheet({
  library,
  music,
  uploading,
  instagram,
  instagramBusyId,
  onPick,
  onPickInstagram,
  onSnap,
  onUpload,
  onChange,
  onRemove,
  onClose,
}: {
  library: LibraryAsset[];
  music: Music | null;
  uploading: boolean;
  instagram: InstagramSoundAccess;
  /** The Instagram sound being fetched after it was picked. */
  instagramBusyId: string | null;
  onPick(asset: LibraryAsset): void;
  /** Edit to a sound from Instagram's library (ADR 0019). */
  onPickInstagram(track: InstagramAudioTrack): void;
  /** Move every cut onto a beat of the song. */
  onSnap(): void;
  onUpload(file: File): void;
  onChange(patch: Partial<Music>): void;
  onRemove(): void;
  onClose(): void;
}) {
  // Instagram's copies are chosen from Instagram, not listed as songs of your own.
  const tracks = library.filter((asset) => asset.kind === "AUDIO" && !asset.instagram);
  const current = music ? library.find((asset) => asset.id === music.assetId) : undefined;
  const instagramSound = current?.instagram ?? null;
  const fromInstagram = isInstagramMusic(music) || instagramSound !== null;
  const instagramReady = instagram !== null && !instagram.problem;
  const [type, setType] = useState<InstagramAudioType>("music");
  const [query, setQuery] = useState("");
  const [own, setOwn] = useState(!instagramReady);
  const [adjust, setAdjust] = useState(false);
  const busyTitle = useRef<string | null>(null);

  return (
    <Sheet title="Music" onClose={onClose}>
      {music ? (
        <div className="music-current" data-testid="music-current" data-instagram={fromInstagram || undefined}>
          <div className="music-now">
            <span className="music-now-name">
              <strong>{instagramSound?.title ?? current?.fileName ?? "Track"}</strong>
              {instagramSound?.artist ? <span className="muted"> · {instagramSound.artist}</span> : null}
            </span>
            <button type="button" className="btn btn-quiet music-now-btn" onClick={() => setAdjust(!adjust)} aria-expanded={adjust}>
              {adjust ? "Done" : "Adjust"}
            </button>
          </div>
          {adjust ? (
            <>
              <Range
                label={fromInstagram ? "Volume in this preview" : "Music volume"}
                value={Math.round(music.volume * 100)}
                min={0}
                max={100}
                step={5}
                display={`${Math.round(music.volume * 100)}%`}
                onChange={(value) => onChange({ volume: value / 100 })}
              />
              {fromInstagram ? (
                <p className="muted small" data-testid="music-start-locked">
                  Instagram plays this sound from its start.
                </p>
              ) : current?.durationMs ? (
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
                <button type="button" className="btn btn-block" onClick={onSnap} data-testid="snap-to-beat">
                  Snap cuts to the beat again ({Math.round(music.bpm)} bpm)
                </button>
              ) : (
                <p className="muted small">No steady beat was found in this song, so cuts cannot snap to it.</p>
              )}
              {fromInstagram ? (
                <p className="muted small">Your export stays without it: Instagram adds the sound when you post or schedule from ReelWalk.</p>
              ) : null}
              <button type="button" className="btn btn-quiet btn-block" onClick={onRemove}>
                Remove music
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {instagramBusyId ? (
        <p className="music-loading" role="status" data-testid="music-loading">
          <span className="music-spinner" aria-hidden="true" />
          Adding {busyTitle.current ? `“${busyTitle.current}”` : "the sound"} from Instagram…
        </p>
      ) : null}

      {instagramReady && !own ? (
        <>
          <p className="powered-by">
            <InstagramIcon size={14} />
            Powered by Instagram
          </p>
          <div className="segmented" role="group" aria-label="Kind of sound">
            <button type="button" aria-pressed={type === "music"} onClick={() => setType("music")} data-testid="music-source-instagram">
              Music
            </button>
            <button type="button" aria-pressed={type === "original_sound"} onClick={() => setType("original_sound")} data-testid="music-source-trending">
              Trending sounds
            </button>
          </div>
          {type === "music" ? (
            <div className="ask-examples music-chips" aria-label="Suggestions">
              {INSTAGRAM_MUSIC_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.label}
                  type="button"
                  className="chip chip-btn"
                  aria-pressed={query === suggestion.query}
                  onClick={() => setQuery(suggestion.query)}
                  data-testid={`music-chip-${suggestion.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
          ) : null}
          <InstagramSoundBrowser
            key={type}
            type={type}
            query={type === "music" ? query : undefined}
            onQuery={type === "music" ? setQuery : undefined}
            selectedId={fromInstagram ? (instagramSound?.audioId ?? music?.instagramAudioId ?? null) : null}
            busyId={instagramBusyId}
            disabled={instagramBusyId !== null}
            onSelect={(track) => {
              busyTitle.current = track.title;
              onPickInstagram(track);
            }}
            hint="Tap a song to edit your reel to it; the cuts move to its beat. Instagram adds it when you post from ReelWalk."
          />
          <button type="button" className="link music-own-link" onClick={() => setOwn(true)} data-testid="music-source-songs">
            Use a song of your own instead
          </button>
        </>
      ) : (
        <>
          {instagram?.problem ? (
            <p className="muted small" data-testid="music-instagram-unavailable">
              {instagram.problem}{" "}
              <Link className="link" href="/account" prefetch={false}>
                Go to Account
              </Link>
            </p>
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
          <p className="muted small">Use music you have the rights to. Instagram can mute reels that use copyrighted songs.</p>
          {instagramReady ? (
            <button type="button" className="link music-own-link" onClick={() => setOwn(false)} data-testid="music-source-instagram">
              Back to Instagram music
            </button>
          ) : null}
        </>
      )}
    </Sheet>
  );
}

// ── Caption and export ──────────────────────────────────────────

export function CaptionSheet({
  reelId,
  caption,
  askAvailable = false,
  onChange,
  onClose,
}: {
  reelId: string;
  caption: string;
  /** Whether the AI may write it (ADR 0020). */
  askAvailable?: boolean;
  onChange(caption: string): void;
  onClose(): void;
}) {
  // The editor keeps its own text; a caption written for you re-mounts it with the new words.
  const [seed, setSeed] = useState(caption);
  const [writing, setWriting] = useState<"idle" | "busy" | string>("idle");
  return (
    <Sheet title="Post caption" onClose={onClose}>
      <p className="muted small">The text for your Instagram post. It is copied for you when you share the video.</p>
      <CaptionEditor key={seed} reelId={reelId} initial={seed} onChange={onChange} />
      {askAvailable ? (
        <button
          type="button"
          className="btn btn-quiet btn-block"
          disabled={writing === "busy"}
          data-testid="caption-write"
          onClick={async () => {
            setWriting("busy");
            const result = await fetch(`/api/reels/${reelId}/ideas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "caption" }) })
              .then((response) => response.json() as Promise<{ ok: true; caption: string } | { ok: false; message: string }>)
              .catch(() => ({ ok: false as const, message: "Could not reach ReelWalk. Try again." }));
            if (!result.ok) {
              setWriting(result.message);
              return;
            }
            await saveCaption({ id: reelId, caption: result.caption });
            onChange(result.caption);
            setSeed(result.caption);
            setWriting("idle");
          }}
        >
          {writing === "busy" ? "Writing…" : "Write it for me"}
        </button>
      ) : null}
      {writing !== "idle" && writing !== "busy" ? <p className="error small">{writing}</p> : null}
    </Sheet>
  );
}

export function ExportSheet({
  issues,
  durationMs,
  busy,
  error,
  upgrade = false,
  instagramSound = null,
  onExport,
  onShowIssue,
  onClose,
}: {
  issues: Issue[];
  durationMs: number;
  busy: boolean;
  error: string | null;
  /** The error is a plan limit that a bigger plan lifts: offer the plans. */
  upgrade?: boolean;
  /** "Title · Artist" when the reel is edited to an Instagram sound, which the video file leaves out. */
  instagramSound?: string | null;
  onExport(): void;
  onShowIssue(issue: Issue): void;
  onClose(): void;
}) {
  const ready = canExport(issues);
  return (
    <Sheet title={ready ? "Export for Instagram" : "Not ready to export"} onClose={onClose}>
      <p className="muted">
        {formatDuration(durationMs, true)} reel, rendered as a 1080×1920 MP4 at 30 fps. Usually ready in about {renderMinutes(durationMs)}; you can
        keep editing while it renders.
      </p>
      {instagramSound ? (
        <p className="muted small" data-testid="export-instagram-sound">
          The video file has only your clips&apos; own sound. Instagram adds “{instagramSound}” when you post or schedule it from ReelWalk.
        </p>
      ) : null}
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
      {error && upgrade ? (
        <Link href="/pricing" className="btn btn-block" data-testid="upgrade-link">
          See plans
        </Link>
      ) : null}
      <button type="button" className="btn btn-signal btn-block" disabled={!ready || busy} onClick={onExport} data-testid="confirm-export">
        {busy ? "Starting export…" : "Export video"}
      </button>
    </Sheet>
  );
}

// ── Asking for a change ─────────────────────────────────────────

export type AskOutcome = { ok: true; note: string; applied: string[]; skipped: string[]; questions: string[] } | { ok: false; message: string; upgrade?: boolean };
export type Brief = { id: string; name: string; text: string; own: boolean };

const ASK_EXAMPLES = ["Make the kitchen clip longer", "Calmer music", "Warmer look on everything", "Add “Open Saturday” at the end"];

/**
 * Say what should change, in words (ADR 0020), or pick a brief and have the
 * whole reel cut. The editor applies the answer as one step, so undo takes it
 * back. When the model needs a fact first it asks up to three questions,
 * answered here; when nothing could be changed its note stays here so the
 * request can be put another way. A brief that worked can be kept as a preset.
 */
export function AskSheet({
  briefs,
  fresh,
  onAsk,
  onSaveBrief,
  onDeleteBrief,
  onClose,
}: {
  briefs: Brief[];
  /** The reel has not been cut yet, so briefs lead. */
  fresh: boolean;
  onAsk(request: string, answers: { question: string; answer: string }[]): Promise<AskOutcome>;
  onSaveBrief(name: string, text: string): Promise<{ ok: true } | { ok: false; message: string }>;
  onDeleteBrief(id: string): Promise<void>;
  onClose(): void;
}) {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AskOutcome | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [lastBrief, setLastBrief] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const ready = request.trim().length >= 3;
  const questions = outcome?.ok ? outcome.questions : [];
  const canSave = outcome?.ok && outcome.applied.length > 0 && lastBrief === null && request.trim().length >= 3;

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setOutcome(null);
    setSaved(null);
    try {
      const sent = questions.map((question) => ({ question, answer: answers[question] ?? "" })).filter((entry) => entry.answer.trim());
      setOutcome(await onAsk(request.trim(), sent));
    } catch {
      setOutcome({ ok: false, message: "Could not reach ReelWalk. Check the connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  async function keep() {
    const name = window.prompt("Name this preset", "")?.trim();
    if (!name) return;
    const result = await onSaveBrief(name, request.trim());
    setSaved(result.ok ? `Kept as “${name}”.` : result.message);
  }

  return (
    <Sheet title={fresh ? "Cut it for me" : "Ask for a change"} onClose={onClose}>
      <p className="muted small">
        {fresh
          ? "Pick a way to cut it, or say what you want in your own words. The reel is cut from what you have uploaded; undo takes it back."
          : "Say what you want different, the way you would to an editor. It changes this reel; undo takes it back."}
      </p>
      {briefs.length > 0 ? (
        <div className="ask-examples" aria-label="Ways to cut it">
          {briefs.map((brief) => (
            <span key={brief.id} className="ask-brief">
              <button
                type="button"
                className="chip chip-btn"
                aria-pressed={lastBrief === brief.id}
                onClick={() => {
                  setRequest(brief.text);
                  setLastBrief(brief.id);
                  setOutcome(null);
                }}
                data-testid={`brief-${brief.id}`}
              >
                {brief.name}
              </button>
              {brief.own ? (
                <button type="button" className="ask-brief-delete" aria-label={`Delete preset ${brief.name}`} onClick={() => onDeleteBrief(brief.id)}>
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {!fresh ? (
        <div className="ask-examples" aria-label="Examples">
          {ASK_EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="chip chip-btn"
              onClick={() => {
                setRequest(example);
                setLastBrief(null);
              }}
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        className="text-area"
        rows={fresh ? 4 : 3}
        value={request}
        maxLength={600}
        placeholder={fresh ? "For example: a slow luxury reel, calm music, the address at the end" : "For example: cut the hallway, and put the price at the start in the thin serif"}
        onChange={(event) => {
          setRequest(event.target.value);
          setLastBrief(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
        }}
        data-testid="ask-input"
      />
      {questions.length > 0 ? (
        <div className="ask-questions" data-testid="ask-questions">
          <p className="small">{outcome?.ok ? outcome.note : null}</p>
          {questions.map((question) => (
            <label key={question} className="field">
              {question}
              <input className="text-input" value={answers[question] ?? ""} maxLength={200} onChange={(event) => setAnswers({ ...answers, [question]: event.target.value })} />
            </label>
          ))}
        </div>
      ) : null}
      {outcome && !outcome.ok ? (
        <p className="error" role="alert">
          {outcome.message}
        </p>
      ) : null}
      {outcome && !outcome.ok && outcome.upgrade ? (
        <Link href="/pricing" className="btn btn-quiet btn-block" data-testid="upgrade-link">
          See plans
        </Link>
      ) : null}
      {outcome?.ok && outcome.applied.length === 0 && questions.length === 0 ? (
        <p role="status" data-testid="ask-note">
          {outcome.note}
        </p>
      ) : null}
      {outcome?.ok && outcome.skipped.length > 0 ? (
        <ul className="muted small ask-skipped">
          {outcome.skipped.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {saved ? <p className="muted small">{saved}</p> : null}
      <button type="button" className="btn btn-block" disabled={!ready || busy} onClick={submit} data-testid="ask-submit">
        {busy ? "Working it out…" : questions.length > 0 ? "Answer and cut it" : fresh ? "Cut it" : "Make the change"}
      </button>
      {canSave ? (
        <button type="button" className="btn btn-quiet btn-block" onClick={keep} data-testid="ask-save-brief">
          Keep these words as a preset
        </button>
      ) : null}
    </Sheet>
  );
}

// ── Make it for me ──────────────────────────────────────────────

export type AutopilotPhase = "form" | "waiting" | "cutting" | "exporting";
export type AutopilotInfo = { address: string; price: string; beds: string; baths: string; area: string; openHouse: string };

const AUTOPILOT_STYLE_CHOICES = [
  { id: "just-listed", name: "Just listed" },
  { id: "privacy", name: "Luxury, slow" },
  { id: "open-house", name: "Open house" },
  { id: "walkthrough", name: "Walkthrough" },
];

/**
 * "Make it for me" (ADR 0021): a style and the facts, all optional, filled in
 * while the shots upload; then ReelWalk cuts, scores, writes and renders
 * without another tap, showing each step as it happens.
 */
export function AutopilotSheet({
  phase,
  uploading,
  shots,
  pending,
  naming = false,
  onRoom,
  error,
  upgrade,
  onGo,
  onClose,
}: {
  phase: AutopilotPhase;
  /** Files still uploading. */
  uploading: number;
  /** The shots that are up, in order, with the room each shows (named by the AI as they arrive). */
  shots: { id: string; thumbUrl: string | null; room: string | null }[];
  /** Shots still uploading. */
  pending: { key: string; thumbUrl: string | null; progress: number }[];
  /** Whether the AI is still looking at the shots to name them. */
  naming?: boolean;
  onRoom(clipId: string, room: string | null): void;
  error: string | null;
  upgrade: boolean;
  onGo(style: string, info: AutopilotInfo): void;
  onClose(): void;
}) {
  const [style, setStyle] = useState("just-listed");
  const [units, setUnits] = useState(true);
  const [info, setInfo] = useState<AutopilotInfo>({ address: "", price: "", beds: "", baths: "", area: "", openHouse: "" });
  const titleId = useId();
  const running = phase !== "form";
  const set = (key: keyof AutopilotInfo) => (event: React.ChangeEvent<HTMLInputElement>) => setInfo((current) => ({ ...current, [key]: event.target.value }));
  const step = (label: string, active: boolean, done: boolean) => <li data-state={done ? "done" : active ? "doing" : "todo"}>{label}</li>;

  // A full-screen panel, not a bottom sheet (ADR 0021): its top never moves, the
  // fields scroll inside it, and everything that changes while someone types
  // (the upload count, the button) lives in a footer of fixed height. On a
  // phone the keyboard then only shortens the panel; nothing jumps.
  return (
    <div className="panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="panel-head">
        <h2 id={titleId}>Make it for me</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={running}>
          <CloseIcon />
        </button>
      </header>

      <div className="panel-body">
        {!running ? (
          <>
            <p className="muted small">Pick a style and add what you know. Everything is optional; leave it blank and ReelWalk still makes the reel.</p>
            <div className="ask-examples" aria-label="Style">
              {AUTOPILOT_STYLE_CHOICES.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className="chip chip-btn"
                  aria-pressed={style === choice.id}
                  // Keeps the keyboard and the field in use where they are.
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => setStyle(choice.id)}
                  data-testid={`autopilot-style-${choice.id}`}
                >
                  {choice.name}
                </button>
              ))}
            </div>
            <form className="autopilot-fields" onSubmit={(event) => event.preventDefault()} autoComplete="off">
              <label className="field wide">
                Address
                <input className="text-input" value={info.address} placeholder="1427 Lakeview Dr, Austin" maxLength={80} enterKeyHint="next" onChange={set("address")} />
              </label>
              <label className="field">
                Price
                <input className="text-input" value={info.price} placeholder="$1,250,000" maxLength={24} inputMode="decimal" enterKeyHint="next" onChange={set("price")} />
              </label>
              <label className="field">
                Size
                <input className="text-input" value={info.area} placeholder="2,400 sq ft" maxLength={16} inputMode="decimal" enterKeyHint="next" onChange={set("area")} />
              </label>
              <label className="field">
                Beds
                <input className="text-input" value={info.beds} placeholder="3" maxLength={6} inputMode="decimal" enterKeyHint="next" onChange={set("beds")} />
              </label>
              <label className="field">
                Baths
                <input className="text-input" value={info.baths} placeholder="2" maxLength={6} inputMode="decimal" enterKeyHint="next" onChange={set("baths")} />
              </label>
              <label className="check wide units-check">
                <input type="checkbox" checked={units} onChange={(event) => setUnits(event.target.checked)} data-testid="autopilot-units" />
                <span>
                  Add $ and sq ft for me
                  {units && (info.price || info.area) ? (
                    <span className="muted small units-preview">
                      {" "}
                      Shows as {[info.price && formatPrice(info.price), info.area && formatArea(info.area)].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </span>
              </label>
              <label className="field wide">
                Open house (if there is one)
                <input className="text-input" value={info.openHouse} placeholder="Saturday 1–3 pm" maxLength={40} enterKeyHint="done" onChange={set("openHouse")} />
              </label>
            </form>
            {shots.length + pending.length > 0 ? (
              <section className="autopilot-shots" aria-label="Your shots">
                <h3>Your shots</h3>
                <p className="muted small">ReelWalk names each room as it arrives; tap a name to change it.</p>
                <ul>
                  {shots.map((shot, index) => (
                    <li key={shot.id}>
                      <span className="autopilot-thumb">{shot.thumbUrl ? <img src={shot.thumbUrl} alt="" loading="lazy" /> : null}</span>
                      <span className="muted small">{index + 1}</span>
                      <select
                        className="text-input autopilot-room"
                        value={shot.room ?? ""}
                        onChange={(event) => onRoom(shot.id, event.target.value || null)}
                        aria-label={`Room in shot ${index + 1}`}
                        data-testid="autopilot-room"
                      >
                        <option value="">{shot.room ? "No room" : uploading > 0 || naming ? "Naming…" : "Name the room"}</option>
                        {ROOM_NAMES.map((room) => (
                          <option key={room} value={room}>
                            {room[0].toUpperCase() + room.slice(1)}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                  {pending.map((upload) => (
                    <li key={upload.key}>
                      <span className="autopilot-thumb">{upload.thumbUrl ? <img src={upload.thumbUrl} alt="" /> : null}</span>
                      <span className="muted small">Uploading {Math.round(upload.progress * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : (
          <>
            <ol className="autopilot-steps" data-testid="autopilot-steps" data-phase={phase}>
              {step("Uploading your shots", phase === "waiting", phase !== "waiting")}
              {step("Choosing the shots, the order and the song", phase === "cutting", phase === "exporting")}
              {step("Cutting to the beat and writing the text", phase === "cutting", phase === "exporting")}
              {step("Opening your draft", phase === "exporting", false)}
            </ol>
            <p className="muted small">
              Keep this screen open, about a minute. You will see the draft playing with its music before anything is exported.
            </p>
          </>
        )}
      </div>

      <footer className="panel-foot">
        {/* One line of fixed height: the count changing never moves the fields. */}
        <p className="panel-status" role="status">
          {error ? <span className="error">{error}</span> : uploading > 0 ? `Uploading your shots: ${uploading} to go.` : running ? "Working on it…" : "Your shots are up."}
        </p>
        {error && upgrade ? (
          <Link href="/pricing" className="btn btn-quiet btn-block">
            See plans
          </Link>
        ) : null}
        {!running ? (
          <button
            type="button"
            className="btn btn-signal btn-block"
            onClick={() => onGo(style, units ? { ...info, price: formatPrice(info.price), area: formatArea(info.area) } : info)}
            data-testid="autopilot-go"
          >
            Make my reel
          </button>
        ) : null}
      </footer>
    </div>
  );
}

