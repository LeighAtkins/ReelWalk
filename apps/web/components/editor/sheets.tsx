"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { HOOK_DESCRIPTIONS, HOOK_FONTS, HOOK_LABELS, type Hook, type HookKind,
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
  hasCountableNumber,
  KINETIC_LABELS,
  KINETIC_PRESETS,
  TEXT_FONTS,
  SHINE_LABELS,
  SHINE_PRESETS,
  calloutTrackTarget,
  ROOM_NAMES,
  formatArea,
  formatPrice,
  isInstagramMusic,
  MIN_CLIP_MS,
  minTextSize,
  MOTIONS,
  SPEEDS,
  TEXT_ANIMATIONS,
  EFFECT_FAMILIES,
  EFFECT_FAMILY_LABELS,
  isNamedEffect,
  type EffectFamily,
  TEXT_COLORS,
  maxTextSize,
  TEXT_STYLES,
  ZOOM_MAX,
  AI_DRAFT_CREDITS,
  MOVES,
  MOVE_GROUPS,
  MOVE_GROUP_LABELS,
  moveBlockedAt,
  moveLoop,
  moveOnClip,
  RAMP_LABELS,
  RAMP_PRESETS,
  rampProfile,
  type MoveId,
  type RampPreset,
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
  type MusicMoodId,
  type PanoView,
  type PlanOverlay,
  type TextAnimation,
  type TextOverlay,
  type TextStyle, orientQuad, type BrandKit, resolveTextStyle, brandFontFamily,
  type TitleOnSurface } from "@reelwalk/core";
import { ClipSourceInfo } from "./clip-source-info";
import { ELEGANT_FONT_FAMILY, FILTER_CSS, FILTER_LABELS, TEXT_ANIMATION_LABELS, TEXT_STYLE_LABELS, textTreatmentCss } from "@reelwalk/render/reel";
import { StockPicker } from "./stock-picker";
import { formatDuration } from "@/lib/format";
import type { LibraryAsset } from "@/lib/library";
import Link from "next/link";
import { saveCaption } from "@/app/actions";
import { CaptionEditor } from "../caption-editor";
import { AlertIcon, CloseIcon, InstagramIcon, PlusIcon } from "../icons";
import { InstagramSoundBrowser } from "../instagram-sound-picker";
import { PopularSounds } from "../popular-sounds";
import { detectSurface, findMatchingCut, trackTextPathDetailed } from "./frame-analysis";
import { SurfacePicker } from "./surface-picker";
import { planarShift } from "./title-metrics";
import { crossingNow } from "./pass-crossing";
import { asCallout, beatForMotion, motionMode, motionStartMs, withMotionMode, withMotionStartAt } from "./type-motion-draft";
import { Sheet } from "../sheet";
import { HeadLockControl } from "./head-lock-control";

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
  replace = false,
  suggest,
  onStock,
}: {
  library: LibraryAsset[];
  onUpload(files: File[]): void;
  onPick(assets: LibraryAsset[]): void;
  onClose(): void;
  /** Replacing the selected clip (ADR 0064): one tap on a photo or video picks it. */
  replace?: boolean;
  /** Match cuts (ADR 0067): "after 3" on a video whose opening carries on the motion of shot 3; null when nothing is known. */
  suggest?: (asset: LibraryAsset) => string | null;
  /** Stock footage (ADR 0070): imported sets arrive here as library assets, to add to the reel. Absent: no Stock tab. */
  onStock?(assets: LibraryAsset[]): void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [source, setSource] = useState<"library" | "stock">("library");
  const everything = library.filter((asset) => asset.kind !== "AUDIO");
  const typeOf = (asset: LibraryAsset): LibraryFilter => (asset.isPano ? "360" : asset.kind === "VIDEO" ? "video" : "photo");
  const visual = filter === "all" ? everything : everything.filter((asset) => typeOf(asset) === filter);
  const filters = (["all", "360", "video", "photo"] as const).filter((name) => name === "all" || everything.some((asset) => typeOf(asset) === name));
  const toggle = (id: string) => {
    if (replace) {
      const asset = everything.find((item) => item.id === id);
      if (asset) onPick([asset]);
      return;
    }
    setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  return (
    <Sheet title={replace ? "Replace this clip" : "Add photos and videos"} onClose={onClose}>
      {onStock && !replace ? (
        <Segmented<"library" | "stock"> label="Source" options={["library", "stock"]} value={source} onChange={setSource} format={(name) => (name === "library" ? "Your media" : "Stock footage")} />
      ) : null}
      {onStock && !replace && source === "stock" ? (
        <StockPicker onAdd={onStock} />
      ) : (
        <>
      {replace ? (
        <p className="muted small">Tap what this clip should show. It keeps its place, length and look. To use something new, add it with Add media first.</p>
      ) : (
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
      )}
      {everything.length > 0 ? (
        <>
          {replace ? null : <p className="muted small">Or pick from your library. Tap in the order you want them.{suggest && visual.some((asset) => suggest(asset)) ? " “After 3” marks a video that carries on the motion of shot 3: a match cut." : ""}</p>}
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
                  {suggest?.(asset) ? <span className="chip timecode library-suggest" data-testid="library-suggest">{suggest(asset)}</span> : null}
                  <span className="chip timecode">{order >= 0 ? order + 1 : asset.isPano ? "360" : asset.durationMs ? formatDuration(asset.durationMs) : "Photo"}</span>
                </button>
              );
            })}
          </div>
          {replace ? null : <button
            type="button"
            className="btn btn-block sheet-sticky"
            disabled={picked.length === 0}
            onClick={() => onPick(picked.map((id) => everything.find((asset) => asset.id === id)!))}
          >
            {picked.length === 0 ? "Select media to add" : `Add ${picked.length} to the reel`}
          </button>}
        </>
      ) : null}
        </>
      )}
    </Sheet>
  );
}

// ── Clip tools ──────────────────────────────────────────────────

