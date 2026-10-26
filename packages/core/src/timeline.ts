import { walkInto } from "./walk";
import { z } from "zod";
import { cameraSchema } from "./camera";
import { rampSchema, rampUnwarp, rampWarp, sliceRamp } from "./ramp";
import { planOverlaySchema, roomTitle, spotSchema, type PlanOverlay } from "./plan";
import { colorMatchSchema, colorStatsSchema, lookSchema } from "./look";
import { textTreatmentSchema } from "./brand-fonts";

/**
 * A reel's edit, as a plain JSON document. The browser edits it, Postgres
 * stores it, and the same Remotion component renders it in the preview and in
 * the worker. Every operation here is a pure function that returns a new
 * timeline, which is what makes undo/redo and autosave simple.
 *
 * Model (the same as Instagram's and CapCut's editors):
 * - one main track of clips, played back to back, no gaps
 * - text overlays placed at absolute times on top
 * - one optional music track under everything
 */

export const REEL_FORMAT = { width: 1080, height: 1920, fps: 30 } as const;

/**
 * The lowest a title may sit (y, 0 at the top, 1 at the bottom): below it
 * Instagram's caption, audio label and buttons cover the frame. One value
 * for the first cut, the caption guard, the export check and the model's
 * prompt, so they cannot disagree.
 */
export const TEXT_SAFE_BOTTOM = 0.72;

/** Where a room label sits when labels are on: clear of the safe-zone limit. */
export const ROOM_LABEL_Y = 0.66;

/** Words for a shot that is not a room: a label would read as nonsense over it. */
export const NON_ROOM_NAME = /\b(aerial|exterior|facade|façade|views?|drone|street|outside|arrival|sunset|dusk|skyline|overhead|establishing)\b/i;

/** Shortest clip the editor will produce by trimming or splitting. */
export const MIN_CLIP_MS = 500;
/** Default on-screen time for a photo. */
export const DEFAULT_IMAGE_MS = 3000;
export const DEFAULT_TEXT_MS = 3000;

export const SPEEDS = [0.5, 1, 1.5, 2, 3] as const;
/** "golden" is late-afternoon light, "dusk" a twilight cast, "crisp" the bright, clean look of listing photography. */
export const FILTERS = ["none", "warm", "cool", "vivid", "mono", "fade", "golden", "dusk", "crisp"] as const;
export const MOTIONS = ["none", "zoom-in", "zoom-out", "pan", "snap-in", "snap-out"] as const;
/**
 * How a clip enters from the one before. "cut" is no transition and the default; "fade" is Remotion's crossfade (ADR
 * 0083); "walk" moves the camera between two 360 photos of the same home (see walk.ts). The Remotion toolbox (ADR
 * 0082) adds three for the lively look and the close, never a default: "softDissolve" (a crossfade with a 3 % breath of
 * scale), "focusPull" (a rack focus through a soft blur) and "lightLeak" (a soft warm glint over a hard cut, which keeps
 * the cut on its frame).
 */
export const TRANSITIONS = ["cut", "fade", "walk", "softDissolve", "focusPull", "lightLeak"] as const;
/**
 * Kinds the owner retired on 2026-10-26 (ADR 0082): the whip pan and the speed-ramp transition. Saved reels that carry
 * them still load: the schema reads either as a plain cut (`migrateTransition`), so nothing offers, draws or stores them.
 */
export const RETIRED_TRANSITIONS = ["whip", "speedRamp"] as const;
/** A saved `transitionIn` as the schema reads it: a retired kind is a cut, anything else is left for the enum to check. */
export function migrateTransition(value: unknown): unknown {
  return (RETIRED_TRANSITIONS as readonly unknown[]).includes(value) ? "cut" : value;
}
/**
 * "elegant" is a thin white serif that fades in, for luxury reels where the
 * imagery leads. "tag" is a small lacquer sticker for a status (JUST LISTED,
 * PRICE DROP, SOLD) that sits at the top of the safe area. "location" is a location lower third (ADR 0082, Remotion
 * Elements' Location Lower Third in the house serif): a pin that draws itself, then the line revealed beside it.
 */
export const TEXT_STYLES = ["plain", "box", "outline", "headline", "elegant", "tag", "location"] as const;
/**
 * How a text arrives: "auto" is the style's own way in (a pop for the bold
 * styles; for the elegant serif the track-in since ADR 0082, the owner's pick; it was a slow fade), "type" writes it out letter by
 * letter, "rise" drifts up as it fades in, "none" is simply there.
 * The quiet reveals of the Remotion toolbox (ADR 0082): "fadeQuick" a 200 ms fade in and out, "maskUp" the line rises
 * through a hard edge over 6 frames, "trackIn" the letter-spacing closes as it fades up, "blurIn" it resolves out of
 * a soft blur. "blurQuick" (ADR 0089) is the keyword arrival measured in the owner's reference reel: out of an 8 px
 * blur in 200 ms, no drift, gone in 150 ms.
 */
export const TEXT_ANIMATIONS = ["auto", "pop", "fade", "rise", "type", "none", "fadeQuick", "maskUp", "trackIn", "blurIn", "blurQuick"] as const;
/** Particle kinds a title can carry (ADR 0055). */
export const PARTICLE_KINDS = ["snow", "embers", "dust"] as const;
export type ParticleKind = (typeof PARTICLE_KINDS)[number];
/** Light on the letters (ADR 0061): a soft sweep, glints on the letter edges, or a warm golden-hour pass with a lens flare. */
export const SHINE_PRESETS = ["sweep", "glint", "golden"] as const;
export type ShinePreset = (typeof SHINE_PRESETS)[number];
/**
 * Kinetic type (ADR 0061): word by word, sliding out from behind something in front of the surface, or a number counting up.
 * "caption" (ADR 0089): one word at a time, each replacing the one before on its onset (`wordsMs`), the single-word
 * caption track of a keyword lockup.
 */
export const KINETIC_PRESETS = ["words", "behind", "count", "caption"] as const;
/**
 * The roles of a keyword lockup's titles (ADR 0089): the big hero word, the small one-word caption track around it, and
 * (the addendum) a companion line interlocked with the keyword in a short phrase.
 */
export const LOCKUP_ROLES = ["keyword", "captions", "companion"] as const;
/** Largest `size` of a lockup's keyword (ADR 0089): the elegant serif's capitals at about 14 % of the frame's height. */
export const KEYWORD_SIZE_MAX = 7.2;
export type KineticPreset = (typeof KINETIC_PRESETS)[number];
/** The latest a shine or kinetic move may start, ms after its title appears (the schema's bound; ADR 0061). */
export const TYPE_MOTION_START_MAX_MS = 60_000;
/** Where a logo may sit. */
export const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
/** Where the status tag sits: the top of the safe area, above the hook. */
export const TAG_Y = 0.3;
export const TEXT_COLORS = ["#ffffff", "#111111", "#ffd23f", "#ff5a5f", "#3ddc97", "#4da3ff"] as const;

/**
 * How an end card arrives (ADR 0082): "cut" (the default) the plate is there on the cut, the line in small tracked
 * capitals; "leak" a soft warm glint hides the cut to the plate. The first gallery also had "fade" (ADR 0065's) and
 * "over" (no plate); the owner kept these two, so a saved "fade" or "over" reads as "cut".
 */
