import { z } from "zod";

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

/** Shortest clip the editor will produce by trimming or splitting. */
export const MIN_CLIP_MS = 500;
/** Default on-screen time for a photo. */
export const DEFAULT_IMAGE_MS = 3000;
export const DEFAULT_TEXT_MS = 3000;

export const SPEEDS = [0.5, 1, 1.5, 2, 3] as const;
export const FILTERS = ["none", "warm", "cool", "vivid", "mono", "fade"] as const;
export const MOTIONS = ["none", "zoom-in", "zoom-out", "pan"] as const;
export const TRANSITIONS = ["cut", "fade"] as const;
export const TEXT_STYLES = ["plain", "box", "outline", "headline"] as const;
export const TEXT_COLORS = ["#ffffff", "#111111", "#ffd23f", "#ff5a5f", "#3ddc97", "#4da3ff"] as const;

export type Filter = (typeof FILTERS)[number];
export type Motion = (typeof MOTIONS)[number];
export type Transition = (typeof TRANSITIONS)[number];
export type TextStyle = (typeof TEXT_STYLES)[number];

const ms = z.number().int().min(0);
const unit = z.number().min(0).max(1);

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
    /** Ken Burns style movement. Photos only. */
    motion: z.enum(MOTIONS).default("none"),
    /** How this clip enters from the previous one. */
    transitionIn: z.enum(TRANSITIONS).default("cut"),
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
    size: z.number().min(0.5).max(2.5).default(1),
  })
  .refine((text) => text.endMs > text.startMs, { message: "Text must be on screen for a positive time" });

export const musicSchema = z.object({
  assetId: z.string().min(1),
  /** Where in the song the reel starts. */
  sourceStartMs: ms.default(0),
  volume: unit.default(0.8),
});

export const timelineSchema = z.object({
  version: z.literal(1),
  clips: z.array(clipSchema).max(100),
  texts: z.array(textSchema).max(50),
  music: musicSchema.nullable(),
});

export type Clip = z.infer<typeof clipSchema>;
export type TextOverlay = z.infer<typeof textSchema>;
export type Music = z.infer<typeof musicSchema>;
export type Timeline = z.infer<typeof timelineSchema>;

export function emptyTimeline(): Timeline {
  return { version: 1, clips: [], texts: [], music: null };
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
  return fitTexts({ ...timeline, clips: timeline.clips.filter((clip) => clip.id !== id) });
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

  const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
  const cut = clip.sourceStartMs + Math.round(found.offsetMs * speed);
  const first: Clip = { ...clip, sourceEndMs: cut };
  const second: Clip = { ...clip, id: newId, sourceStartMs: cut, transitionIn: "cut" };
  // Motion restarts on each piece, which reads as a deliberate second shot.
  const clips = [...timeline.clips];
  clips.splice(found.index, 1, first, second);
  return { ...timeline, clips };
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

export type ClipSettings = Partial<Pick<Clip, "speed" | "volume" | "fit" | "filter" | "motion" | "transitionIn">>;

export function updateClip(timeline: Timeline, id: string, settings: ClipSettings): Timeline {
  return fitTexts(replaceClip(timeline, id, (clip) => clipSchema.parse({ ...clip, ...settings })));
}

// ── Text and music ──────────────────────────────────────────────

export function addText(timeline: Timeline, text: Omit<TextOverlay, "endMs"> & { endMs?: number }): Timeline {
  const total = timelineDurationMs(timeline);
  const startMs = Math.max(0, Math.min(text.startMs, Math.max(0, total - MIN_CLIP_MS)));
  const endMs = Math.min(total, text.endMs ?? startMs + DEFAULT_TEXT_MS);
  if (endMs <= startMs) return timeline;
  return { ...timeline, texts: [...timeline.texts, textSchema.parse({ ...text, startMs, endMs })] };
}

export function updateText(timeline: Timeline, id: string, patch: Partial<Omit<TextOverlay, "id">>): Timeline {
  const total = timelineDurationMs(timeline);
  return {
    ...timeline,
    texts: timeline.texts.map((text) => {
      if (text.id !== id) return text;
      const next = { ...text, ...patch };
      next.startMs = Math.max(0, Math.min(Math.round(next.startMs), total - 100));
      next.endMs = Math.max(next.startMs + 100, Math.min(Math.round(next.endMs), total));
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

/** Assets a timeline refers to, for loading URLs and for checking ownership. */
export function referencedAssetIds(timeline: Timeline): string[] {
  const ids = new Set(timeline.clips.map((clip) => clip.assetId));
  if (timeline.music) ids.add(timeline.music.assetId);
  return [...ids];
}