export function TrimSheet({
  clip,
  asset,
  next = null,
  onChange,
  onClose,
}: {
  clip: Clip;
  asset: LibraryAsset | undefined;
  /** The shot that follows, when it is a video: the cut into it can be matched by picture. */
  next?: { clip: Clip; asset: LibraryAsset | undefined } | null;
  onChange(window: { sourceStartMs: number; sourceEndMs: number }): void;
  onClose(): void;
}) {
  const [matching, setMatching] = useState<string | null>(null);
  async function matchCut() {
    if (!asset || !next?.asset || next.clip.kind !== "VIDEO") return;
    setMatching("Comparing the last second and a half with the next shot…");
    const found = await findMatchingCut({ asset, sourceStartMs: clip.sourceStartMs, sourceEndMs: clip.sourceEndMs }, { asset: next.asset, sourceStartMs: next.clip.sourceStartMs });
    if (!found) { setMatching("Could not read one of the videos."); return; }
    onChange({ sourceStartMs: clip.sourceStartMs, sourceEndMs: found.sourceEndMs });
    setMatching(found.close ? `Ends at ${formatDuration(found.sourceEndMs, true)}, where it matches the next shot.` : `Ends at ${formatDuration(found.sourceEndMs, true)}: the nearest frame, though not a close match.`);
  }
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
      {next?.clip.kind === "VIDEO" && next.asset ? (
        <div className="field">
          <button type="button" className="btn btn-quiet btn-block" disabled={matching?.startsWith("Comparing")} onClick={matchCut} data-testid="match-cut">Match the cut into the next shot</button>
          <span className="muted small">{matching ?? "Ends this shot on the frame that looks most like the next shot's first frame, so the cut reads as one move."}</span>
        </div>
      ) : null}
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

type RampChoice = "steady" | RampPreset;
const RAMP_NOTES: Record<RampChoice, string> = {
  steady: "One speed from start to finish.",
  "slow-in": "Settles in slowly, then plays at speed.",
  "slow-out": "Slows into the last third: a reveal.",
  "into-cut": "Holds, then races into the cut, so the cut lands on the fast part.",
  "hold-snap": "Holds, then snaps to full speed in a few frames and stays there to the cut.",
  hit: "Fast from the very first frame, settling by a third of the way in.",
};

/** The clip's speed across its time, thumb-sized (ADR 0067): a flat line is steady; a rise is the ramp. */
function RampGraph({ ramp }: { ramp: Clip["ramp"] }) {
  const profile = rampProfile(ramp ?? null, 32);
  const peak = Math.max(1.5, ...profile);
  const width = 240, height = 48, pad = 4;
  const y = (v: number) => height - pad - ((height - 2 * pad) * v) / peak;
  const d = profile.map((v, i) => `${i === 0 ? "M" : "L"}${((width * i) / (profile.length - 1)).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="ramp-graph" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={ramp ? `Speed ramp: ${RAMP_LABELS[ramp.preset as RampPreset] ?? "custom"}` : "Steady speed"}>
      <line x1={0} x2={width} y1={y(1)} y2={y(1)} />
      <path d={d} />
    </svg>
  );
}

export function SpeedSheet({ clip, onChange, onRamp, onClose }: { clip: Clip; onChange(speed: number): void; /** A speed ramp (ADR 0067), or null for steady. */ onRamp(ramp: RampPreset | null): void; onClose(): void }) {
  const choice: RampChoice = clip.ramp && (RAMP_PRESETS as readonly string[]).includes(clip.ramp.preset) ? (clip.ramp.preset as RampPreset) : clip.ramp ? "into-cut" : "steady";
  return (
    <Sheet title="Speed" onClose={onClose}>
      <Segmented label="Playback speed" options={SPEEDS} value={clip.speed as (typeof SPEEDS)[number]} onChange={onChange} format={(speed) => `${speed}×`} />
      <p className="muted small">
        The clip now plays for {formatDuration(clipDurationMs(clip), true)}. Faster clips suit walk-throughs; 0.5× suits a reveal.
      </p>
      {clip.kind === "VIDEO" ? (
        <>
          <Segmented<RampChoice> label="Speed ramp" options={["steady", ...RAMP_PRESETS]} value={choice} onChange={(value) => onRamp(value === "steady" ? null : value)} format={(value) => (value === "steady" ? "Steady" : RAMP_LABELS[value])} />
          <RampGraph ramp={clip.ramp} />
          <p className="muted small" data-testid="ramp-note">
            {clip.ramp?.preset === "custom" ? "A custom ramp." : RAMP_NOTES[choice]} The clip keeps its length and its place on the beat
            {clip.volume > 0 && clip.ramp ? "; its own sound fades where the picture runs far from this speed" : ""}.
          </p>
        </>
      ) : null}
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
  match,
  onClose,
}: {
  clip: Clip;
  asset: LibraryAsset | undefined;
  onChange(filter: Filter): void;
  onApplyAll(): void;
  onLens?(value: number): void;
  onLuxury?(variant: "refined" | "modern"): void;
  /** Colour matching across clips (ADR 0070); absent when the reel has one flat clip or fewer. */
  match?: LookMatchProps;
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
      {match ? <LookMatch {...match} /> : null}
      {onLens ? <Range label="Soft lens edges" value={clip.lensSoftness ?? 0} min={0} max={1} step={0.05} display={`${Math.round((clip.lensSoftness ?? 0) * 100)}%`} onChange={onLens} /> : null}
    </Sheet>
  );
}

export type LookMatchProps = {
  /** The reel's match, if any. */
  look: { referenceClipId: string; strength: number } | undefined;
  /** Whether the clip this sheet is open on is the reference. */
  isReference: boolean;
  /** The reference clip's place in the reel, from 1, for the label. */
  referenceIndex: number | null;
  /** The clips' frames are being read. */
  measuring: boolean;
  /** Match every clip to the clip this sheet is open on. */
  onMatch(): void;
  onStrength(value: number): void;
  onClear(): void;
};

/**
 * One coherent look (ADR 0070), where the thumb already is: on a clip's Look
 * sheet. "Match every clip to this one" makes this clip the reference; the
 * strength slider and "Stop matching" appear once the reel has a match. The
 * preset grades above sit on top of the match.
 */
function LookMatch({ look, isReference, referenceIndex, measuring, onMatch, onStrength, onClear }: LookMatchProps) {
  return (
    <div className="field" data-testid="look-match">
      <span>Match colour across clips</span>
      {look && isReference ? (
        <p className="muted small">Every clip is matched to this one, so the footage agrees before any grade. Slide how far.</p>
      ) : look ? (
        <p className="muted small">Matched to clip {referenceIndex ?? "?"}. Make this the clip the others follow instead, or slide how far.</p>
      ) : (
        <p className="muted small">Footage from different cameras jumps in colour at every cut. Matching moves every clip&apos;s exposure and cast onto this one&apos;s.</p>
      )}
      {!look || !isReference ? (
        <button type="button" className="btn btn-block" disabled={measuring} onClick={onMatch} data-testid="look-match-button">
          {measuring ? "Reading the clips…" : look ? "Match every clip to this one instead" : "Match every clip to this one"}
        </button>
      ) : null}
      {look ? (
        <>
          <Range label="Strength" value={look.strength} min={0} max={1} step={0.05} display={`${Math.round(look.strength * 100)}%`} onChange={onStrength} />
          <button type="button" className="btn btn-quiet btn-block" onClick={onClear}>
            Stop matching
          </button>
        </>
      ) : null}
    </div>
  );
}

const MOTION_LABELS: Record<Motion, string> = { none: "Still", "zoom-in": "Zoom in", "zoom-out": "Zoom out", pan: "Pan", "snap-in": "Snap in", "snap-out": "Snap out" };

/** A closer crop of one shot, about its centre. */
export function ZoomSheet({ clip, asset, onHeadLock, onChange, onClose }: { clip: Clip; asset?: LibraryAsset; onHeadLock(lock: Clip["headLock"]): void; onChange(zoom: number): void; onClose(): void }) {
  return (
    <Sheet title="Zoom & tracking" onClose={onClose}>
      <HeadLockControl clip={clip} asset={asset} onChange={onHeadLock} />
      <Range label="Closer" value={clip.zoom} min={1} max={ZOOM_MAX} step={0.05} display={clip.zoom === 1 ? "Whole picture" : `${Math.round(clip.zoom * 100)}%`} onChange={onChange} />
      <p className="muted small">{clip.headLock ? "Crops closer around the locked head. Remove head tracking to use other camera moves." : "Crops into the middle of the shot. Any zoom or pan motion still plays on top of it."}</p>
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

/** A move's loop on the clip's own picture (ADR 0076): the table's camera maths, played back and forth. A sketch for an AI-only move. */
function MoveLoop({ id, thumbUrl }: { id: MoveId; thumbUrl: string | null }) {
  const picture = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = picture.current;
    if (!element) return;
    const poses = moveLoop(id, 24);
    const frames = poses.map((pose, i) => ({ offset: i / (poses.length - 1), transform: `translate(${pose.x}%, ${pose.y}%) rotate(${pose.rotate}deg) scale(${pose.scale})` }));
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || typeof element.animate !== "function") {
      element.style.transform = frames[Math.floor(frames.length / 2)].transform;
      return;
    }
    const animation = element.animate(frames, { duration: 1800, iterations: Infinity, direction: "alternate", easing: "linear" });
    return () => animation.cancel();
  }, [id]);
  return (
    <span className="move-loop" aria-hidden="true">
      <span className="move-loop-picture" ref={picture} style={thumbUrl ? { backgroundImage: `url("${thumbUrl}")` } : undefined} />
    </span>
  );
}

/**
 * Moves (ADR 0076): the clip's Camera motion controls, as cards. On the clip a card is `applyMove` (one undo step); asking
 * for a new AI shot opens the AI sheet with the move chosen and its words in the prompt. A move that needs depth, a roll or
 * a path the footage lacks (AI-only) goes straight to the AI side.
 */
export function MovesSheet({ clip, index, thumbUrl, onMove, onAskAi, onChange, onCamera, onClose }: {
  clip: Clip; index: number; thumbUrl: string | null;
  /** A move from the table, applied to this clip as one command. */
  onMove(move: MoveId): void;
  /** Ask for this move as a new AI shot: the AI sheet opens with it chosen. */
  onAskAi(move: MoveId): void;
  onChange(motion: Motion): void;
  /** Take an eased move off (back to the simple move). */
  onCamera(camera: null): void;
  onClose(): void;
}) {
  const [target, setTarget] = useState<"clip" | "ai">("clip");
  const active = moveOnClip(clip);
  return (
    <Sheet title="Moves" onClose={onClose}>
      <Segmented<"clip" | "ai"> label="Use a move on" options={["clip", "ai"]} value={target} onChange={setTarget} format={(value) => (value === "clip" ? "This shot" : "A new AI shot")} />
      <p className="muted small" data-testid="moves-note">
        {target === "clip"
          ? "Applies to this shot in one step, and Undo takes it back. Moves marked AI need a take Veo makes: tap one to ask for it."
          : `Opens AI video with the move chosen. A draft costs ${AI_DRAFT_CREDITS} credit and shows the move first; Make it final runs it at full quality.`}
      </p>
      {MOVE_GROUPS.map((group) => {
        const moves = MOVES.filter((move) => move.group === group);
        if (!moves.length) return null;
        return (
          <section className="move-group" key={group} aria-label={MOVE_GROUP_LABELS[group]}>
            <h3 className="move-group-title">{MOVE_GROUP_LABELS[group]}</h3>
            {moves.map((move) => {
              const toAi = target === "ai" || move.real === null;
              const blocked = !toAi ? moveBlockedAt(move.id, index) : null;
              return (
                <button type="button" key={move.id} className="move-card" data-testid={`move-${move.id}`} aria-pressed={!toAi && active === move.id} disabled={Boolean(blocked)}
                  onClick={() => (toAi ? onAskAi(move.id) : onMove(move.id))}>
                  <MoveLoop id={move.id} thumbUrl={thumbUrl} />
                  <span className="move-card-text">
                    <strong>{move.label}</strong>
                    <span className="muted small">{blocked ?? (move.real === null && target === "clip" ? move.aiOnly : move.blurb)}</span>
                  </span>
                  {move.real === null ? <span className="move-badge">AI</span> : null}
                </button>
              );
            })}
          </section>
        );
      })}
      {clip.camera ? (
        <button type="button" className="btn btn-quiet btn-block" onClick={() => onCamera(null)}>
          Take the move off{clip.camera.preset === "custom" && !active ? " (a custom eased move)" : ""}
        </button>
      ) : null}
      <Segmented label="Simple move" options={MOTIONS} value={clip.camera ? ("" as Motion) : clip.motion} onChange={onChange} format={(motion) => MOTION_LABELS[motion]} />
      <p className="muted small">{clip.camera ? "Choosing a simple move switches the eased move off." : "A steady push or pan, or a short snap zoom to accent a cut. Works on photos and video."}</p>
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

/** The transitions the sheet offers (ADR 0082, the owner's choice of the gallery), with their names. A cut is no transition. */
const TRANSITION_NAMES = { cut: "Cut", fade: "Dissolve", softDissolve: "Soft dissolve", focusPull: "Focus pull", lightLeak: "Light leak", walk: "Walk there", motionCut: "In the motion" } as const satisfies Record<Clip["transitionIn"], string>;

export function TransitionSheet({
  clip,
  canWalkHere,
  onChange,
  looping = false,
  onPlayCut,
  onClose,
}: {
  clip: Clip;
  /** True when this clip and the one before are 360 photos with known positions. */
  canWalkHere: boolean;
  onChange(transition: Clip["transitionIn"]): void;
  /** The cut plays in a loop on the stage above, so the studio sees the transition as they pick it. */
  looping?: boolean;
  onPlayCut?: () => void;
  onClose(): void;
}) {
  // A motion-hidden cut (ADR 0090) is made from measured motion, never picked here: it is shown only on a cut that has one.
  const hidden = clip.transitionIn === "motionCut" && clip.motionCut;
  const offered = [...(["cut", "fade", "softDissolve", "focusPull", "lightLeak"] as const), ...(canWalkHere ? (["walk"] as const) : []), ...(hidden ? (["motionCut"] as const) : [])];
  return (
    <Sheet title="Transition in" onClose={onClose}>
      <Segmented
        label="Transition"
        options={offered}
        value={clip.transitionIn === "walk" && !canWalkHere ? "cut" : clip.transitionIn}
        onChange={onChange}
        format={(transition) => TRANSITION_NAMES[transition]}
      />
      {onPlayCut && clip.transitionIn !== "cut" ? <button type="button" className="btn btn-block" aria-pressed={looping} onClick={onPlayCut} data-testid="transition-play">{looping ? "Stop the loop" : "Play the cut"}</button> : null}
      <p className="muted small">A cut is the house style. Dissolve, Soft dissolve and Focus pull blend the two shots around the cut; Light leak keeps the cut and lays a soft warm glint over it. None of them makes the reel longer.</p>
      {canWalkHere ? <p className="muted small">Walk there moves the camera across the floor plan from the last 360 photo to this one.</p> : null}
      {hidden ? <p className="muted small">In the motion hides the cut inside the camera's own movement: this shot starts fast and eases to normal speed. Pick another to take it off.</p> : null}
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
      {field("price", "Price", "$1,250,000", 24)}
      <div className="field-grid">
        {field("beds", "Beds", "3", 6, "numeric")}
        {field("baths", "Baths", "2", 6, "numeric")}
        {field("area", "Size", "92 m²", 16)}
      </div>
      {field("address", "Address or suburb", "Bronte, Sydney", 80)}
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

export type TextDraft = Pick<TextOverlay, "text" | "style" | "color" | "size" | "animation" | "font" | "tracking" | "path" | "shadow" | "behind" | "depth" | "blend" | "passMs" | "passFadeMs" | "particles" | "shine" | "kinetic" | "callout" | "brand" | "lockup">;

/** Particle density in three thumb-sized steps (ADR 0055). */
const PARTICLE_DENSITIES = [0.5, 1, 1.8] as const;

/** The "Elegant" style chip, set in the serif it puts on the reel. */
const ELEGANT_CHIP: CSSProperties = { fontFamily: ELEGANT_FONT_FAMILY, fontWeight: 500, fontSize: "1.12em", letterSpacing: "0.01em" };

/** The text with kit style `name` applied: the same fields the `applyTextStyle` command writes. Unknown name: unchanged. */
export function withBrandStyle(draft: TextDraft, kit: BrandKit, name: string): TextDraft {
  const resolved = resolveTextStyle(kit, name);
  return resolved.ok ? { ...draft, ...resolved.patch } : draft;
}

export function TextSheet({
  initial,
  brandKit = null,
  playheadNow,
  title,
  music,
  focus,
  onSave,
  onClose,
}: {
  initial: TextDraft | null;
  /** The workspace's brand kit (ADR 0078): a Brand row lists its styles. Absent or null: no row. */
  brandKit?: BrandKit | null;
  /** Opened from the title's Particles or Walk-through control (ADR 0064): that part of the sheet is brought into view. */
  focus?: "particles" | "walk-through";
  /** Reads the reel time on screen behind the sheet when called: "Use this frame" sets the crossing there (ADR 0055). */
  playheadNow?(): number;
  /** The text's time on the reel, when editing one: where its motion's start is measured from (ADR 0061). */
  title?: { startMs: number; endMs: number };
  /** The reel's music: "On the beat" when it has a tempo (ADR 0061). */
  music?: Music | null;
  onSave(draft: TextDraft): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState<TextDraft>(initial ?? { text: "", style: "plain", color: "#ffffff", size: 1, animation: "auto" });
  const previewCss = textTreatmentCss(draft);
  const focusRef = useRef<HTMLDivElement>(null);
  // After the sheet focused its first field: a control opened for one part goes there instead (no keyboard over it).
  useEffect(() => {
    if (!focus || !focusRef.current) return;
    focusRef.current.scrollIntoView({ block: "center" });
    focusRef.current.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
  }, []);

  return (
    <Sheet title={initial ? (initial.callout ? "Edit callout" : "Edit text") : "Add text"} onClose={onClose}>
      {initial ? null : (
        // A callout (ADR 0061) is added from the same flow: a small label with a line to a feature of the room.
        <Segmented label="Kind" options={["title", "callout"] as const} value={draft.callout ? "callout" : "title"}
          onChange={kind => setDraft(kind === "callout" ? asCallout(draft) : { ...draft, callout: undefined })}
          format={kind => ({ title: "Title", callout: "Callout ↗" })[kind]} />
      )}
      {draft.callout && !initial ? <p className="muted small">A small label with a line to something in the room. After adding it, drag the blue dot onto the feature, then Pin it to follow it.</p> : null}
      <textarea
        className="text-area"
        rows={2}
        maxLength={200}
        value={draft.text}
        placeholder={draft.callout ? "Heated floors" : "Just listed · 3 bed near Bronte Beach"}
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
        onChange={(style: TextStyle) => setDraft({ ...draft, style, size: fitTextSize(style, draft.size), brand: undefined })}
        format={(style) => TEXT_STYLE_LABELS[style]}
        optionStyle={(style) => (style === "elegant" ? ELEGANT_CHIP : undefined)}
      />
      {/* The workspace's own styles (ADR 0078): one tap sets font, colour, size, shadow and plate; picking a plain style or typeface takes it off. */}
      {brandKit ? (
        <Segmented
          label="Brand"
          options={["none", ...brandKit.styles.map((entry) => entry.name)] as const}
          value={draft.brand?.style ?? "none"}
          onChange={(name) => setDraft(name === "none" ? { ...draft, brand: undefined } : withBrandStyle(draft, brandKit, name))}
          format={(name) => (name === "none" ? "No brand style" : brandKit.styles.find((entry) => entry.name === name)?.label ?? name)}
          optionStyle={(name) => {
            const found = brandKit.styles.find((entry) => entry.name === name);
            return found ? { fontFamily: brandFontFamily(found.look.font), fontWeight: found.look.weight } : undefined;
          }}
        />
      ) : null}
      {/* Motion on the type (ADR 0061): one kind at a time, a preset, and when it starts. */}
      <Segmented label="Motion" options={["none", "shine", "kinetic"] as const} value={motionMode(draft)} onChange={mode => setDraft(withMotionMode(draft, mode))}
        format={mode => ({ none: "No motion", shine: "Shine", kinetic: "Kinetic" })[mode]} />
      {draft.shine ? (
        <Segmented label="Shine" options={SHINE_PRESETS} value={draft.shine.preset} onChange={preset => setDraft({ ...draft, shine: { ...draft.shine, preset } })} format={preset => SHINE_LABELS[preset]} />
      ) : null}
      {draft.kinetic ? (
        <Segmented label="Kinetic type" options={KINETIC_PRESETS} value={draft.kinetic.preset} onChange={preset => setDraft({ ...draft, kinetic: { ...draft.kinetic, preset } })} format={preset => KINETIC_LABELS[preset]} />
      ) : null}
      {draft.kinetic?.preset === "count" && !hasCountableNumber(draft.text) ? <p className="small">Count up needs a number in the text, like 4 BED or $1.2M.</p> : null}
      {draft.kinetic?.preset === "focus" ? <p className="muted small">Each word shrinks into focus in turn. To land every word as it is said, ask for captions that come into focus.</p> : null}
      {draft.kinetic?.preset === "behind" ? <p className="muted small">The words slide out from behind the nearest post or tapped object in front of the surface (set under Pin), or from behind their own edge.</p> : null}
      {(draft.shine || draft.kinetic) && title ? (
        <div className="pass-row" role="group" aria-label="When the motion starts">
          <span className="small">Starts <strong>{((motionStartMs(draft) ?? 0) / 1000).toFixed(1)} s</strong> after the text appears</span>
          <div className="segmented">
            <button type="button" disabled={!playheadNow} onClick={() => playheadNow && setDraft(withMotionStartAt(draft, playheadNow(), title))}>Use this frame</button>
            {beatForMotion(draft, title, music) !== null ? <button type="button" onClick={() => setDraft(withMotionStartAt(draft, beatForMotion(draft, title, music)!, title))}>On the beat</button> : null}
          </div>
        </div>
      ) : null}
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
      <Range label="Size" value={draft.size} min={minTextSize(draft.style)} max={maxTextSize(draft)} step={0.1} display={`${Math.round(draft.size * 100)}%`} onChange={(size) => setDraft({ ...draft, size })} />
      <Segmented label="Typeface" options={TEXT_FONTS} value={draft.font ?? "auto"} onChange={font => setDraft({ ...draft, font, brand: undefined })}
        format={font => ({ auto: "Style default", serif: "Cormorant", sans: "Archivo", editorial: "Bodoni", tight: "Inter Tight" })[font]} />
      <Segmented label="Text shadow" options={["auto", "soft", "strong", "none"] as const} value={draft.shadow ?? "auto"} onChange={shadow => setDraft({ ...draft, shadow, brand: undefined })} format={shadow => ({ auto: "Auto contrast", soft: "Soft", strong: "Strong", none: "None" })[shadow]} />
      <p className="muted small">Auto contrast protects small text over bright footage without changing its size or font.</p>
      <Range label="Letter spacing" value={draft.tracking ?? 0.06} min={-0.04} max={0.24} step={0.01} display={`${(draft.tracking ?? 0.06).toFixed(2)}em`} onChange={tracking => setDraft({ ...draft, tracking })} />
      {draft.callout ? null : (<>
        <label className="field">Text movement<select className="text-input" value={draft.path ? "path" : "still"} onChange={event => {
          const move = event.target.value;
          setDraft({ ...draft, path: move === "still" ? undefined : move === "path" ? draft.path : [{ t: 0, x: 0, y: 0 }, { t: 1, x: move === "left" ? -0.04 : 0.04, y: 0 }] });
        }}><option value="still">Still</option>{draft.path ? <option value="path">Keep current motion path</option> : null}<option value="left">Drift left</option><option value="right">Drift right</option></select></label>
        <Segmented label="Depth" options={["flat", "extruded"] as const} value={draft.depth ?? "flat"} onChange={depth => setDraft({ ...draft, depth })} format={depth => ({ flat: "Flat", extruded: "Extruded 3D" })[depth]} />
        <Segmented label="Meets the picture" options={["plain", "surface", "invert"] as const} value={draft.blend ?? "plain"} onChange={blend => setDraft({ ...draft, blend: blend === "plain" ? undefined : blend })} format={blend => ({ plain: "On top", surface: "Painted on the surface", invert: "Inverts the picture" })[blend]} />
        <div ref={focus === "walk-through" ? focusRef : undefined} className={focus === "walk-through" ? "sheet-focus" : undefined} data-testid="text-walk-through">
        <label className="field small"><input type="checkbox" checked={Boolean(draft.behind)} onChange={event => setDraft({ ...draft, behind: event.target.checked || undefined, ...(event.target.checked ? {} : { passMs: undefined, passFadeMs: undefined }) })} /> People in the shot pass in front of this text</label>
        {draft.behind ? (
          // Walks through the words (ADR 0055): in front of her until this moment, behind her after it.
          <div className="pass-row" role="group" aria-label="She passes in front">
            <span className="small">{draft.passMs === undefined ? "In front of the words the whole time" : <>She passes in front at <strong>▸ {formatDuration(draft.passMs, true)}</strong></>}</span>
            <div className="segmented">
              <button type="button" disabled={!playheadNow} onClick={() => playheadNow && setDraft({ ...draft, passMs: crossingNow(playheadNow) })}>Use this frame</button>
              {draft.passMs !== undefined ? <button type="button" className="pass-clear" aria-label="Clear the crossing: she is in front the whole time" onClick={() => setDraft({ ...draft, passMs: undefined, passFadeMs: undefined })}>×</button> : null}
            </div>
          </div>
        ) : null}
        </div>
        <div ref={focus === "particles" ? focusRef : undefined} className={focus === "particles" ? "sheet-focus" : undefined} data-testid="text-particles">
        <Segmented label="Particles" options={["none", "snow", "embers", "dust"] as const} value={draft.particles?.kind ?? "none"}
          onChange={kind => setDraft({ ...draft, particles: kind === "none" ? undefined : { ...draft.particles, kind } })}
          format={kind => ({ none: "No particles", snow: "Snow", embers: "Embers", dust: "Dust" })[kind]} />
        {draft.particles ? (
          <Segmented label="Particle density" options={PARTICLE_DENSITIES} value={PARTICLE_DENSITIES.reduce((best, d) => Math.abs(d - (draft.particles?.density ?? 1)) < Math.abs(best - (draft.particles?.density ?? 1)) ? d : best)}
            onChange={density => setDraft({ ...draft, particles: { ...draft.particles!, density } })}
            format={density => ({ 0.5: "Light", 1: "Medium", 1.8: "Thick" })[density as 0.5 | 1 | 1.8]} />
        ) : null}
        </div>
      </>)}
      {/* A callout and word-by-word or from-behind type bring the words in themselves. */}
      {draft.callout || (draft.kinetic && draft.kinetic.preset !== "count") ? null : (
        <>
          <Segmented<TextAnimation> label="Arrives" options={TEXT_ANIMATIONS.filter((animation) => !isNamedEffect(animation))} value={isNamedEffect(draft.animation) ? "auto" : draft.animation} onChange={(animation) => setDraft({ ...draft, animation })} format={(animation) => TEXT_ANIMATION_LABELS[animation]} />
          {/* The sixteen effects (ADR 0103), by family; choosing one replaces the arrival above. */}
          <label className="field">Effect
            <select className="text-input" value={isNamedEffect(draft.animation) ? draft.animation : ""} data-testid="text-effect"
              onChange={(event) => setDraft({ ...draft, animation: (event.target.value || "auto") as TextAnimation })}>
              <option value="">None</option>
              {(Object.keys(EFFECT_FAMILIES) as EffectFamily[]).map((family) => (
                <optgroup key={family} label={EFFECT_FAMILY_LABELS[family]}>
                  {EFFECT_FAMILIES[family].map((effect) => <option key={effect} value={effect}>{TEXT_ANIMATION_LABELS[effect]}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        </>
      )}
      <button type="button" className="btn btn-block" disabled={!draft.text.trim()} onClick={() => onSave({ ...draft, text: draft.text.trim() })}>
        {initial ? "Save text" : draft.callout ? "Add callout" : "Add text"}
      </button>
    </Sheet>
  );
}

/** Visual hooks (ADR 0041): the opener that stops the scroll. */
export function HookSheet({ hook, hasPerson, studio, onChange, onWords, onClose }: {
  hook: Hook | null; hasPerson: boolean;
  /** The Hook studio (ADR 0068): the five opening patterns as live cards. It leads; the drawn openers below fold away. */
  studio?: ReactNode;
  onChange(hook: Hook | null): void; onWords(words: string[], color: string): void; onClose(): void;
}) {
  const [kind, setKind] = useState<HookKind | "words-behind">(hook?.kind ?? "words-behind");
  const [draft, setDraft] = useState<Hook>(hook ?? { kind: "alert", durationMs: 2200, title: "", body: "", action: "", color: "#ff5a5f", font: "sans" });
  const [words, setWords] = useState("THIS · HOUSE · SOLD");
  const update = (patch: Partial<Hook>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <Sheet title="Hook" onClose={onClose}>
      {studio}
      <details className="hook-drawn" open={!studio || hook !== null} data-testid="hook-drawn">
      <summary className="small">{studio ? "A drawn opener instead" : "Pick an opener built from your first shot."}</summary>
      <p className="muted small">{studio ? "An alert, a spotlight or a device over the first shot." : "The first two seconds decide whether anyone watches."}</p>
      <div className="field" role="radiogroup" aria-label="Hook">
        {(["words-behind", "alert", "spotlight", "device"] as const).map((k) => (
          <label key={k} className="small" style={{ display: "block", marginBottom: 6 }}>
            <input type="radio" name="hook-kind" checked={kind === k} onChange={() => setKind(k)} /> <strong>{HOOK_LABELS[k]}</strong> — {HOOK_DESCRIPTIONS[k]}
          </label>
        ))}
      </div>
      {kind === "words-behind" ? (
        <>
          <label className="field">Three words, separated by ·<input className="text-input" value={words} onChange={(e) => setWords(e.target.value)} maxLength={60} /></label>
          {!hasPerson ? <p className="small">Works best when the first shot has a person walking; otherwise the words sit on the picture.</p> : null}
          <div className="swatches" role="group" aria-label="Colour">{TEXT_COLORS.map((color) => <button key={color} type="button" className="swatch" aria-label={color} aria-pressed={draft.color === color} style={{ background: color }} onClick={() => update({ color })} />)}</div>
          <button type="button" className="btn btn-signal btn-block" data-testid="hook-apply" onClick={() => { onWords(words.split(/[·,|/]/), draft.color); onClose(); }}>Put the words behind the person</button>
        </>
      ) : (
        <>
          <label className="field">{kind === "alert" ? "Alert title" : "Big line"}<input className="text-input" value={draft.title} maxLength={80} placeholder={kind === "alert" ? "Price drop" : kind === "spotlight" ? "4 BEDS.\nZERO NEIGHBOURS." : "Swipe in"} onChange={(e) => update({ title: e.target.value })} /></label>
          {kind === "alert" ? <>
            <label className="field">Alert text<input className="text-input" value={draft.body} maxLength={140} placeholder="12 Harbour Lane just dropped to $1.2M." onChange={(e) => update({ body: e.target.value })} /></label>
            <label className="field">Button<input className="text-input" value={draft.action} maxLength={24} placeholder="See inside" onChange={(e) => update({ action: e.target.value })} /></label>
          </> : null}
          {kind === "spotlight" ? <>
            <div className="swatches" role="group" aria-label="Colour">{TEXT_COLORS.filter((c) => c !== "#ffffff").map((color) => <button key={color} type="button" className="swatch" aria-label={color} aria-pressed={draft.color === color} style={{ background: color }} onClick={() => update({ color })} />)}</div>
            {!hasPerson ? <p className="small">Needs a person in the first shot, ideally a medium shot; the colour sits behind them.</p> : null}
          </> : null}
          <Segmented label="Type" options={HOOK_FONTS} value={draft.font} onChange={(font) => update({ font })} format={(f) => ({ sans: "Archivo", serif: "Playfair" })[f]} />
          <Range label="Holds for" value={draft.durationMs} min={800} max={4000} step={100} display={formatDuration(draft.durationMs, true)} onChange={(durationMs) => update({ durationMs })} />
          <button type="button" className="btn btn-signal btn-block" data-testid="hook-apply" onClick={() => { onChange({ ...draft, kind }); onClose(); }}>{hook ? "Update the hook" : "Add the hook"}</button>
          {hook ? <button type="button" className="btn btn-quiet btn-block" onClick={() => { onChange(null); onClose(); }}>Remove the hook</button> : null}
        </>
      )}
      </details>
    </Sheet>
  );
}

/** Pin a text to the surface under it so it moves with the camera (ADR 0039). */
/**
 * Tracks the surface under a title through its shot and returns what to store
 * (ADR 0039/0044). Shared by the Pin sheet and the full-screen placing mode's
 * Track button, so both follow the same rules.
 */
export async function pinTitle({ text, clip, asset, clipStartMs, wholeShot, lean, onProgress, signal }: {
  text: TextOverlay; clip: Clip; asset: LibraryAsset; clipStartMs: number; wholeShot: boolean; lean: { yaw: number; pitch: number }; onProgress?(fraction: number): void;
  /** Aborting stops the track at its next step (ADR 0047); the result is then `{ error, cancelled: true }`. */
  signal?: AbortSignal;
}): Promise<{ pinned: { path: TextOverlay["path"]; pin: TextOverlay["pin"] }; patch: { startMs?: number; endMs?: number; x?: number }; status: string } | { error: string; cancelled?: boolean }> {
  const timing = wholeShot ? { startMs: clipStartMs, endMs: clipStartMs + clipDurationMs(clip) } : { startMs: text.startMs, endMs: text.endMs };
  // Corners may have been placed in any order: the plane is tracked, and stored, upright.
  const upright = text.surface ? { ...text, surface: orientQuad(text.surface).map(v => Number(v.toFixed(4))) } : text;
  // The tracker reports after every step; a cancelled track throws there, which ends it like a failed read.
  const progress = (fraction: number) => { if (signal?.aborted) throw new DOMException("Tracking was cancelled.", "AbortError"); onProgress?.(fraction); };
  if (signal?.aborted) return { error: "Tracking was cancelled.", cancelled: true };
  const tracked = await trackTextPathDetailed(asset, clip, clipStartMs, { ...upright, ...timing }, progress, lean);
  if (signal?.aborted) return { error: "Tracking was cancelled.", cancelled: true };
  // The tracker says why it refused (too few features inside the surface, lost at a frame, degenerate motion; ADR 0052).
  if ("error" in tracked) return { error: tracked.error };
  // A title that starts cut off at the frame edge never reads as being on the wall: with the plane
  // known (and leaned), move the centre so the warped line begins fully in frame. The path is relative, so the pin follows.
  // A title on a chosen surface stays on it (the text is fitted and clipped inside); only a box pin is moved in from the frame edge.
  const shift = tracked.pin.quad && !text.surface ? planarShift(text, tracked.pin.quad) : 0;
  const nudged = Math.abs(shift) > 0.002 ? Number((text.x + shift).toFixed(4)) : text.x;
  // A planar title is drawn from its corners, not its centre: move the pinned plane and every keyframe's corners too.
  const moveQuad = (q: readonly number[] | undefined) => q ? q.map((v, i) => Number((i % 2 === 0 ? v + shift : v).toFixed(4))) : q;
  const pinned = nudged === text.x ? { path: tracked.path, pin: tracked.pin } : {
    path: tracked.path.map(point => ({ ...point, ...(point.q ? { q: moveQuad(point.q) as number[] } : {}) })),
    pin: { ...tracked.pin, quad: moveQuad(tracked.pin.quad) as number[] | undefined },
  };
  const { path, lostAtMs, quality } = tracked;
  const lostNote = lostAtMs !== null ? ` The surface was lost ${((lostAtMs - tracked.pin.fromMs) / 1000 / (clip.speed || 1)).toFixed(1)} s in, so the title fades there.` : "";
  const nudgeNote = nudged !== text.x ? ` Moved the title ${nudged < text.x ? "left" : "right"} so it starts fully in frame.` : "";
  const gradeNote = quality.grade === "good" ? `Good track: ${quality.inliers} points agreed on every step.` : quality.grade === "weak" ? `Weak track: only ${quality.inliers} points agreed and ${quality.held} of ${quality.steps} steps were held. Try a surface with more detail, or a bigger area of it.` : "The surface could not be followed to the end.";
  return {
    pinned,
    patch: { ...(wholeShot ? timing : {}), ...(nudged !== text.x ? { x: nudged } : {}) },
    status: `${gradeNote} ${path.length} keyframes${wholeShot ? ", for the whole shot" : ""}.${lostNote}${nudgeNote}`,
  };
}

export function PinSheet({ text, clip, asset, clipStartMs, placementVersionNow, onPath, onPlaceOnSurface, onSurface, onBars, onCheck, onPlaceCorners, onDrawCutout, onClose }: {
  text: TextOverlay; clip: Clip | null; asset: LibraryAsset | undefined; clipStartMs: number;
  /** The title's placement version in the current timeline (core `placementVersion`), read when a track starts and when it ends. */
  placementVersionNow?(): string;
  onPath(pinned: { path: TextOverlay["path"]; pin: TextOverlay["pin"] } | undefined, patch?: { startMs?: number; endMs?: number; x?: number }): void;
  /** "Put on a surface" (ADR 0075): the title was laid on a surface the app found, with its track when it could be followed: one edit. */
  onPlaceOnSurface?(placement: TitleOnSurface): void;
  /** The surface the title is painted on was set, found or cleared (also drops any pin, which must be redone on the new plane). */
  onSurface?(surface: number[] | undefined): void;
  /** The posts in front of the surface changed (ADR 0044). */
  onBars?(bars: number[][]): void;
  /** Open check mode: the frame full screen with five moments per shot to look at. */
  onCheck?(): void;
  /** Open corner placing: the frame full screen with the corners and a loupe. */
  onPlaceCorners?(): void;
  /** Open the cut-out tool full screen: tap around something in front of the surface. */
  onDrawCutout?(): void;
  onClose(): void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A title that is in the room is there for the whole shot: on the wall when the cut lands, gone with the cut or the pan.
  const [wholeShot, setWholeShot] = useState(true);
  // The wall's perspective: a title on a wall seen from the side recedes with it.
  const [yaw, setYaw] = useState(text.pin?.lean?.yaw ?? 0);
  const [pitch, setPitch] = useState(text.pin?.lean?.pitch ?? 0);
  const canTrack = Boolean(clip && clip.kind === "VIDEO" && asset);
  // A track answers for the placement it started from (ADR 0047): closing the sheet cancels it, and a
  // result for corners or a shot changed meanwhile is dropped rather than written over the new placement.
  const tracking = useRef<AbortController | null>(null);
  const lean = useRef({ yaw, pitch });
  lean.current = { yaw, pitch };
  useEffect(() => () => tracking.current?.abort(), []);
  async function pin() {
    if (!clip || !asset) return;
    tracking.current?.abort();
    const controller = new AbortController();
    tracking.current = controller;
    // The lean set here is part of the placement too, until it is stored with the pin.
    const versionNow = () => `${placementVersionNow?.() ?? ""}|${lean.current.yaw}|${lean.current.pitch}`;
    const version = versionNow();
    setBusy(true); setStatus("Following the surface under the text…");
    // A callout follows its point: a small square around it, tracked like a surface (ADR 0061).
    const result = await pinTitle({ text: text.callout ? calloutTrackTarget(text) : text, clip, asset, clipStartMs, wholeShot, lean: { yaw, pitch }, signal: controller.signal, onProgress: fraction => setStatus(`Following the surface under the text… ${Math.round(fraction * 100)}%`) });
    if (controller.signal.aborted) return;
    tracking.current = null;
    setBusy(false);
    if ("error" in result) { setStatus(result.error); return; }
    if (versionNow() !== version) { setStatus("The title or its shot changed while tracking, so that track was discarded. Pin again."); return; }
    onPath(result.pinned, result.patch);
    setStatus(result.status);
  }
  if (text.callout) {
    return (
      <Sheet title="Pin the callout" onClose={onClose}>
        <p className="muted small">The dot follows the feature as the camera moves, and the label travels with it. Drag the blue dot onto the feature first; where it cannot be followed, the callout fades out.</p>
        <label className="field small"><input type="checkbox" checked={wholeShot} onChange={event => setWholeShot(event.target.checked)} /> For the whole shot</label>
        <button type="button" className="btn btn-signal btn-block" disabled={!canTrack || busy} onClick={pin} data-testid="pin-callout">{busy ? "Following…" : text.path && text.path.length > 2 ? "Pin again" : "Pin to the feature"}</button>
        {!canTrack ? <p className="small">Pinning needs the callout to start on a video clip.</p> : null}
        {text.path ? <button type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => { onPath(undefined); setStatus("Unpinned."); }}>Unpin (still callout)</button> : null}
        {status ? <p role="status" className="small">{status}</p> : null}
      </Sheet>
    );
  }
  return (
    <Sheet title="Pin to the picture" onClose={onClose}>
      {onPlaceOnSurface ? <SurfacePicker text={text} clip={clip} asset={asset} clipStartMs={clipStartMs} placementVersionNow={placementVersionNow} onPlace={onPlaceOnSurface} /> : null}
      <p className="muted small">{onPlaceOnSurface ? "Or set the surface yourself. " : ""}The title is painted on a flat surface and follows it as the camera moves. The playhead is on the first frame of the shot: set the surface here, then pin.</p>
      <h3 className="small" style={{ margin: "8px 0 4px" }}>1. The surface</h3>
      <div className="row" style={{ display: "flex", gap: 8 }}>
        {text.surface ? null : (
          <button type="button" className="btn btn-signal btn-block" disabled={busy} data-testid="surface-corners" onClick={() => {
            // A box around the title to start from: the corners are then dragged onto the wall, road or window.
            const w = Math.min(0.9, 0.3 + text.size * 0.5), h = w * 0.22;
            const x0 = Math.max(0.02, Math.min(0.98 - w, text.x - w / 2)), y0 = Math.max(0.02, Math.min(0.98 - h, text.y - h / 2));
            onSurface?.([x0, y0, x0 + w, y0, x0 + w, y0 + h, x0, y0 + h].map(v => Number(v.toFixed(4))));
            setStatus("Drag the four red corners onto the surface's own corners: 1 top left, 2 top right, 3 bottom right, 4 bottom left. The title fills whatever shape you make.");
            onPlaceCorners?.();
          }}>Set the four corners</button>
        )}
        {text.surface && onPlaceCorners ? (
          <button type="button" className="btn btn-signal btn-block" disabled={busy} data-testid="place-corners" onClick={onPlaceCorners}>Place the corners full screen</button>
        ) : null}
        <button type="button" className={text.surface ? "btn btn-quiet" : "btn btn-block"} disabled={!canTrack || busy} data-testid="find-surface" onClick={async () => {
          if (!clip || !asset) return;
          setBusy(true); setStatus("Looking for the wall's edges around the text…");
          const found = await detectSurface(asset, clip, clipStartMs, text);
          setBusy(false);
          if (!found) { setStatus("No clear edges around the text. Set the four corners by hand instead."); return; }
          onSurface?.(found.quad);
          setStatus(`Suggested a surface${found.weakest < 40 ? " (one edge is faint: check the corners)" : ""}. Drag the corners if they are off, then pin.`);
        }}>{text.surface ? "Suggest corners" : "Suggest corners"}</button>
        {text.surface ? <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => { onSurface?.(undefined); setStatus("Back to a box around the text."); }}>Use a box</button> : null}
      </div>
      <p className="muted small">{text.surface ? "The title is painted inside this surface, with its perspective, and clipped to it. Drag the red corners to the surface's edges; the title scales to fill it." : "Or turn and tilt a box by hand below."}</p>
      {text.surface && onBars ? (<>
        <h3 className="small" style={{ margin: "8px 0 4px" }}>2. Posts in front</h3>
        <div className="row" style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-block" disabled={busy || (text.bars?.length ?? 0) >= 8} data-testid="add-post" onClick={() => {
            // A post stands across the surface: a strip the surface's full height, starting mid-way, its two edges dragged onto the real post.
            const q = text.surface!;
            const at = (text.bars?.length ?? 0) ? 0.35 + 0.1 * text.bars!.length : 0.5;
            const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
            const topX = lerp(q[0], q[2], at), topY = lerp(q[1], q[3], at), bottomX = lerp(q[6], q[4], at), bottomY = lerp(q[7], q[5], at);
            const half = 0.015;
            onBars([...(text.bars ?? []), [topX - half, topY, topX + half, topY, bottomX + half, bottomY, bottomX - half, bottomY].map(v => Number(v.toFixed(4)))]);
            setStatus("Drag the yellow edges onto the post's edges. The title is cut out where the post stands, so the post stays in front of it.");
            onPlaceCorners?.();
          }}>{text.bars?.length ? `Add another post (${text.bars.length})` : "Add a post"}</button>
          {text.bars?.length ? <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => onBars([])}>Remove posts</button> : null}
          {onDrawCutout ? <button type="button" className="btn btn-signal btn-block" disabled={busy} data-testid="draw-cutout" onClick={onDrawCutout}>{text.occluders?.length ? `In front (${text.occluders.length} tapped)` : "Tap what is in front"}</button> : null}
        </div>
        <p className="muted small">Tap the plant, chair back or railing in front of the surface, full screen: it is cut out on every frame and the title goes behind it. A post is a straight strip for a mullion or a pole; a shape can also be drawn by hand.</p>
      </>) : null}
      <h3 className="small" style={{ margin: "8px 0 4px" }}>{text.surface ? "3. Pin" : "2. Pin"}</h3>
      <label className="field small"><input type="checkbox" checked={wholeShot} onChange={event => setWholeShot(event.target.checked)} /> For the whole shot: already there when the shot starts, gone when it ends</label>
      {text.surface ? null : <Range label="Turn" value={yaw} min={-60} max={60} step={1} display={yaw === 0 ? "Facing camera" : yaw > 0 ? `Right edge recedes ${yaw}°` : `Left edge recedes ${-yaw}°`} onChange={setYaw} />}
      {text.surface ? null : <Range label="Tilt" value={pitch} min={-60} max={60} step={1} display={pitch === 0 ? "Level" : pitch > 0 ? `Top recedes ${pitch}°` : `Bottom recedes ${-pitch}°`} onChange={setPitch} />}
      {text.surface ? null : <p className="muted small">Match the wall: a wall running away to the right wants Turn to the right; a floor or ceiling wants Tilt. Pin again after changing them.</p>}
      <button type="button" className="btn btn-signal btn-block" disabled={!canTrack || busy} onClick={pin} data-testid="pin-text">{busy ? "Following…" : text.path && text.path.length > 2 ? "Pin again from these corners" : "Pin to the picture"}</button>
      {!canTrack ? <p className="small">Pinning needs the text to start on a video clip.</p> : null}
      {text.path && text.path.length > 2 && onCheck ? <button type="button" className="btn btn-block" disabled={busy} data-testid="check-pin" onClick={onCheck}>Check it: five frames of every shot, full screen</button> : null}
      {text.path && text.path.length > 2 ? <p className="muted small">If the surface slides off the frame before the cut, shorten the title under Timing: a pinned title that ends early fades out.</p> : null}
      {text.path ? <button type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => { onPath(undefined); setStatus("Unpinned."); }}>Unpin (still text)</button> : null}
      {status ? <p role="status" className="small">{status}</p> : null}
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
  popular,
  beat,
}: {
  library: LibraryAsset[];
  music: Music | null;
  /** Energy and "On the beat" (ADR 0059), shown with the song in use. */
  beat?: React.ReactNode;
  uploading: boolean;
  instagram: InstagramSoundAccess;
  /** The reel's moods and length, for the "Popular now" row (ADR 0058). */
  popular?: { moods: MusicMoodId[]; reelMs: number };
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
          {beat}
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
                  Instagram auto-posting starts this sound at 0:00 and cannot skip an intro. To choose a later start, finish the post in Instagram, or choose your own music below.
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
          {popular ? (
            <PopularSounds
              moods={popular.moods}
              reelMs={popular.reelMs}
              selectedId={fromInstagram ? (instagramSound?.audioId ?? music?.instagramAudioId ?? null) : null}
              busyId={instagramBusyId}
              disabled={instagramBusyId !== null}
              onSelect={(track) => {
                busyTitle.current = track.title;
                onPickInstagram(track);
              }}
            />
          ) : null}
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
  critic = null,
  findingCount = 0,
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
  /** The critic's findings (ADR 0062), shown above the export button. */
  critic?: React.ReactNode;
  findingCount?: number;
  onExport(): void;
  onShowIssue(issue: Issue): void;
  onClose(): void;
}) {
  const ready = canExport(issues);
  const worthALook = ready && findingCount > 0;
  return (
    <Sheet title={ready ? "Export for Instagram" : "Not ready to export"} onClose={onClose}>
      <p className="muted">
        {formatDuration(durationMs, true)} reel, rendered as an MP4 at 30 fps (the size depends on your plan). Usually ready in about {renderMinutes(durationMs)}; you can
        keep editing while it renders.
      </p>
      {/* A quiet note, and only when the critic found something real: exporting is never gated on it (ADR 0081). */}
      {worthALook ? (
        <p className="muted small" data-testid="export-note">
          {findingCount === 1 ? "One thing is worth a look before you post." : `${findingCount} things are worth a look before you post.`}
        </p>
      ) : null}
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
      {ready ? critic : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {error && upgrade ? (
        <Link href="/pricing" className="btn btn-block" data-testid="upgrade-link">
          See plans
        </Link>
      ) : null}
      <button type="button" className="btn btn-signal btn-block" disabled={!ready || busy} onClick={onExport} data-testid="confirm-export">
        {busy ? "Starting export…" : "Export"}
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
  onDirector,
  briefs,
  fresh,
  onAsk,
  onSaveBrief,
  onDeleteBrief,
  onClose,
  initialRequest = "",
  autoSubmit = false,
}: {
  onDirector?: () => void;
  briefs: Brief[];
  /** The reel has not been cut yet, so briefs lead. */
  fresh: boolean;
  onAsk(request: string, answers: { question: string; answer: string }[]): Promise<AskOutcome>;
  onSaveBrief(name: string, text: string): Promise<{ ok: true } | { ok: false; message: string }>;
  onDeleteBrief(id: string): Promise<void>;
  onClose(): void;
  /** Words typed in the always-there Ask box (ADR 0064). */
  initialRequest?: string;
  /** Run them as soon as the sheet opens. */
  autoSubmit?: boolean;
}) {
  const [request, setRequest] = useState(initialRequest);
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

  // Sent from the Ask box: run once, on open.
  const autoSent = useRef(false);
  useEffect(() => {
    if (!autoSubmit || autoSent.current) return;
    autoSent.current = true;
    void submit();
    // Once, when the sheet opens.
  }, []);

  async function keep() {
    const name = window.prompt("Name this preset", "")?.trim();
    if (!name) return;
    const result = await onSaveBrief(name, request.trim());
    setSaved(result.ok ? `Kept as “${name}”.` : result.message);
  }

  return (
    <Sheet title={fresh ? "Cut it for me" : "Ask for a change"} onClose={onClose}>
      {onDirector ? <button type="button" className="btn btn-quiet btn-block" onClick={onDirector}>Tell Opus what you think of the whole reel</button> : null}
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
  { id: "open-house", name: "Open home" },
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
                <input className="text-input" value={info.address} placeholder="14 Banksia Avenue, Bronte" maxLength={80} enterKeyHint="next" onChange={set("address")} />
              </label>
              <label className="field">
                Price
                <input className="text-input" value={info.price} placeholder="$1,250,000" maxLength={24} inputMode="decimal" enterKeyHint="next" onChange={set("price")} />
              </label>
              <label className="field">
                Size
                <input className="text-input" value={info.area} placeholder="240 m²" maxLength={16} inputMode="decimal" enterKeyHint="next" onChange={set("area")} />
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
                  Add $ and m² for me
                  {units && (info.price || info.area) ? (
                    <span className="muted small units-preview">
                      {" "}
                      Shows as {[info.price && formatPrice(info.price), info.area && formatArea(info.area)].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </span>
              </label>
              <label className="field wide">
                Open home (if there is one)
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