export const END_CARD_REVEALS = ["cut", "leak"] as const;
/** A saved `endCard.reveal` as the schema reads it. */
export function migrateEndCardReveal(value: unknown): unknown {
  return value === "fade" || value === "over" ? "cut" : value;
}

export type Filter = (typeof FILTERS)[number];
export type Motion = (typeof MOTIONS)[number];
export type Transition = (typeof TRANSITIONS)[number];
export type TextStyle = (typeof TEXT_STYLES)[number];
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number];
export type Corner = (typeof CORNERS)[number];

/**
 * How a title really arrives: its `animation`, with "auto" read as its style's own way in. The elegant serif tracks in
 * (ADR 0082, the owner's pick of the gallery: "track-in title is way better"; it was a 0.6 s fade); a location lower
 * third has its own reveal (none here); every other style pops.
 */
export function titleArrival(text: Pick<TextOverlay, "animation" | "style">): Exclude<TextAnimation, "auto"> {
  if (text.animation !== "auto") return text.animation;
  return text.style === "elegant" ? "trackIn" : text.style === "location" ? "none" : "pop";
}

/** Allowed `size` of a text overlay. The elegant serif may go smaller than the bold styles. */
export const TEXT_SIZE_MAX = 2.5;
export function minTextSize(style: TextStyle): number {
  return style === "elegant" || style === "tag" ? 0.3 : 0.5;
}
/** Longest zoom into a clip: twice, a tight crop of a 4K phone video without going soft. */
export const ZOOM_MAX = 2;

const ms = z.number().int().min(0);
const unit = z.number().min(0).max(1);

/**
 * Camera move through a 360 photo (equirectangular image). Angles are in
 * degrees: yaw turns left/right, pitch tilts up/down, fov is the zoom.
 */
export const panoSchema = z.object({
  yawStart: z.number().min(-360).max(360),
  yawEnd: z.number().min(-360).max(360),
  pitch: z.number().min(-60).max(60).default(0),
  fov: z.number().min(40).max(120).default(90),
});
export type PanoView = z.infer<typeof panoSchema>;

/** A slow quarter-turn, which suits a room shown for a few seconds. */
export const DEFAULT_PANO: PanoView = { yawStart: -45, yawEnd: 45, pitch: 0, fov: 90 };
/** On-screen time for a 360 photo: long enough for the sweep to read. */
export const DEFAULT_PANO_MS = 5000;

/**
 * Camera yaw at a point in the clip (`progress` from 0 to 1). The turn eases
 * in and out. Shared by the 360 view and the floor plan's view cone.
 */
export function panoYawAt(pano: PanoView, progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  return pano.yawStart + (pano.yawEnd - pano.yawStart) * (t * t * (3 - 2 * t));
}

/** 360 cameras save a 2:1 equirectangular image. */
export function isEquirect(width: number | null | undefined, height: number | null | undefined): boolean {
  if (!width || !height || width < 2000) return false;
  const ratio = width / height;
  return ratio > 1.95 && ratio < 2.05;
}

export const clipSchema = z
  .object({
    id: z.string().min(1),
    assetId: z.string().min(1),
    kind: z.enum(["VIDEO", "IMAGE"]),
    /**
     * Window of the source that plays, in source time. For a photo this is
     * simply 0..on-screen duration.
     */
    sourceStartMs: ms,
    sourceEndMs: ms,
    /** Playback speed. Ignored for photos. */
    speed: z.number().min(0.25).max(4).default(1),
    /** Volume of the clip's own audio. */
    volume: unit.default(1),
    /** cover: fill 9:16 and crop. contain: show the whole frame with a blurred backdrop. */
    fit: z.enum(["cover", "contain"]).default("cover"),
    filter: z.enum(FILTERS).default("none"),
    /** Camera movement layered on photos or video. */
    motion: z.enum(MOTIONS).default("none"),
    /** Soft lens edges; the centre stays sharp. This does not estimate scene depth. */
    lensSoftness: unit.optional(),
    /** Set for 360 photos: the camera sweep. Null shows the image flat. */
    pano: panoSchema.nullable().default(null),
    /** Where the shot was taken on the floor plan, when known. */
    spot: spotSchema.nullable().default(null),
    /** Name of the room, when known ("kitchen"). */
    room: z.string().max(40).nullable().default(null),
    /** How this clip enters from the previous one. A retired kind (a whip, a speed ramp) saved before ADR 0082 reads as a cut. */
    transitionIn: z.preprocess(migrateTransition, z.enum(TRANSITIONS).default("cut")),
    /** The camera pan of a whip (retired, ADR 0082). Kept so a saved reel round-trips; nothing reads it. */
    whipDirection: z.enum(["left", "right", "up", "down"]).optional(),
    /** A closer crop of the picture about its centre: 1 shows it all, 2 the middle half. Added to any motion. */
    zoom: z.number().min(1).max(ZOOM_MAX).default(1),
    /**
     * A J-cut (ADR 0069): the sound under this clip comes from another asset, from `sourceStartMs` of that asset at
     * 1×, and this clip's own sound is not played. A cutaway over a presenter line keeps her voice going.
     * Absent on every reel saved before it, so nothing already saved changes.
     */
    audio: z.object({ assetId: z.string().min(1), sourceStartMs: ms, volume: unit.default(1) }).optional(),
    /** A speed ramp (ADR 0067): playback shaped inside the window, slow to fast or back; the mean stays `speed`. Absent or null: constant speed. */
    ramp: rampSchema.nullable().optional(),
    /** An eased camera move (ADR 0067): keyframed scale and position. When set, `motion` is not read. Absent or null: `motion` as before. */
    camera: cameraSchema.nullable().optional(),
    /** Measured colour statistics of this clip's source (ADR 0070), kept so the look can be re-matched without reading pixels again. */
    colorStats: colorStatsSchema.optional(),
    /** The colour transform that moves this clip onto the reel's reference look (ADR 0070), applied under the `filter` preset. Absent: none. */
    colorMatch: colorMatchSchema.optional(),
  })
  .refine((clip) => clip.sourceEndMs > clip.sourceStartMs, { message: "Clip must have a positive length" });

export const textSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().trim().min(1).max(200),
    startMs: ms,
    endMs: ms,
    /** Centre of the text box, as a fraction of the frame. */
    x: unit.default(0.5),
    y: unit.default(0.4),
    style: z.enum(TEXT_STYLES).default("plain"),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).default("#ffffff"),
    /** Scale relative to the default size. */
    size: z.number().min(minTextSize("elegant")).max(KEYWORD_SIZE_MAX).default(1),
    /**
     * Placed by the app itself (the room labels, the opening line of a quick cut), not by a person (ADR 0081).
     * The export check only warns about text a person placed or moved; `updateText` drops this when a
     * title's x or y changes. Absent on every text saved before it existed, which then counts as placed.
     */
    byApp: z.literal(true).optional(),
    animation: z.enum(TEXT_ANIMATIONS).default("auto"),
    font: z.enum(["auto", "serif", "sans", "editorial"]).optional(),
    shadow: z.enum(["auto", "soft", "strong", "none"]).optional(),
    tracking: z.number().min(-0.04).max(0.24).optional(),
    /**
     * A brand kit style applied to this title (ADR 0078): a bundled brand face and weight, a faux slant, a hard offset shadow
     * and a plate with an edge, copied from the kit so the reel renders the same without it. Absent on every reel saved before
     * it, which render exactly as before. Where present it replaces the style's own face, shadow and plate.
     */
    brand: textTreatmentSchema.optional(),
    /**
     * Set when `path` was tracked on a clip (ADR 0039): the keyframes' t runs over
     * this source window of that asset, so the pin survives trims and reorders.
     */
    pin: z.object({ assetId: z.string().min(1), fromMs: ms, toMs: ms, /** The corners the text was laid on at pin time, matching each keyframe's `q`. */ quad: z.array(z.number().min(-2).max(3)).length(8).optional(), /** How the plane was turned and tilted into the wall's perspective, degrees. */ lean: z.object({ yaw: z.number().min(-60).max(60), pitch: z.number().min(-60).max(60) }).optional() }).optional(),
    /** People in the clips this text overlaps pass in front of it (ADR 0039). */
    behind: z.boolean().optional(),
    /** Reel time (ms) at which the presenter passes in front of this title (ADR 0055): before it the words cover her, after it she covers them. Only read with `behind`. */
    passMs: ms.optional(),
    /** How long (ms) the crossing takes, from the words in front to her in front (default 160). */
    passFadeMs: z.number().int().min(0).max(2000).optional(),
    /** Particles that live on the title's plane (ADR 0055): snow, embers or dust, drawn in front of and behind the letters. */
    particles: z.object({
      kind: z.enum(PARTICLE_KINDS),
      /** 0.2 (sparse) to 2 (thick); 1 by default. */
      density: z.number().min(0.2).max(2).optional(),
      /** Picks a different scatter of the same kind. */
      seed: z.number().int().min(0).max(1_000_000).optional(),
      /** Reel time (ms) of a burst: the field puffs out and brightens for a moment there (ADR 0059), for a title that lands on the beat. */
      burstMs: ms.optional(),
    }).optional(),
    /**
     * Light on the type (ADR 0061), drawn in the title's own plane so it warps and travels with a tracked surface.
     * `startMs` is when the first pass begins, ms after the title appears (a cue the pacing work may snap to a beat);
     * `everyMs` repeats it (0: once); `angle` tilts the sweep from vertical, degrees.
     */
    shine: z.object({
      preset: z.enum(SHINE_PRESETS),
      angle: z.number().min(-75).max(75).optional(),
      startMs: z.number().int().min(0).max(TYPE_MOTION_START_MAX_MS).optional(),
      everyMs: z.number().int().min(0).max(20_000).optional(),
      /** An anamorphic streak across the plane at the sweep's peak; the golden preset has one by default. */
      flare: z.boolean().optional(),
    }).optional(),
    /** Kinetic type (ADR 0061): how the words arrive. `startMs` is ms after the title appears; `durationMs` how long the move takes. */
    kinetic: z.object({
      preset: z.enum(KINETIC_PRESETS),
      startMs: z.number().int().min(0).max(TYPE_MOTION_START_MAX_MS).optional(),
      durationMs: z.number().int().min(100).max(10_000).optional(),
      /**
       * "words" only (ADR 0084): when each word arrives, ms after the title appears, one per word of the text, so the
       * words land as a speaker says them (`syncTextToSpeech`). Absent, or not one per word: evenly over `durationMs`.
       */
      wordsMs: z.array(z.number().int().min(0).max(TYPE_MOTION_START_MAX_MS)).max(60).optional(),
      /**
       * "caption" only (ADR 0089): when each word goes, ms after the title appears, one per word. Absent (or a word's
       * entry past the next word's arrival): a word stays until the next one replaces it, the last one to the end.
       */
      wordsOffMs: z.array(z.number().int().min(0).max(TYPE_MOTION_START_MAX_MS)).max(60).optional(),
    }).optional(),
    /**
     * The letters filled with a gradient or a picture instead of `color` (ADR 0089): a lockup's hero word only. Drawn with
     * `background-clip: text`, the same in the editor and the export. Absent: the solid colour, as every saved reel.
     */
    fill: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("gradient"), colors: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).min(2).max(4), /** Degrees, CSS convention (180: top to bottom). */ angle: z.number().min(0).max(360).optional() }),
      z.object({ kind: z.literal("image"), assetId: z.string().min(1) }),
    ]).optional(),
    /** Set in italic (ADR 0089, the reference's caption words). Absent: upright. */
    italic: z.boolean().optional(),
    /** The face's weight, overriding the style's own (ADR 0089: the lockup keyword is Playfair 600). Absent: the style's. */
    weight: z.number().int().min(300).max(900).optional(),
    /**
     * Part of a keyword lockup (ADR 0089) made by `composeKeywordLockup`: the lockup's id (one per spoken phrase), and
     * whether this is its keyword or its caption track. Composing again replaces the titles carrying it. Absent: an
     * ordinary title.
     */
    lockup: z.object({ id: z.string().min(1).max(200), role: z.enum(LOCKUP_ROLES) }).optional(),
    /**
     * A pinned callout (ADR 0061): the feature the label points at, frame fractions on the title's first frame. The label
     * sits at x/y and keeps its size and angle; a leader line runs from the label to this point. When pinned, the point
     * is followed with the surface tracker (a small square around it) and the label travels with it.
     */
    callout: z.object({ x: z.number().min(-0.5).max(1.5), y: z.number().min(-0.5).max(1.5) }).optional(),
    /** An extruded, 3D-looking title. */
    depth: z.enum(["flat", "extruded"]).optional(),
    /** How the text meets the picture: `surface` lets the wall's light and texture show through, like paint on it (ADR 0039). */
    blend: z.enum(["plain", "surface"]).optional(),
    /** The flat surface the title is painted on, as four corners (tl, tr, br, bl) in frame fractions, found from the picture's edges or dragged by hand (ADR 0043). Pinning tracks this plane. */
    surface: z.array(z.number().min(-0.5).max(1.5)).length(8).optional(),
    /** Things in front of the surface that hide the title where they cross it (a window mullion, a post): quads in frame fractions at pin time, on or near the surface's plane so they move with it (ADR 0043). */
    bars: z.array(z.array(z.number().min(-0.5).max(1.5)).length(8)).max(8).optional(),
    /** Things in front of the surface (a plant, a chair back, a railing): polygons of 3–16 points (x, y pairs, frame fractions at the first frame) cut out of the title, moving with the plane (ADR 0044). */
    /** Things in front of the title, chosen with a tap: points (frame fractions at the first frame) the segmenter is asked about on every frame, carried by the plane (ADR 0044). */
    occluders: z.array(z.object({
      x: z.number().min(-0.5).max(1.5), y: z.number().min(-0.5).max(1.5),
      /** The pinned asset's source time (ms, exact, not rounded) of the frame the tap was made on (ADR 0051); the tracker starts there. Absent on older taps, which ride the wall. */
      atMs: z.number().min(0).optional(),
    })).max(4).optional(),
    cutouts: z.array(z.array(z.number().min(-0.5).max(1.5)).min(6).max(32).refine((points) => points.length % 2 === 0, "x, y pairs")).max(12).optional(),
    /** Offsets from x/y across this overlay's lifetime, with optional scale and rotation (degrees): a drift, or a surface tracked through the shot (ADR 0039). */
    path: z.array(z.object({
      t: unit, x: z.number().min(-0.5).max(0.5), y: z.number().min(-0.5).max(0.5), s: z.number().min(0.2).max(5).optional(), r: z.number().min(-180).max(180).optional(),
      /** The four tracked corners of the surface (tl, tr, br, bl) as frame fractions: a plane the text sits on, in perspective. */
      q: z.array(z.number().min(-2).max(3)).length(8).optional(),
      /** Opacity 0–1 at this keyframe (default 1): a tracked title fades when the surface is lost rather than cutting. */
      o: unit.optional(),
    }))
      .min(2).max(64).refine(points => points[0].t === 0 && points.at(-1)!.t === 1 && points.every((p, i) => i === 0 || p.t > points[i - 1].t), "Motion path must run in order from 0 to 1").optional(),
  })
  .refine((text) => text.endMs > text.startMs, { message: "Text must be on screen for a positive time" })
  .refine((text) => text.size >= minTextSize(text.style), { message: "Text is too small for this style", path: ["size"] })
  .refine((text) => text.size <= maxTextSize(text), { message: `Text is too large: only a lockup's keyword may pass size ${TEXT_SIZE_MAX}`, path: ["size"] });

/** Largest `size` a title may have: a keyword lockup's hero word may be far bigger than an ordinary title (ADR 0089). */
export function maxTextSize(text: { lockup?: { role: string } | undefined }): number {
  return text.lockup?.role === "keyword" ? KEYWORD_SIZE_MAX : TEXT_SIZE_MAX;
}

/** A song's sections (ADR 0059), found by `analyseSong`. */
export const SECTION_KINDS = ["intro", "build", "drop", "outro"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];
export const songSectionSchema = z.object({ kind: z.enum(SECTION_KINDS), startMs: ms, endMs: ms });
export type SongSection = z.infer<typeof songSectionSchema>;
/** At most this many downbeats are kept: about six minutes at 160 bpm. */
export const MAX_DOWNBEATS = 512;
export const MAX_SECTIONS = 64;

export const musicSchema = z
  .object({
    assetId: z.string().min(1),
    /** Where in the song the reel starts. Always 0 for an Instagram sound. */
    sourceStartMs: ms.default(0),
    /** For an Instagram sound, only how loud it is in the editor's preview: Instagram sets its own mix when it posts. */
    volume: unit.default(0.8),
    /** Tempo of the song and the time of its first beat, when detected. */
    bpm: z.number().min(40).max(240).nullable().default(null),
    beatOffsetMs: ms.nullable().default(null),
    /**
     * Set when the song is a private copy of a sound from Instagram's library
     * (ADR 0019). The export never contains it; Instagram attaches the sound
     * when the reel is posted, always from its start.
     */
    instagramAudioId: z.string().min(1).max(64).nullish(),
    /** Song time (ms) of the first beat of every bar, when the song was analysed (ADR 0059). Absent on older reels: the bars are then counted from the first beat. */
    downbeats: z.array(ms).max(MAX_DOWNBEATS).optional(),
    /** The song's intro, build, drop and outro in song time (ADR 0059), when found. */
    sections: z.array(songSectionSchema).max(MAX_SECTIONS).optional(),
    /** Where the Energy control was last set for this song, 0 (chill) to 1 (hype) (ADR 0059). */
    energy: unit.optional(),
    /**
     * What the last Energy change cut from (ADR 0059): the clips' order and windows before pacing, a key of the cut it
     * made, and the hero it put on the drop. While the reel's clips still match `resultKey`, the next Energy change
     * plans from `base` again, so the order does not churn and going back to a stop gives back its cut.
     */
    pace: z.object({
      base: z.array(z.object({ id: z.string().min(1), sourceStartMs: ms, sourceEndMs: ms })).max(100),
      resultKey: z.string().min(1).max(32),
      heroClipId: z.string().min(1).nullable(),
    }).optional(),
    /** "On the beat" (ADR 0059): title entrances, particle bursts and whips go onto the bar when the cut changes. Absent (older reels) is off. */
    onBeat: z.boolean().optional(),
    /** "Ramp into cuts" (ADR 0067): when the cut changes with Energy, shots in the build and the drop speed up into their cuts. Absent is off. */
    ramps: z.boolean().optional(),
    /** "Speed-ramp the strong cuts" (ADR 0073), retired with the speed-ramp transition (ADR 0082): kept so saved reels round-trip; nothing reads it. */
    speedRamps: z.boolean().optional(),
    /** Chosen by ReelWalk (Make it for me, a finish), not by the studio: a finish may replace it (ADR 0064). Absent: the studio's choice. */
    autoPicked: z.boolean().optional(),
    /**
     * Where the song's drop was placed (ADR 0066): the drop's song time as analysed, and the cut it was put on
     * (`dropOnCut`), so the track start offset and the cut can be found again. Absent on every saved reel.
     */
    drop: z.object({ songMs: ms, cutIndex: z.number().int().min(1).nullable() }).optional(),
  })
  // Instagram has no start offset for an attached sound, so neither does the edit.
  .transform((music) => (music.instagramAudioId ? { ...music, sourceStartMs: 0 } : music));

/** Whether the reel's music is an Instagram sound, which plays from its start and is never rendered into the export. */
export function isInstagramMusic(music: { instagramAudioId?: string | null } | null | undefined): boolean {
  return Boolean(music?.instagramAudioId);
}

/**
 * Where the facts show: a card over the end, the start or both; a thin strip
 * at the top for the whole reel ("throughout"); or kept but not shown
 * ("none": the facts stay with the reel for a later caption or card).
 */
export const DETAILS_PLACEMENTS = ["end", "start", "both", "throughout", "none"] as const;
/** How long the details card stays on screen. */
export const DETAILS_CARD_MS = 3500;

/** The facts a buyer looks for, shown as a card over the start or end of the reel. */
export const listingDetailsSchema = z.object({
  price: z.string().trim().max(24).default(""),
  beds: z.string().trim().max(6).default(""),
  baths: z.string().trim().max(6).default(""),
  area: z.string().trim().max(16).default(""),
  address: z.string().trim().max(80).default(""),
  /** Who to contact: an agent's name, a phone number, a handle. */
  contact: z.string().trim().max(60).default(""),
  placement: z.enum(DETAILS_PLACEMENTS).default("end"),
});
export type ListingDetails = z.infer<typeof listingDetailsSchema>;

export function hasDetails(details: ListingDetails | null | undefined): details is ListingDetails {
  return !!details && [details.price, details.beds, details.baths, details.area, details.address, details.contact].some((value) => value !== "");
}

/** Whether the facts are drawn on the reel as a card (not the strip, not hidden). */
export function showsDetailsCard(details: ListingDetails | null | undefined): details is ListingDetails {
  return hasDetails(details) && details.placement !== "throughout" && details.placement !== "none";
}

/** A logo (the agency's, the agent's) kept in one corner for the whole reel. */
export const logoSchema = z.object({
  assetId: z.string().min(1),
  corner: z.enum(CORNERS).default("top-right"),
  /** Width as a fraction of the frame. */
  size: z.number().min(0.1).max(0.4).default(0.2),
});
export type Logo = z.infer<typeof logoSchema>;

/** The frame Instagram shows as the reel's cover: a clip and how far into it. */
export const coverSchema = z.object({
  clipId: z.string().min(1),
  offsetMs: ms.default(0),
});
export type Cover = z.infer<typeof coverSchema>;

/** "3 bed", "2 bath", "92 m²": the short facts row, skipping anything left empty. */
export function detailFacts(details: ListingDetails): string[] {
  return [
    details.beds ? `${details.beds} bed` : "",
    details.baths ? `${details.baths} bath` : "",
    details.area,
  ].filter((value) => value !== "");
}

/** A starting point for the Instagram caption, built from the details. */
export function captionFromDetails(details: ListingDetails): string {
  const facts = detailFacts(details).join(" · ");
  return [
    [details.price, details.address].filter(Boolean).join(" · "),
    facts,
    details.contact ? `Viewings: ${details.contact}` : "",
    "#justlisted #housetour #realestate #newlisting",
  ]
    .filter((line) => line !== "")
    .join("\n\n");
}

/** Visual hooks (ADR 0041): one drawn opener over the first `durationMs`. */
export const HOOK_KINDS = ["alert", "spotlight", "device"] as const;
export type HookKind = (typeof HOOK_KINDS)[number];
export const HOOK_FONTS = ["sans", "serif"] as const;
export const hookSchema = z.object({
  kind: z.enum(HOOK_KINDS),
  /** How long the hook holds before the reel plays plainly. */
  durationMs: z.number().int().min(800).max(4000).default(2200),
  title: z.string().trim().max(80).default(""),
  body: z.string().trim().max(140).default(""),
  /** The alert's action button. */
  action: z.string().trim().max(24).default(""),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default("#ff5a5f"),
  font: z.enum(HOOK_FONTS).default("sans"),
});
export type Hook = z.infer<typeof hookSchema>;

/**
 * The designed opening (ADR 0068): which hook pattern the first 1.5–3 s were
 * cut to, from which clip and in-point, with the hook line(s) and the promise
 * (what the viewer gets by staying). `hook` above is ADR 0041's drawn opener,
 * so this lives under its own name. Absent on every saved reel.
 */
export const HOOK_PATTERNS = ["voice-in", "motion-in", "text-punch", "pattern-interrupt", "question"] as const;
export type HookPattern = (typeof HOOK_PATTERNS)[number];
export const openingSchema = z.object({
  pattern: z.enum(HOOK_PATTERNS),
  /** The clip the reel opens on, and its in-point (source ms) after the plan. */
  clipId: z.string().min(1),
  inMs: ms,
  /** The hook line(s) written over the opening. */
  titles: z.array(z.string().trim().min(1).max(80)).max(3).default([]),
  /** What the viewer gets by staying. */
  promise: z.string().trim().max(120).default(""),
});
export type Opening = z.infer<typeof openingSchema>;

/**
 * A closing plate (ADR 0065): a near-black card with one line of the thin
 * serif over the last `durationMs` of the reel. Story cuts carry one ("new
 * reel · @handle"); the editor never writes it, so saved reels have none.
 */
export const endCardSchema = z.object({
  text: z.string().trim().min(1).max(80),
  durationMs: z.number().int().min(MIN_CLIP_MS).max(5000),
  /**
   * How the card arrives (ADR 0082): "cut" (absent too) the plate is there on the cut, the line in small tracked
   * capitals; "leak" a soft warm glint hides the cut to the plate. A saved "fade" or "over" reads as "cut".
   */
  reveal: z.preprocess(migrateEndCardReveal, z.enum(END_CARD_REVEALS).optional()),
});
export type EndCard = z.infer<typeof endCardSchema>;
/** How an end card arrives (ADR 0082); absent is "cut". */
export type EndCardReveal = (typeof END_CARD_REVEALS)[number];

/**
 * Sound design (ADR 0066): short bundled sounds on an additive `sfx` track.
 * The sounds themselves are listed in sfx.ts; this is only what a reel stores.
 */
export const SFX_SOUND_IDS = ["whoosh-1", "whoosh-2", "whoosh-3", "riser", "impact-soft", "fire", "water", "wind", "room-tone"] as const;
export type SfxSoundId = (typeof SFX_SOUND_IDS)[number];
export const MAX_SFX = 64;
export const sfxClipSchema = z.object({
  id: z.string().min(1),
  sound: z.enum(SFX_SOUND_IDS),
  /** Reel time (ms) the sound starts. */
  atMs: ms,
  /** How long it plays (ms); an ambience loops to fill it. Absent: the sound's own length, once. */
  durationMs: z.number().int().positive().max(10 * 60_000).optional(),
  /** Start this far into the sound (ms): a riser cut short so its end still lands on the cut. */
  offsetMs: ms.optional(),
  /** Level, 0 to 1, before ducking under speech. Absent: the sound's usual level. */
  gain: unit.optional(),
  fadeInMs: z.number().int().min(0).max(10_000).optional(),
  fadeOutMs: z.number().int().min(0).max(10_000).optional(),
  /** Placed by the `autoSfx` command: the next run replaces it; hand-placed sounds (absent) are kept. */
  auto: z.boolean().optional(),
  /** Why it is there, in a few words ("whoosh on the whip into clip 3"), for the trace and the sheet. */
  reason: z.string().max(80).optional(),
});
export type SfxClip = z.infer<typeof sfxClipSchema>;

/** Most text overlays a reel may carry. */
export const MAX_TEXTS = 50;

export const timelineSchema = z.object({
  version: z.literal(1),
  clips: z.array(clipSchema).max(100),
  texts: z.array(textSchema).max(MAX_TEXTS),
  music: musicSchema.nullable(),
  /** Floor plan with a marker that follows the clips. Null when the reel has none. */
  plan: planOverlaySchema.nullable().default(null),
  /** Price, rooms and contact, shown as a card. Null when not filled in. */
  details: listingDetailsSchema.nullable().default(null),
  /** A logo in a corner for the whole reel. Null for none. */
  logo: logoSchema.nullable().default(null),
  /** The cover frame. Null means the usual one, 0.7 s into the reel. */
  cover: coverSchema.nullable().default(null),
  /** A visual hook over the opening (ADR 0041). Null for none. */
  hook: hookSchema.nullable().default(null),
  /** A closing plate over the ending (ADR 0065). Absent on every saved reel; story cuts set it. */
  endCard: endCardSchema.optional(),
  /** The designed opening (ADR 0068). Absent on every saved reel; the hook command sets it, null clears it. */
  opening: openingSchema.nullable().optional(),
  /** The reel's matched look (ADR 0070): the reference clip and the strength every other clip was matched at. Absent: no matching. */
  look: lookSchema.optional(),
  /** Sound design (ADR 0066): whooshes, a riser, ambience, on top of the clips' sound and the music. Absent on every saved reel: silent. */
  sfx: z.array(sfxClipSchema).max(MAX_SFX).optional(),
});

export type Clip = z.infer<typeof clipSchema>;
export type TextOverlay = z.infer<typeof textSchema>;
export type Music = z.infer<typeof musicSchema>;
export type Timeline = z.infer<typeof timelineSchema>;

export function emptyTimeline(): Timeline {
  return { version: 1, clips: [], texts: [], music: null, plan: null, details: null, logo: null, cover: null, hook: null };
}

/** Validates untrusted JSON (a save from the browser, a row from the database). */
export function parseTimeline(value: unknown): Timeline {
  return timelineSchema.parse(value);
}

// ── Durations and positions ─────────────────────────────────────

export function clipDurationMs(clip: Clip): number {
  const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
  return Math.round((clip.sourceEndMs - clip.sourceStartMs) / speed);
}

/** The source time (ms) the clip shows `offsetMs` into its on-screen time: linear, or along its ramp (ADR 0067). */
export function clipSourceMsAt(clip: Clip, offsetMs: number): number {
  const duration = clipDurationMs(clip);
  const p = duration > 0 ? Math.max(0, Math.min(1, offsetMs / duration)) : 0;
  const ramp = clip.kind === "IMAGE" ? null : clip.ramp;
  return clip.sourceStartMs + rampWarp(ramp, p) * (clip.sourceEndMs - clip.sourceStartMs);
}

/** The on-screen offset (ms) at which the clip shows source time `sourceMs`: the inverse of `clipSourceMsAt`. */
export function clipOffsetMsAtSource(clip: Clip, sourceMs: number): number {
  const span = clip.sourceEndMs - clip.sourceStartMs;
  const u = span > 0 ? Math.max(0, Math.min(1, (sourceMs - clip.sourceStartMs) / span)) : 0;
  const ramp = clip.kind === "IMAGE" ? null : clip.ramp;
  return rampUnwarp(ramp, u) * clipDurationMs(clip);
}

/** Available source footage, expressed in reel time at the clip's current speed. */
export function clipSourceAvailability(clip: Clip, durationMs: number | null | undefined) {
  const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
  const sourceMs = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 && durationMs >= clip.sourceEndMs ? durationMs : null;
  return {
    usedMs: clipDurationMs(clip),
    sourceMs,
    beforeMs: Math.round(clip.sourceStartMs / speed),
    afterMs: sourceMs === null ? null : Math.round((sourceMs - clip.sourceEndMs) / speed),
    fullLengthMs: sourceMs === null ? null : Math.round(sourceMs / speed),
  };
}

export function timelineDurationMs(timeline: Timeline): number {
  return timeline.clips.reduce((total, clip) => total + clipDurationMs(clip), 0);
}

/** Start time of every clip on the output timeline. */
export function clipStartsMs(timeline: Timeline): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const clip of timeline.clips) {
    starts.push(at);
    at += clipDurationMs(clip);
  }
  return starts;
}

/** Which clip is on screen at `atMs`, and how far into it. */
export function locate(timeline: Timeline, atMs: number): { index: number; offsetMs: number } | null {
  let start = 0;
  for (let index = 0; index < timeline.clips.length; index++) {
    const duration = clipDurationMs(timeline.clips[index]);
    if (atMs < start + duration) return { index, offsetMs: Math.max(0, atMs - start) };
    start += duration;
  }
  return null;
}

export function textsAt(timeline: Timeline, atMs: number): TextOverlay[] {
  return timeline.texts.filter((text) => text.startMs <= atMs && atMs < text.endMs);
}

/**
 * Frame ranges for rendering. Starts come from cumulative milliseconds so
 * that rounding never accumulates into a gap or an overlap between clips.
 */
export function framePlan(timeline: Timeline, fps: number = REEL_FORMAT.fps) {
  const toFrame = (value: number) => Math.round((value * fps) / 1000);
  const starts = clipStartsMs(timeline);
  const clips = timeline.clips.map((clip, index) => {
    const from = toFrame(starts[index]);
    const to = toFrame(starts[index] + clipDurationMs(clip));
    return { clip, from, durationInFrames: Math.max(1, to - from) };
  });
  const totalFrames = Math.max(1, toFrame(timelineDurationMs(timeline)));
  const texts = timeline.texts
    .map((text) => {
      const from = toFrame(text.startMs);
      const to = Math.min(totalFrames, toFrame(text.endMs));
      return { text, from, durationInFrames: to - from };
    })
    .filter((entry) => entry.durationInFrames > 0);
  return { clips, texts, totalFrames, toFrame };
}

// ── Clip operations ─────────────────────────────────────────────

function replaceClip(timeline: Timeline, id: string, update: (clip: Clip) => Clip): Timeline {
  return { ...timeline, clips: timeline.clips.map((clip) => (clip.id === id ? update(clip) : clip)) };
}

/** Keeps text overlays inside the reel after the reel got shorter. */
function fitTexts(timeline: Timeline): Timeline {
  const total = timelineDurationMs(timeline);
  const texts = timeline.texts
    .filter((text) => text.startMs < total)
    .map((text) => (text.endMs > total ? { ...text, endMs: total } : text));
  return { ...timeline, texts };
}

export function addClips(timeline: Timeline, clips: Clip[], atIndex = timeline.clips.length): Timeline {
  const next = [...timeline.clips];
  next.splice(Math.max(0, Math.min(atIndex, next.length)), 0, ...clips);
  return { ...timeline, clips: next };
}

export function removeClip(timeline: Timeline, id: string): Timeline {
  const next = fitTexts({ ...timeline, clips: timeline.clips.filter((clip) => clip.id !== id) });
  return next.cover?.clipId === id ? { ...next, cover: null } : next;
}

export function moveClip(timeline: Timeline, id: string, toIndex: number): Timeline {
  const from = timeline.clips.findIndex((clip) => clip.id === id);
  if (from === -1) return timeline;
  const next = [...timeline.clips];
  const [clip] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, clip);
  return { ...timeline, clips: next };
}

export function duplicateClip(timeline: Timeline, id: string, newId: string): Timeline {
  const index = timeline.clips.findIndex((clip) => clip.id === id);
  if (index === -1) return timeline;
  return addClips(timeline, [{ ...timeline.clips[index], id: newId, transitionIn: "cut" }], index + 1);
}

/**
 * Cuts the clip under `atMs` in two. Returns the timeline unchanged when the
 * cut would leave a piece shorter than MIN_CLIP_MS.
 */
export function splitAt(timeline: Timeline, atMs: number, newId: string): Timeline {
  const found = locate(timeline, atMs);
  if (!found) return timeline;
  const clip = timeline.clips[found.index];
  const duration = clipDurationMs(clip);
  if (found.offsetMs < MIN_CLIP_MS || duration - found.offsetMs < MIN_CLIP_MS) return timeline;

  const cut = Math.round(clipSourceMsAt(clip, found.offsetMs));
  // Each piece of a ramped clip keeps the part of the curve it played (ADR 0067).
  const p = found.offsetMs / duration;
  const pieces = clip.ramp ? { first: sliceRamp(clip.ramp, 0, p), second: sliceRamp(clip.ramp, p, 1) } : null;
  const first: Clip = { ...clip, sourceEndMs: cut, ...(pieces ? { ramp: pieces.first } : {}) };
  const second: Clip = { ...clip, id: newId, sourceStartMs: cut, transitionIn: "cut", ...(pieces ? { ramp: pieces.second } : {}) };
  // Motion restarts on each piece, which reads as a deliberate second shot.
  const clips = [...timeline.clips];
  clips.splice(found.index, 1, first, second);
  return { ...timeline, clips };
}

/**
 * Cuts a video clip into `pieces` shots of equal length taken from different
 * parts of its source, spread evenly from its start to its end, so a long
 * walkthrough gives several cuts instead of one long take. Each piece plays
 * about as long as the clip did divided by the pieces, never less than
 * MIN_CLIP_MS, and never more than the source allows. A photo is left alone.
 */
export function splitClip(timeline: Timeline, id: string, pieces: number, newId: () => string, sourceDurationMs?: number | null): Timeline {
  const index = timeline.clips.findIndex((clip) => clip.id === id);
  const clip = timeline.clips[index];
  if (!clip || clip.kind !== "VIDEO" || pieces < 2) return timeline;
  const source = sourceDurationMs ?? clip.sourceEndMs;
  const count = Math.min(4, Math.max(2, Math.round(pieces)));
  const minimum = Math.ceil(MIN_CLIP_MS * clip.speed);
  const want = Math.max(minimum, Math.round((clip.sourceEndMs - clip.sourceStartMs) / count));
  const length = Math.min(want, Math.floor(source / count));
  if (length < minimum) return timeline;
  const share = source / count;
  const shots: Clip[] = [];
  for (let piece = 0; piece < count; piece++) {
    // Each window sits in the middle of its share of the source.
    const start = Math.max(0, Math.min(source - length, Math.round(share * piece + (share - length) / 2)));
    shots.push({ ...clip, id: piece === 0 ? clip.id : newId(), sourceStartMs: start, sourceEndMs: start + length, transitionIn: piece === 0 ? clip.transitionIn : "cut" });
  }
  const clips = [...timeline.clips];
  clips.splice(index, 1, ...shots);
  return fitTexts({ ...timeline, clips });
}

/**
 * Sets the source window of a clip. For video it is clamped to the source
 * length; for a photo only the length matters.
 */
export function trimClip(
  timeline: Timeline,
  id: string,
  window: { sourceStartMs: number; sourceEndMs: number },
  sourceDurationMs?: number,
): Timeline {
  const updated = replaceClip(timeline, id, (clip) => {
    const limit = clip.kind === "VIDEO" && sourceDurationMs ? sourceDurationMs : Number.MAX_SAFE_INTEGER;
    const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
    const minSource = Math.ceil(MIN_CLIP_MS * speed);
    let start = Math.max(0, Math.min(Math.round(window.sourceStartMs), limit - minSource));
    let end = Math.min(limit, Math.round(window.sourceEndMs));
    if (end - start < minSource) end = start + minSource;
    if (end > limit) {
      end = limit;
      start = Math.max(0, end - minSource);
    }
    return { ...clip, sourceStartMs: start, sourceEndMs: end };
  });
  return fitTexts(updated);
}

export type ClipSettings = Partial<Pick<Clip, "speed" | "volume" | "fit" | "filter" | "motion" | "transitionIn" | "pano" | "zoom" | "lensSoftness" | "whipDirection" | "ramp" | "camera">>;

export function updateClip(timeline: Timeline, id: string, settings: ClipSettings): Timeline {
  return fitTexts(replaceClip(timeline, id, (clip) => clipSchema.parse({ ...clip, ...settings })));
}

// ── Text and music ──────────────────────────────────────────────

/** Clamps a text size into the range its style allows. */
/** `size` within its style's range; `max` is TEXT_SIZE_MAX unless the title may be larger (`maxTextSize`, a lockup's keyword). */
export function fitTextSize(style: TextStyle, size: number, max: number = TEXT_SIZE_MAX): number {
  return Math.max(minTextSize(style), Math.min(max, size));
}

export function addText(timeline: Timeline, text: Omit<TextOverlay, "endMs" | "animation"> & { endMs?: number; animation?: TextAnimation }): Timeline {
  const total = timelineDurationMs(timeline);
  const startMs = Math.max(0, Math.min(Math.round(text.startMs), Math.max(0, total - MIN_CLIP_MS)));
  const endMs = Math.min(total, Math.round(text.endMs ?? startMs + DEFAULT_TEXT_MS));
  if (endMs <= startMs) return timeline;
  return { ...timeline, texts: [...timeline.texts, textSchema.parse({ ...text, startMs, endMs, size: fitTextSize(text.style, text.size) })] };
}

export function updateText(timeline: Timeline, id: string, patch: Partial<Omit<TextOverlay, "id">>): Timeline {
  const total = timelineDurationMs(timeline);
  return {
    ...timeline,
    texts: timeline.texts.map((text) => {
      if (text.id !== id) return text;
      const next = { ...text, ...patch };
      next.x = Math.max(0, Math.min(1, next.x));
      next.y = Math.max(0, Math.min(1, next.y));
      // A person who moves an app-placed title owns its position from then on.
      if (next.byApp && (next.x !== text.x || next.y !== text.y)) delete next.byApp;
      next.startMs = Math.max(0, Math.min(Math.round(next.startMs), total - 100));
      next.endMs = Math.max(next.startMs + 100, Math.min(Math.round(next.endMs), total));
      // A small elegant text switched to a bolder style grows to that style's minimum.
      next.size = fitTextSize(next.style, next.size, maxTextSize(next));
      return textSchema.parse(next);
    }),
  };
}

export function removeText(timeline: Timeline, id: string): Timeline {
  return { ...timeline, texts: timeline.texts.filter((text) => text.id !== id) };
}

export function setMusic(timeline: Timeline, music: Music | null): Timeline {
  return { ...timeline, music: music ? musicSchema.parse(music) : null };
}

export function setDetails(timeline: Timeline, details: ListingDetails | null): Timeline {
  return { ...timeline, details: details ? listingDetailsSchema.parse(details) : null };
}

export function setPlan(timeline: Timeline, plan: PlanOverlay | null): Timeline {
  return { ...timeline, plan: plan ? planOverlaySchema.parse(plan) : null };
}

export function setLogo(timeline: Timeline, logo: Logo | null): Timeline {
  return { ...timeline, logo: logo ? logoSchema.parse(logo) : null };
}

/** The cover: a clip and a moment in it. Null goes back to the usual frame. */
export function setCover(timeline: Timeline, cover: Cover | null): Timeline {
  if (cover && !timeline.clips.some((clip) => clip.id === cover.clipId)) return timeline;
  return { ...timeline, cover: cover ? coverSchema.parse(cover) : null };
}

/** The usual cover frame: 0.7 s in, when the hook has popped in and the first shot has barely moved. */
export const DEFAULT_COVER_MS = 700;

/** Where the cover frame is on the finished reel, in milliseconds. */
export function coverMs(timeline: Timeline): number {
  const total = timelineDurationMs(timeline);
  const usual = Math.min(DEFAULT_COVER_MS, Math.max(0, total - 100));
  if (!timeline.cover) return usual;
  const index = timeline.clips.findIndex((clip) => clip.id === timeline.cover!.clipId);
  if (index === -1) return usual;
  const clip = timeline.clips[index];
  const start = clipStartsMs(timeline)[index];
  return Math.min(start + Math.min(timeline.cover.offsetMs, Math.max(0, clipDurationMs(clip) - 100)), Math.max(0, total - 100));
}

/**
 * Where a room's name is drawn: centred, with its whole box above Instagram's caption zone (the bottom
 * 500 px of 1920, y 0.74). The first version put the centre on that line (y 0.74), so every label read as
 * "where Instagram's buttons or caption may cover it" (ADR 0081); a box title at size 0.8 is about a tenth
 * of the frame tall, so this keeps it clear with room to spare (0.66, below the 0.72 safe-zone limit).
 */
export const ROOM_LABEL_AT = { x: 0.5, y: ROOM_LABEL_Y } as const;

/** The y the first version drew room labels at, which reels saved then still carry. */
const LEGACY_ROOM_LABEL_Y = 0.74;

/**
 * Whether the app placed this title and nobody has moved it since (ADR 0081): the export check leaves such
 * a title alone, because the app is responsible for its position, not the person. A room label saved before
 * the `byApp` flag existed, still at the spot the first version drew it, counts too.
 */
export function placedByApp(text: Pick<TextOverlay, "id" | "x" | "y" | "byApp">): boolean {
  if (text.byApp) return true;
  return text.id.startsWith("room-") && text.x === ROOM_LABEL_AT.x && text.y === LEGACY_ROOM_LABEL_Y;
}

/** Ids of the text overlays that addRoomLabels manages. */
const roomLabelId = (clipId: string) => `room-${clipId}`;

/**
 * Adds (or refreshes) a label with the room's name over every clip that
 * knows its room. Labels added before are replaced, so this can be run again
 * after reordering clips. Other text is left alone.
 */
export function addRoomLabels(timeline: Timeline): Timeline {
  const starts = clipStartsMs(timeline);
  // The details card sits where the labels do, so labels make way for it.
  const total = timelineDurationMs(timeline);
  const card = showsDetailsCard(timeline.details) ? Math.min(DETAILS_CARD_MS, Math.floor(total * 0.4)) : 0;
  const clearFrom = card > 0 && timeline.details!.placement !== "end" ? card : 0;
  const clearUntil = card > 0 && timeline.details!.placement !== "start" ? total - card : total;
  const managed = new Set(timeline.clips.map((clip) => roomLabelId(clip.id)));
  // Plain windows first: a label is only validated once it is known to be long enough (a 167 ms clip at 3x has no room for one).
  const labels: { id: string; text: string; startMs: number; endMs: number }[] = [];
  timeline.clips.forEach((clip, index) => {
    if (!clip.room || NON_ROOM_NAME.test(clip.room)) return;
    // Consecutive shots of the same room share one label.
    if (index > 0 && timeline.clips[index - 1].room === clip.room) {
      const previous = labels[labels.length - 1];
      if (previous) previous.endMs = starts[index] + clipDurationMs(clip);
      return;
    }
    labels.push({
      id: roomLabelId(clip.id),
      text: roomTitle(clip.room),
      // A room is named once the camera has walked most of the way into it.
      startMs: starts[index] + 200 + Math.round((walkInto(timeline.plan?.geometry ?? null, timeline.clips[index - 1], clip, clipDurationMs(clip))?.durationMs ?? 0) * 0.6),
      endMs: starts[index] + clipDurationMs(clip),
    });
  });
  const fitted = labels
    .map((label) => ({ ...label, startMs: Math.max(label.startMs, clearFrom), endMs: Math.min(label.endMs, clearUntil) }))
    .filter((label) => label.endMs - label.startMs >= 600)
    .map((label) => textSchema.parse({ ...label, ...ROOM_LABEL_AT, style: "box", color: "#ffffff", size: 0.8, byApp: true }));
  const others = timeline.texts.filter((text) => !managed.has(text.id) && !text.id.startsWith("room-"));
  // Labels never take the reel past the most texts it may have: the first rooms are named, the rest are not.
  return { ...timeline, texts: [...others, ...fitted.slice(0, Math.max(0, MAX_TEXTS - others.length))] };
}

/** When the details card is on screen, as [start, end) windows in ms. */
export function detailsCardWindows(timeline: Timeline): [number, number][] {
  const details = timeline.details;
  if (!showsDetailsCard(details)) return [];
  const total = timelineDurationMs(timeline);
  const card = Math.min(DETAILS_CARD_MS, Math.floor(total * 0.4));
  // The renderer drops a card shorter than about a third of a second.
  if (card < 340) return [];
  const windows: [number, number][] = [];
  if (details.placement !== "end") windows.push([0, card]);
  if (details.placement !== "start") windows.push([total - card, total]);
  return windows;
}

/**
 * The band of the frame the details card covers, as fractions of its height:
 * it sits on Instagram's caption area (bottom 500 px) and is about 400 px
 * tall, so a text centred anywhere from about half way down is under it.
 */
export const DETAILS_CARD_BAND = { top: 0.47, bottom: 0.82 } as const;

/** Whether a text would be drawn under the details card: on screen at the same time, and in the card's band. */
export function textUnderCard(timeline: Timeline, text: Pick<TextOverlay, "id" | "startMs" | "endMs" | "y">): boolean {
  // Room labels make way for the card by themselves (addRoomLabels).
  if (text.id.startsWith("room-")) return false;
  if (text.y < DETAILS_CARD_BAND.top || text.y > DETAILS_CARD_BAND.bottom) return false;
  return detailsCardWindows(timeline).some(([start, end]) => text.startMs < end && text.endMs > start);
}

/** Heights a text may move to when the card is in the way, best first: the hook's line, then above it, then just below it. */
const CLEAR_OF_CARD_Y = [0.42, 0.34, 0.3] as const;

/**
 * Moves every text that would sit under the details card up out of its way,
 * to the first height where it does not land on another text shown at the
 * same time. Run after anything that adds text or the card (an AI edit, Make
 * it for me), so a reel never comes out with words hidden behind the card.
 */
export function keepTextsClearOfCard(timeline: Timeline): Timeline {
  if (!timeline.texts.some((text) => textUnderCard(timeline, text))) return timeline;
  const texts = [...timeline.texts];
  texts.forEach((text, index) => {
    if (!textUnderCard(timeline, text)) return;
    const others = texts.filter((other, at) => at !== index && other.startMs < text.endMs && other.endMs > text.startMs);
    const y = CLEAR_OF_CARD_Y.find((candidate) => others.every((other) => Math.abs(other.y - candidate) >= 0.07)) ?? CLEAR_OF_CARD_Y[0];
    texts[index] = { ...text, y };
  });
  return { ...timeline, texts };
}

export function removeRoomLabels(timeline: Timeline): Timeline {
  return { ...timeline, texts: timeline.texts.filter((text) => !text.id.startsWith("room-")) };
}

export function hasRoomLabels(timeline: Timeline): boolean {
  return timeline.texts.some((text) => text.id.startsWith("room-"));
}

/** Assets a timeline refers to, for loading URLs and for checking ownership. */
export function referencedAssetIds(timeline: Timeline): string[] {
  const ids = new Set(timeline.clips.map((clip) => clip.assetId));
  if (timeline.music) ids.add(timeline.music.assetId);
  if (timeline.logo) ids.add(timeline.logo.assetId);
  // A keyword's picture fill (ADR 0089) is loaded, checked and exported like any other picture.
  for (const text of timeline.texts) if (text.fill?.kind === "image") ids.add(text.fill.assetId);
  return [...ids];
}
