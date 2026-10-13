/**
 * Asking for a change in words (ADR 0020). A studio looks at a finished reel
 * and types "make the kitchen shot longer and swap the music for something
 * calmer". A language model turns that into a short list of edit operations
 * drawn from the editor's own vocabulary; this module describes the reel to
 * the model, checks what comes back, and applies it with the same pure
 * functions the editor uses, so the result is an ordinary timeline that the
 * editor can undo. Nothing here talks to the network: the web app does that.
 */
import { z } from "zod";
import type { InstagramAudioTrack } from "./instagram-audio";
import { beatPeriodMs, nearestBeatMs, snapCutsToBeats, type BeatGrid } from "./beats";
import {
  DEFAULT_IMAGE_MS,
  DEFAULT_PANO,
  DEFAULT_PANO_MS,
  FILTERS,
  MIN_CLIP_MS,
  MOTIONS,
  SPEEDS,
  TEXT_COLORS,
  TEXT_STYLES,
  TRANSITIONS,
  addClips,
  addRoomLabels,
  addText,
  clipDurationMs,
  clipSchema,
  clipStartsMs,
  duplicateClip,
  hasDetails,
  hasRoomLabels,
  listingDetailsSchema,
  moveClip,
  removeClip,
  removeRoomLabels,
  removeText,
  setDetails,
  setMusic,
  timelineDurationMs,
  trimClip,
  updateClip,
  updateText,
  type Clip,
  type TextOverlay,
  type Timeline,
} from "./timeline";

// ── What the model may ask for ──────────────────────────────────

export const AI_EDIT_OPS = [
  "add",
  "order",
  "trim",
  "speed",
  "look",
  "motion",
  "transition",
  "fit",
  "volume",
  "move",
  "remove",
  "duplicate",
  "addText",
  "editText",
  "removeText",
  "music",
  "musicVolume",
  "snapToBeat",
  "details",
  "roomLabels",
  "room",
] as const;

export type AiEditOpName = (typeof AI_EDIT_OPS)[number];

const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().default(null);

const detailsPatchSchema = z.object({
  price: nullable(z.string().max(24)),
  beds: nullable(z.string().max(6)),
  baths: nullable(z.string().max(6)),
  area: nullable(z.string().max(16)),
  address: nullable(z.string().max(80)),
  contact: nullable(z.string().max(60)),
  placement: nullable(z.enum(["end", "start", "both"])),
});

/**
 * One operation. Flat on purpose: every field is present and null unless the
 * operation uses it, which is what strict structured output wants and what
 * keeps a small model from inventing shapes. Clips and texts are referred to
 * by their 1-based position in the description the model was shown; clip 0
 * means every clip, for look, motion, transition, fit and volume.
 */
export const aiEditOpSchema = z.object({
  op: z.enum(AI_EDIT_OPS),
  clip: nullable(z.number().int().min(0).max(100)),
  text: nullable(z.number().int().min(1).max(50)),
  startMs: nullable(z.number().min(0)),
  endMs: nullable(z.number().min(0)),
  lengthMs: nullable(z.number().min(0)),
  speed: nullable(z.number().min(0.25).max(4)),
  filter: nullable(z.enum(FILTERS)),
  motion: nullable(z.enum(MOTIONS)),
  transition: nullable(z.enum(TRANSITIONS)),
  fit: nullable(z.enum(["cover", "contain"])),
  volume: nullable(z.number().min(0).max(1)),
  toPosition: nullable(z.number().int().min(1).max(100)),
  content: nullable(z.string().trim().min(1).max(200)),
  style: nullable(z.enum(TEXT_STYLES)),
  color: nullable(z.string().regex(/^#[0-9a-f]{6}$/i)),
  size: nullable(z.number().min(0.3).max(2.5)),
  y: nullable(z.number().min(0).max(1)),
  songId: nullable(z.string().min(1).max(64)),
  on: nullable(z.boolean()),
  details: nullable(detailsPatchSchema),
  /** add: an id from the unused media list. */
  assetId: nullable(z.string().min(1).max(64)),
  /** order: every clip's number, in the new order. */
  order: nullable(z.array(z.number().int().min(1).max(100)).max(100)),
});

export const aiEditPlanSchema = z.object({
  ops: z.array(aiEditOpSchema).max(60),
  /** One or two plain sentences to the studio: what was done, or why nothing was. */
  note: z.string().trim().max(400),
  /**
   * Up to three things the model needs to know before it can cut the reel
   * (the address, the price, an open-house time). When present, ops is empty
   * and the studio answers in the same sheet.
   */
  questions: z.array(z.string().trim().min(1).max(160)).max(3).default([]),
});

export type AiEditOp = z.infer<typeof aiEditOpSchema>;
export type AiEditPlan = z.infer<typeof aiEditPlanSchema>;

/** The same shape for OpenAI's strict structured output: every key required, nulls allowed. */
export const AI_EDIT_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ops", "note", "questions"],
  properties: {
    questions: { type: "array", items: { type: "string" }, description: "At most three, only when the reel cannot be cut without the answer; then ops is empty" },
    ops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "op", "clip", "text", "startMs", "endMs", "lengthMs", "speed", "filter", "motion", "transition", "fit", "volume",
          "toPosition", "content", "style", "color", "size", "y", "songId", "on", "details", "assetId", "order",
        ],
        properties: {
          op: { type: "string", enum: [...AI_EDIT_OPS] },
          clip: { type: ["integer", "null"], description: "Clip number from the description; 0 = every clip (look, motion, transition, fit, volume only)" },
          text: { type: ["integer", "null"], description: "Text number from the description" },
          startMs: { type: ["number", "null"] },
          endMs: { type: ["number", "null"] },
          lengthMs: { type: ["number", "null"], description: "trim: how long the clip should play, in ms" },
          speed: { type: ["number", "null"], enum: [...SPEEDS, null] },
          filter: { type: ["string", "null"], enum: [...FILTERS, null] },
          motion: { type: ["string", "null"], enum: [...MOTIONS, null] },
          transition: { type: ["string", "null"], enum: [...TRANSITIONS, null] },
          fit: { type: ["string", "null"], enum: ["cover", "contain", null] },
          volume: { type: ["number", "null"], description: "0 to 1" },
          toPosition: { type: ["integer", "null"], description: "move: the clip's new number, 1 = first" },
          content: { type: ["string", "null"], description: "addText/editText: the words; room: the room's name, lower case (kitchen, living room, primary bedroom, pool)" },
          style: { type: ["string", "null"], enum: [...TEXT_STYLES, null] },
          color: { type: ["string", "null"], description: "#rrggbb" },
          size: { type: ["number", "null"], description: "0.3 to 2.5, 1 = normal" },
          y: { type: ["number", "null"], description: "0 = top of frame, 1 = bottom" },
          songId: { type: ["string", "null"], description: "music: a song id from the list, or null for no music" },
          assetId: { type: ["string", "null"], description: "add: an id from the unused media list; the clip goes at toPosition, or the end" },
          order: { type: ["array", "null"], items: { type: "integer" }, description: "order: every clip's number, first to last" },
          on: { type: ["boolean", "null"], description: "roomLabels" },
          details: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["price", "beds", "baths", "area", "address", "contact", "placement"],
            properties: {
              price: { type: ["string", "null"] },
              beds: { type: ["string", "null"] },
              baths: { type: ["string", "null"] },
              area: { type: ["string", "null"] },
              address: { type: ["string", "null"] },
              contact: { type: ["string", "null"] },
              placement: { type: ["string", "null"], enum: ["end", "start", "both", null] },
            },
          },
        },
      },
    },
    note: { type: "string" },
  },
} as const;

// ── Briefs: ways of cutting a whole reel ────────────────────────

/** A saved way of cutting a reel: the words given to the model along with the media. */
export type AiBrief = { id: string; name: string; text: string };

/** The briefs every studio starts with. Studios save their own next to them. */
export const AI_BRIEFS: AiBrief[] = [
  {
    id: "just-listed",
    name: "Just listed",
    text: "Cut a 20 to 30 second just-listed reel from my shots: open on the best exterior or drone shot, then living, kitchen, bedrooms, bath, outdoor last. Quick cuts of 1.5 to 2.5 seconds on the beat, a bright song, room labels on, a short headline at the start and the details card at the end.",
  },
  {
    id: "privacy",
    name: "The privacy I want",
    text: "Cut a slow, quiet 15 to 25 second reel in the luxury style from my shots: takes of 3 to 4 seconds, 360 photos as slow sweeps, calm music, no room labels, one line in the thin elegant serif at the start that reads like a thought (for example: the privacy I want), and no details card.",
  },
  {
    id: "open-house",
    name: "Open house",
    text: "Cut a 15 to 25 second open-house reel from my shots: the hook is the open-house day and time in a box at the start, the walk goes exterior, living, kitchen, primary bedroom, outdoor, cuts of 1.5 to 2.5 seconds on the beat; room labels on; the details card with the address and time at the end. Ask me for the day and time if I have not given them.",
  },
  {
    id: "walkthrough",
    name: "Walkthrough",
    text: "Cut a natural 25 to 40 second walkthrough from my shots in the order a visitor would see the rooms, every shot 2 to 3 seconds, gentle zoom on photos, warm look, room labels on, the details card at the end.",
  },
];

// ── What the model is told ──────────────────────────────────────

/** A clip's source, as much as the model needs to reason about it. */
export type AiAsset = {
  id: string;
  kind: "VIDEO" | "IMAGE" | "AUDIO";
  /** The file name without its extension, or the library title. */
  title: string;
  durationMs: number | null;
  isPano: boolean;
  bpm: number | null;
  beatOffsetMs: number | null;
  /** The room it shows, when the library knows ("kitchen"). */
  room?: string | null;
};

/** A fresh clip for an asset, as the editor would make it when the asset is tapped. */
export function clipForAsset(asset: AiAsset, id: string): Clip {
  const isImage = asset.kind === "IMAGE";
  return clipSchema.parse({
    id,
    assetId: asset.id,
    kind: isImage ? "IMAGE" : "VIDEO",
    sourceStartMs: 0,
    sourceEndMs: asset.isPano ? DEFAULT_PANO_MS : isImage ? DEFAULT_IMAGE_MS : Math.max(MIN_CLIP_MS, asset.durationMs ?? 5000),
    speed: 1,
    volume: 1,
    fit: "cover",
    filter: "none",
    motion: isImage && !asset.isPano ? "zoom-in" : "none",
    transitionIn: "cut",
    pano: asset.isPano ? DEFAULT_PANO : null,
    spot: null,
    room: asset.room ?? null,
  });
}

/** The songs the model may switch to, with a word on their mood. */
export type AiSong = {
  id: string;
  title: string;
  bpm: number | null;
  mood: string | null;
  /** Uploaded by the studio itself: its own taste, preferred when the mood fits. */
  own?: boolean;
  /** A sound from Instagram's library: the editor fetches it and cuts to it (ADR 0019). */
  instagram?: InstagramAudioTrack;
};

/** Moods of the bundled library songs, by title, so "calmer" and "livelier" mean something. */
export const SONG_MOODS: Record<string, string> = {
  carefree: "light, bouncy ukulele; cheerful",
  wallpaper: "soft and ambient; calm, stays in the background",
  "life of riley": "warm acoustic guitar; sunny, upbeat",
  "bossa antigua": "relaxed bossa nova; cool, lounge",
  inspired: "gentle piano that slowly builds; calm, hopeful",
  "easy lemon": "laid-back guitar; easy, relaxed",
  fretless: "slow and smooth; late-night, classy",
  funkorama: "funky and energetic; playful",
};

const MOOD_WORDS: [RegExp, string][] = [
  [/piano|night|dream|sky|calm|ambient|chill|lo-?fi|soft|slow|gentle|quiet|moon|rain|sleep|lullaby|charlotte/i, "calm, soft"],
  [/acoustic|guitar|folk|morning|sunday|easy|relax/i, "warm, relaxed"],
  [/summer|happy|sun|upbeat|pop|party|dance|bright|ukulele/i, "bright, upbeat"],
  [/funk|groove|disco|house|edm|hype|drive|energy|power/i, "energetic"],
  [/cinematic|epic|orchestr|strings|luxury|elegant|classy|jazz|lounge/i, "classy, cinematic"],
];

/**
 * A word on a song's mood: the bundled library's from SONG_MOODS, anyone
 * else's guessed from its name and tempo ("Staring at the Night Sky", 118
 * bpm: calm, soft), so "calmer" can mean the studio's own piano piece and
 * not only the stock songs.
 */
export function songMood(title: string, bpm: number | null = null): string | null {
  const known = SONG_MOODS[title.trim().toLowerCase()];
  if (known) return known;
  const words = MOOD_WORDS.filter(([pattern]) => pattern.test(title)).map(([, mood]) => mood);
  const pace = bpm ? (bpm < 95 ? "slow tempo" : bpm > 130 ? "fast tempo" : null) : null;
  const parts = [...new Set(words), pace].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

export const AI_EDIT_SYSTEM_PROMPT = `You edit short vertical real-estate listing reels for ReelWalk. The user describes a change in plain words; you answer with the smallest list of operations that makes it, using only the operations and values given, and a note to the user.

Rules:
- Refer to clips and texts by the numbers in the description. Never invent clips, assets or songs; the only songs you may switch to are in the list.
- Times are milliseconds. A clip must be at least ${MIN_CLIP_MS} ms. A video clip cannot show more than its source has; a photo can be any length.
- "Longer" without a number means about 1.5x the current length; "shorter" about 0.7x; "much" doubles the change. "Slower" halves speed, "faster" doubles it, within 0.5 to 3.
- Looks: warm, cool, vivid, mono (black and white), fade (soft, filmic), none. Use clip 0 to apply to every clip when the user means the whole reel.
- Music requests like "calmer" or "more energy" pick the song whose mood fits best; say which in the note. Songs marked "from Instagram" come from Instagram's library for business accounts and are the ones to use; their mood says which search found them, and "popular with business accounts right now" is the safest pick when nothing more specific fits. Bright listings suit house and nu disco, slow luxury suits piano, luxury and soft house, walkthroughs suit real estate, soft house and lo-fi. Songs marked "the studio's own" were chosen by the studio: prefer one of them when its mood fits, ahead of stock songs. Never pick the song already playing. Leave the music alone unless the user asks about it (the song, the mood, "calmer", "more energy") or the reel has none: a request about clips, text, the look or the order keeps the song it has, and so does cutting a whole reel that already has music. "No music" is op music with songId null.
- Text: keep it short; style "elegant" is a thin serif, "headline" is bold, "box" is text on a pill, "plain" is white text with a shadow. y is 0 at the top and 1 at the bottom. Where text goes: the opening hook at y 0.42 (the middle, where the eye is), size 1.1 to 1.3; a second line or caption-style text at y 0.6; never above 0.3 or below 0.72, because Instagram's name, caption and buttons cover the top fifth and the bottom quarter. Room labels and the details card place themselves. A hook shows over the whole first clip: start 0, end where the first clip ends.
- Room labels are the texts whose number is marked (room label); to turn them all off use roomLabels on=false rather than removing each.
- When clips are trimmed, moved or removed, the other texts follow their clips, cuts that were on the beat stay on it, and room labels are redrawn, all by themselves: do not re-time texts or snap to the beat to compensate for your own edits.
- The details card (price, beds, baths, area, address, contact) is op details; pass only the fields to change, null for the rest; to remove the card pass details null.
- Cutting a whole reel ("cut it", "make something from these", a brief): the clips already in the reel are the user's shoot of this property; build the reel from them. Never remove them to make room for other media. Use "unused media" only when the user asks for it, or when the reel has fewer than three clips. Order them with op order, then cut fast: a reel is 1.5 to 2.5 s a shot unless the brief says slower (luxury, slow: 3 to 4 s); a photo 2 s with motion zoom-in, a 360 photo 4 s. A video longer than 6 s can give two or three shots: duplicate it and trim each copy to a different part (startMs, lengthMs) so the reel has more cuts instead of longer ones. Aim for 8 to 14 cuts in a 20 to 30 s reel. Pick a song, snapToBeat, add the hook, and the details card as the brief says. Lead with the strongest exterior or wide shot and end on an outdoor or view shot.
- Rooms: when room labels are wanted and a clip does not know its room, name it with op room (clip, content: the room in lower case) from its file name or your best reading of it, before turning room labels on.
- Questions: if, and only if, a brief needs a fact you do not have (an address, a price, an open-house time) return up to three short questions in "questions", no operations, and a note saying what you will do once you know. Otherwise decide for yourself and never ask. You may ask once: if the user has given answers, cut the reel with what you have, leave unknown details-card fields empty, use only the shots that exist, and do not ask again.
- If the request is unclear, impossible with these operations, or not about the reel, return no operations and say so in the note in one sentence, without apologising.
- The note is one or two short sentences in the second person, present tense, plain language, naming what changed ("The kitchen clip now runs 6 seconds and the music is Fretless."). No markdown.`;

const ms = (value: number) => `${(value / 1000).toFixed(1)} s`;

/** The reel, in text, for the model. Clips and texts are numbered from 1. */
export function describeReel(input: {
  title: string;
  timeline: Timeline;
  assets: Record<string, AiAsset | undefined>;
  songs: AiSong[];
  /** Media the studio has that the reel does not use yet, for cutting from scratch. */
  unused?: AiAsset[];
}): string {
  const { timeline, assets, songs } = input;
  const starts = clipStartsMs(timeline);
  const lines: string[] = [];
  lines.push(`Reel "${input.title}", ${ms(timelineDurationMs(timeline))} long, ${timeline.clips.length} clips, vertical 1080x1920.`);
  lines.push("");
  lines.push("Clips, in order:");
  timeline.clips.forEach((clip, index) => {
    const asset = assets[clip.assetId];
    const what = clip.kind === "VIDEO" ? "video" : asset?.isPano || clip.pano ? "360 photo" : "photo";
    const name = clip.room ? `${clip.room}` : asset?.title ? `"${asset.title}"` : "untitled";
    const parts = [
      `${index + 1}. ${what}, ${name}, plays ${ms(clipDurationMs(clip))} at ${ms(starts[index])}`,
      clip.kind === "VIDEO"
        ? `source ${ms(clip.sourceStartMs)}–${ms(clip.sourceEndMs)}${asset?.durationMs ? ` of ${ms(asset.durationMs)}` : ""}, speed ${clip.speed}x, sound ${Math.round(clip.volume * 100)}%`
        : null,
      `look ${clip.filter}`,
      clip.kind === "IMAGE" && !clip.pano ? `motion ${clip.motion}` : null,
      index > 0 ? `transition in ${clip.transitionIn}` : null,
      clip.fit === "contain" ? "fit contain" : null,
    ].filter(Boolean);
    lines.push(parts.join("; "));
  });
  lines.push("");
  if (timeline.texts.length === 0) lines.push("Texts: none.");
  else {
    lines.push("Texts:");
    timeline.texts.forEach((text, index) => {
      const room = text.id.startsWith("room-") ? " (room label)" : "";
      lines.push(
        `${index + 1}. "${text.text}"${room}, style ${text.style}, color ${text.color}, size ${text.size}, y ${text.y.toFixed(2)}, shown ${ms(text.startMs)}–${ms(text.endMs)}`,
      );
    });
  }
  lines.push("");
  const music = timeline.music;
  if (!music) lines.push("Music: none.");
  else {
    const song = songs.find((entry) => entry.id === music.assetId);
    const asset = assets[music.assetId];
    const title = song?.title ?? asset?.title ?? "uploaded song";
    const bpm = song?.bpm ?? asset?.bpm ?? music.bpm;
    lines.push(
      `Music: "${title}" (songId ${music.assetId})${bpm ? `, ${Math.round(bpm)} bpm` : ""}, volume ${Math.round(music.volume * 100)}%, starts ${ms(music.sourceStartMs)} into the song${music.instagramAudioId ? ", an Instagram sound (always plays from its start)" : ""}.`,
    );
  }
  lines.push(`Room labels: ${hasRoomLabels(timeline) ? "on" : "off"}${timeline.clips.some((clip) => clip.room) ? "" : " (no clip knows its room, so they cannot be turned on)"}.`);
  const details = timeline.details;
  if (hasDetails(details)) {
    const fields = (["price", "beds", "baths", "area", "address", "contact"] as const).filter((key) => details[key]).map((key) => `${key} ${details[key]}`);
    lines.push(`Details card: ${fields.join(", ")}; shown at the ${details.placement}.`);
  } else lines.push("Details card: none.");
  lines.push("");
  if (songs.length === 0) lines.push("Songs available: none besides the current one.");
  else {
    lines.push("Songs available (songId: title, tempo, mood):");
    for (const song of songs)
      lines.push(
        `- ${song.id}: "${song.title}"${song.instagram?.artist ? ` by ${song.instagram.artist}` : ""}${song.bpm ? `, ${Math.round(song.bpm)} bpm` : ""}${song.mood ? `, ${song.mood}` : ""}${song.own ? ", the studio's own" : ""}${song.instagram ? ", from Instagram" : ""}`,
      );
  }
  const unused = (input.unused ?? []).filter((asset) => asset.kind !== "AUDIO");
  if (unused.length > 0) {
    lines.push("");
    lines.push("Unused media (assetId: what it is):");
    for (const asset of unused) {
      const what = asset.kind === "VIDEO" ? `video, ${asset.durationMs ? ms(asset.durationMs) : "length unknown"}` : asset.isPano ? "360 photo" : "photo";
      lines.push(`- ${asset.id}: ${what}, "${asset.title}"${asset.room ? `, ${asset.room}` : ""}`);
    }
  }
  lines.push("");
  lines.push(`Text colors to prefer: ${TEXT_COLORS.join(", ")}.`);
  return lines.join("\n");
}

// ── Applying a plan ─────────────────────────────────────────────

export type AiEditResult = {
  timeline: Timeline;
  /** An Instagram sound the plan chose: the editor fetches it, sets it as the music and snaps the cuts to it. */
  instagramPick?: InstagramAudioTrack;
  /** What each operation did, in order, for the studio and the log. */
  applied: string[];
  /** Operations that could not be done and why. */
  skipped: string[];
};

type ApplyOptions = {
  assets: Record<string, AiAsset | undefined>;
  songs: AiSong[];
  /** Media the reel may add (op add), by id. */
  unused?: AiAsset[];
  newId?: () => string;
};

const defaultId = () => `ai-${Math.random().toString(36).slice(2, 10)}`;

function clipLabel(timeline: Timeline, clip: Clip, assets: ApplyOptions["assets"]): string {
  const index = timeline.clips.findIndex((entry) => entry.id === clip.id) + 1;
  const name = clip.room ?? assets[clip.assetId]?.title;
  return `clip ${index}${name ? ` (${name})` : ""}`;
}


// ── Keeping the rest of the reel in step ────────────────────────

/** Where a text sits relative to the clips: the clip it starts over, how far in, and for how long. */
export type TextAnchor = { textId: string; clipId: string; clipIndex: number; offsetMs: number; durationMs: number };

/**
 * Records, for every text that is not a room label, which clip it starts
 * over, so that after clips are trimmed, moved or removed the text can go
 * back over the same picture rather than staying at the same second.
 */
export function anchorTexts(timeline: Timeline): TextAnchor[] {
  const starts = clipStartsMs(timeline);
  return timeline.texts
    .filter((text) => !text.id.startsWith("room-"))
    .map((text) => {
      let index = starts.findIndex((start, i) => text.startMs >= start && text.startMs < start + clipDurationMs(timeline.clips[i]));
      if (index === -1) index = Math.max(0, timeline.clips.length - 1);
      const clip = timeline.clips[index];
      return { textId: text.id, clipId: clip?.id ?? "", clipIndex: index, offsetMs: clip ? text.startMs - starts[index] : 0, durationMs: text.endMs - text.startMs };
    });
}

/**
 * Puts anchored texts back over their clips. A text whose clip was removed
 * goes over whichever clip now holds that position (so a title over the
 * first shot stays over the first shot); a text that was deleted stays gone.
 */
export function reflowTexts(timeline: Timeline, anchors: TextAnchor[], original: TextOverlay[] = []): Timeline {
  if (timeline.clips.length === 0) return timeline;
  const starts = clipStartsMs(timeline);
  const total = timelineDurationMs(timeline);
  const byId = new Map(anchors.map((anchor) => [anchor.textId, anchor]));
  // A text that fell off the end when the reel got shorter comes back if it was anchored.
  const present = new Set(timeline.texts.map((text) => text.id));
  const restored = original.filter((text) => byId.has(text.id) && !present.has(text.id));
  const texts = [...timeline.texts, ...restored].map((text): TextOverlay => {
    const anchor = byId.get(text.id);
    if (!anchor) return text;
    let index = timeline.clips.findIndex((clip) => clip.id === anchor.clipId);
    if (index === -1) index = Math.min(anchor.clipIndex, timeline.clips.length - 1);
    const clipMs = clipDurationMs(timeline.clips[index]);
    const startMs = Math.min(starts[index] + Math.min(anchor.offsetMs, Math.max(0, clipMs - 100)), total - 100);
    const endMs = Math.min(total, startMs + anchor.durationMs);
    return endMs > startMs ? { ...text, startMs, endMs } : text;
  });
  return { ...timeline, texts };
}

/** True when every cut between clips falls on a beat of the music (within a frame or so). */
export function cutsOnBeat(timeline: Timeline, toleranceMs = 60): boolean {
  const music = timeline.music;
  if (!music?.bpm || timeline.clips.length < 2) return false;
  const grid: BeatGrid = { bpm: music.bpm, offsetMs: music.beatOffsetMs ?? 0 };
  if (beatPeriodMs(grid) <= 0) return false;
  const starts = clipStartsMs(timeline);
  return starts.slice(1).every((start) => Math.abs(nearestBeatMs(start, grid, music.sourceStartMs) - start) <= toleranceMs);
}

const STRUCTURAL_OPS: ReadonlySet<AiEditOpName> = new Set(["add", "order", "trim", "speed", "move", "remove", "duplicate", "snapToBeat"]);

/**
 * Applies the plan to the timeline, one operation at a time. A bad operation
 * is skipped with a reason rather than failing the whole request, because the
 * model is usually right about the rest. Clip and text numbers refer to the
 * reel as it was described, so they are resolved to ids up front.
 */
export function applyAiEditPlan(timeline: Timeline, plan: Pick<AiEditPlan, "ops" | "note"> & Partial<AiEditPlan>, options: ApplyOptions): AiEditResult {
  const { assets, songs } = options;
  const newId = options.newId ?? defaultId;
  const clipIds = timeline.clips.map((clip) => clip.id);
  const textIds = timeline.texts.map((text) => text.id);
  const applied: string[] = [];
  const skipped: string[] = [];
  let current = timeline;
  // What the rest of the reel is lined up to, so it can be lined up again afterwards.
  const anchors = anchorTexts(timeline);
  const onBeat = cutsOnBeat(timeline);
  const removedTexts = new Set<string>();
  let instagramPick: InstagramAudioTrack | undefined;
  // Clips added by this plan get numbers after the ones the model was shown.
  const added: string[] = [];
  const numberOf = (n: number) => clipIds[n - 1] ?? added[n - 1 - clipIds.length];
  const structural = () => plan.ops.some((op) => STRUCTURAL_OPS.has(op.op));

  const clipsFor = (op: AiEditOp, allowAll: boolean): Clip[] | null => {
    if (op.clip === null || op.clip === undefined) {
      skipped.push(`${op.op}: no clip given`);
      return null;
    }
    if (op.clip === 0) {
      if (!allowAll) {
        skipped.push(`${op.op}: needs one clip`);
        return null;
      }
      return current.clips;
    }
    const id = numberOf(op.clip);
    const clip = id ? current.clips.find((entry) => entry.id === id) : undefined;
    if (!clip) {
      skipped.push(`${op.op}: there is no clip ${op.clip}`);
      return null;
    }
    return [clip];
  };

  const textFor = (op: AiEditOp) => {
    const id = op.text ? textIds[op.text - 1] : undefined;
    const text = id ? current.texts.find((entry) => entry.id === id) : undefined;
    if (!text) skipped.push(`${op.op}: there is no text ${op.text ?? ""}`.trim());
    return text ?? null;
  };

  for (const op of plan.ops) {
    switch (op.op) {
      case "add": {
        const asset = op.assetId ? options.unused?.find((entry) => entry.id === op.assetId) : undefined;
        if (!asset) {
          skipped.push(`add: no unused media ${op.assetId ?? ""}`.trim());
          break;
        }
        const clip = clipForAsset(asset, newId());
        current = addClips(current, [clip], op.toPosition ? op.toPosition - 1 : current.clips.length);
        added.push(clip.id);
        applied.push(`added "${asset.title}" as clip ${current.clips.findIndex((entry) => entry.id === clip.id) + 1}`);
        break;
      }
      case "order": {
        if (!op.order || op.order.length === 0) {
          skipped.push("order: no order given");
          break;
        }
        const ids = op.order.map(numberOf).filter((id): id is string => Boolean(id) && current.clips.some((clip) => clip.id === id));
        const unique = [...new Set(ids)];
        if (unique.length === 0) {
          skipped.push("order: none of those clip numbers exist");
          break;
        }
        // Clips the model left out keep their relative order after the ones it named.
        const rest = current.clips.filter((clip) => !unique.includes(clip.id));
        current = { ...current, clips: [...unique.map((id) => current.clips.find((clip) => clip.id === id)!), ...rest] };
        applied.push(`clips reordered${rest.length ? ` (${rest.length} left where they were)` : ""}`);
        break;
      }
      case "trim": {
        const clips = clipsFor(op, false);
        if (!clips) break;
        const clip = clips[0];
        const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
        const start = op.startMs ?? clip.sourceStartMs;
        const end = op.endMs ?? (op.lengthMs !== null && op.lengthMs !== undefined ? start + Math.round(op.lengthMs * speed) : clip.sourceEndMs);
        if (end <= start) {
          skipped.push(`trim: ${clipLabel(current, clip, assets)} would have no length`);
          break;
        }
        current = trimClip(current, clip.id, { sourceStartMs: start, sourceEndMs: end }, assets[clip.assetId]?.durationMs ?? undefined);
        const after = current.clips.find((entry) => entry.id === clip.id)!;
        applied.push(`${clipLabel(current, clip, assets)} now plays ${ms(clipDurationMs(after))}`);
        break;
      }
      case "speed": {
        const clips = clipsFor(op, true);
        if (!clips) break;
        if (op.speed === null || op.speed === undefined) {
          skipped.push("speed: no speed given");
          break;
        }
        const videos = clips.filter((clip) => clip.kind === "VIDEO");
        if (videos.length === 0) {
          skipped.push("speed: photos have no speed; use trim to change how long they show");
          break;
        }
        for (const clip of videos) current = updateClip(current, clip.id, { speed: op.speed });
        applied.push(`${videos.length === 1 ? clipLabel(current, videos[0], assets) : `${videos.length} video clips`}: speed ${op.speed}x`);
        break;
      }
      case "look": {
        const clips = clipsFor(op, true);
        if (!clips) break;
        if (!op.filter) {
          skipped.push("look: no look given");
          break;
        }
        for (const clip of clips) current = updateClip(current, clip.id, { filter: op.filter });
        applied.push(`${op.clip === 0 ? "every clip" : clipLabel(current, clips[0], assets)}: look ${op.filter}`);
        break;
      }
      case "motion": {
        const clips = clipsFor(op, true);
        if (!clips) break;
        if (!op.motion) {
          skipped.push("motion: no motion given");
          break;
        }
        const photos = clips.filter((clip) => clip.kind === "IMAGE" && !clip.pano);
        if (photos.length === 0) {
          skipped.push("motion: only photos have motion");
          break;
        }
        for (const clip of photos) current = updateClip(current, clip.id, { motion: op.motion });
        applied.push(`${photos.length === 1 ? clipLabel(current, photos[0], assets) : `${photos.length} photos`}: motion ${op.motion}`);
        break;
      }
      case "transition": {
        const clips = clipsFor(op, true);
        if (!clips) break;
        if (!op.transition) {
          skipped.push("transition: no transition given");
          break;
        }
        const eligible = clips.filter((clip) => current.clips[0]?.id !== clip.id);
        if (eligible.length === 0) {
          skipped.push("transition: the first clip has nothing to transition from");
          break;
        }
        for (const clip of eligible) current = updateClip(current, clip.id, { transitionIn: op.transition });
        applied.push(`${eligible.length === 1 ? clipLabel(current, eligible[0], assets) : `${eligible.length} clips`}: transition ${op.transition}`);
        break;
      }
      case "fit": {
        const clips = clipsFor(op, true);
        if (!clips) break;
        if (!op.fit) {
          skipped.push("fit: no fit given");
          break;
        }
        for (const clip of clips) current = updateClip(current, clip.id, { fit: op.fit });
        applied.push(`${op.clip === 0 ? "every clip" : clipLabel(current, clips[0], assets)}: fit ${op.fit}`);
        break;
      }
      case "volume": {
        const clips = clipsFor(op, true);
        if (!clips) break;
        if (op.volume === null || op.volume === undefined) {
          skipped.push("volume: no level given");
          break;
        }
        const videos = clips.filter((clip) => clip.kind === "VIDEO");
        if (videos.length === 0) {
          skipped.push("volume: photos have no sound");
          break;
        }
        for (const clip of videos) current = updateClip(current, clip.id, { volume: op.volume });
        applied.push(`${videos.length === 1 ? clipLabel(current, videos[0], assets) : `${videos.length} video clips`}: sound ${Math.round(op.volume * 100)}%`);
        break;
      }
      case "move": {
        const clips = clipsFor(op, false);
        if (!clips) break;
        if (!op.toPosition) {
          skipped.push("move: no position given");
          break;
        }
        const label = clipLabel(current, clips[0], assets);
        current = moveClip(current, clips[0].id, op.toPosition - 1);
        applied.push(`${label} moved to position ${Math.min(op.toPosition, current.clips.length)}`);
        break;
      }
      case "remove": {
        const clips = clipsFor(op, false);
        if (!clips) break;
        if (current.clips.length === 1) {
          skipped.push("remove: that is the only clip");
          break;
        }
        const label = clipLabel(current, clips[0], assets);
        current = removeClip(current, clips[0].id);
        applied.push(`${label} removed`);
        break;
      }
      case "duplicate": {
        const clips = clipsFor(op, false);
        if (!clips) break;
        current = duplicateClip(current, clips[0].id, newId());
        applied.push(`${clipLabel(current, clips[0], assets)} duplicated`);
        break;
      }
      case "addText": {
        if (!op.content) {
          skipped.push("addText: no words given");
          break;
        }
        const style = op.style ?? "plain";
        if ((op.startMs ?? 0) >= timelineDurationMs(current)) {
          skipped.push(`addText: "${op.content}" would start after the reel ends`);
          break;
        }
        const before = current.texts.length;
        current = addText(current, {
          id: newId(),
          text: op.content,
          startMs: op.startMs ?? 0,
          endMs: op.endMs ?? undefined,
          x: 0.5,
          y: op.y ?? 0.4,
          style,
          color: op.color ?? "#ffffff",
          size: op.size ?? 1,
        });
        if (current.texts.length === before) skipped.push(`addText: "${op.content}" would show outside the reel`);
        else applied.push(`added text "${op.content}"`);
        break;
      }
      case "editText": {
        const text = textFor(op);
        if (!text) break;
        const patch = {
          ...(op.content ? { text: op.content } : {}),
          ...(op.style ? { style: op.style } : {}),
          ...(op.color ? { color: op.color } : {}),
          ...(op.size !== null && op.size !== undefined ? { size: op.size } : {}),
          ...(op.y !== null && op.y !== undefined ? { y: op.y } : {}),
          ...(op.startMs !== null && op.startMs !== undefined ? { startMs: op.startMs } : {}),
          ...(op.endMs !== null && op.endMs !== undefined ? { endMs: op.endMs } : {}),
        };
        if (Object.keys(patch).length === 0) {
          skipped.push(`editText: nothing to change on "${text.text}"`);
          break;
        }
        current = updateText(current, text.id, patch);
        applied.push(`text "${text.text}" changed${op.content ? ` to "${op.content}"` : ""}`);
        break;
      }
      case "removeText": {
        const text = textFor(op);
        if (!text) break;
        current = removeText(current, text.id);
        removedTexts.add(text.id);
        applied.push(`text "${text.text}" removed`);
        break;
      }
      case "music": {
        if (op.songId === null || op.songId === undefined) {
          if (!current.music) {
            skipped.push("music: there is no music to remove");
            break;
          }
          current = setMusic(current, null);
          applied.push("music removed");
          break;
        }
        const song = songs.find((entry) => entry.id === op.songId);
        if (!song) {
          skipped.push(`music: no song ${op.songId} in the list`);
          break;
        }
        if (song.instagram) {
          instagramPick = song.instagram;
          applied.push(`music is now "${song.title}" from Instagram`);
          break;
        }
        const asset = assets[song.id];
        current = setMusic(current, {
          assetId: song.id,
          sourceStartMs: op.startMs ?? 0,
          volume: op.volume ?? current.music?.volume ?? 0.8,
          bpm: song.bpm ?? asset?.bpm ?? null,
          beatOffsetMs: asset?.beatOffsetMs ?? null,
        });
        applied.push(`music is now "${song.title}"`);
        break;
      }
      case "musicVolume": {
        if (!current.music) {
          skipped.push("musicVolume: there is no music");
          break;
        }
        if (op.volume === null || op.volume === undefined) {
          skipped.push("musicVolume: no level given");
          break;
        }
        current = setMusic(current, { ...current.music, volume: op.volume });
        applied.push(`music volume ${Math.round(op.volume * 100)}%`);
        break;
      }
      case "snapToBeat": {
        if (!current.music?.bpm) {
          skipped.push("snapToBeat: the music has no known tempo");
          break;
        }
        const durations = Object.fromEntries(Object.values(assets).map((asset) => [asset!.id, asset!.durationMs]));
        const next = snapCutsToBeats(current, durations);
        current = hasRoomLabels(next) ? addRoomLabels(next) : next;
        applied.push("cuts moved onto the beat");
        break;
      }
      case "details": {
        if (op.details === null || op.details === undefined) {
          if (!current.details) {
            skipped.push("details: there is no details card");
            break;
          }
          current = setDetails(current, null);
          applied.push("details card removed");
          break;
        }
        const base = current.details ?? listingDetailsSchema.parse({});
        const patch = Object.fromEntries(Object.entries(op.details).filter(([, value]) => value !== null && value !== undefined));
        const next = listingDetailsSchema.parse({ ...base, ...patch });
        if (!hasDetails(next)) {
          skipped.push("details: nothing to show on the card");
          break;
        }
        current = setDetails(current, next);
        applied.push(`details card updated (${Object.keys(patch).join(", ") || "unchanged"})`);
        break;
      }
      case "room": {
        const clips = clipsFor(op, false);
        if (!clips) break;
        const name = op.content?.trim().toLowerCase().slice(0, 40);
        if (!name) {
          skipped.push("room: no room given");
          break;
        }
        current = { ...current, clips: current.clips.map((clip) => (clip.id === clips[0].id ? { ...clip, room: name } : clip)) };
        applied.push(`${clipLabel(current, clips[0], assets)} is the ${name}`);
        break;
      }
      case "roomLabels": {
        if (op.on === null || op.on === undefined) {
          skipped.push("roomLabels: say on or off");
          break;
        }
        if (op.on && !current.clips.some((clip) => clip.room)) {
          skipped.push("roomLabels: no clip knows its room");
          break;
        }
        current = op.on ? addRoomLabels(current) : removeRoomLabels(current);
        applied.push(`room labels ${op.on ? "on" : "off"}`);
        break;
      }
    }
  }
  if (structural() && current !== timeline) {
    // Clips moved, so everything that was lined up to them follows: texts go
    // back over their pictures, cuts that were on the beat go back on it,
    // and room labels are drawn again for the new order.
    const kept = timeline.texts.filter((text) => !removedTexts.has(text.id));
    current = reflowTexts(current, anchors, kept);
    if (onBeat && !plan.ops.some((op) => op.op === "snapToBeat") && current.music?.bpm && !cutsOnBeat(current)) {
      const durations = Object.fromEntries(Object.values(assets).map((asset) => [asset!.id, asset!.durationMs]));
      current = snapCutsToBeats(current, durations);
      current = reflowTexts(current, anchors, kept);
      applied.push("cuts kept on the beat");
    }
    if (hasRoomLabels(current)) current = addRoomLabels(current);
  }
  // Text this plan added ends on a cut when it was meant to (within 0.8 s of
  // one): the beat snap moves cuts by a few hundred milliseconds, and a hook
  // that ends just before its clip does reads as a mistake.
  const before = new Set(timeline.texts.map((text) => text.id));
  const cuts = [...clipStartsMs(current).slice(1), timelineDurationMs(current)];
  current = {
    ...current,
    texts: current.texts.map((text) => {
      if (before.has(text.id) || text.id.startsWith("room-")) return text;
      const nearest = cuts.reduce((best, cut) => (Math.abs(cut - text.endMs) < Math.abs(best - text.endMs) ? cut : best), cuts[0] ?? text.endMs);
      return Math.abs(nearest - text.endMs) <= 800 && nearest > text.startMs + 300 ? { ...text, endMs: nearest } : text;
    }),
  };
  return { timeline: current, applied, skipped, instagramPick };
}

// ── A stand-in for the model ────────────────────────────────────

/**
 * A rule-based planner for local stacks and tests (DEV_FAKE_AI), covering a
 * handful of phrasings so the whole path can be exercised without a key.
 */
export function fakeAiEditPlan(request: string, timeline: Timeline, songs: AiSong[]): AiEditPlan {
  const text = request.toLowerCase();
  const blank: Omit<AiEditOp, "op"> = {
    clip: null, text: null, startMs: null, endMs: null, lengthMs: null, speed: null, filter: null, motion: null, transition: null, fit: null,
    volume: null, toPosition: null, content: null, style: null, color: null, size: null, y: null, songId: null, on: null, details: null,
    assetId: null, order: null,
  };
  const ops: AiEditOp[] = [];
  const notes: string[] = [];
  const look = (["warm", "cool", "vivid", "mono", "fade"] as const).find((name) => text.includes(name)) ?? (/black and white/.test(text) ? "mono" : null);
  if (look) {
    ops.push({ ...blank, op: "look", clip: 0, filter: look });
    notes.push(`Every clip now has the ${look} look.`);
  }
  if (/\b(mute|silent|no sound)\b/.test(text)) {
    ops.push({ ...blank, op: "volume", clip: 0, volume: 0 });
    notes.push("The clips' own sound is off.");
  }
  if (/\b(no|remove|drop) (the )?music\b/.test(text)) {
    ops.push({ ...blank, op: "music", songId: null });
    notes.push("The music is removed.");
  } else if (/\b(calm|calmer|softer|quieter)\b/.test(text) && songs.length > 0) {
    const song = songs.find((entry) => /calm|soft|smooth/.test(entry.mood ?? "")) ?? songs[0];
    ops.push({ ...blank, op: "music", songId: song.id });
    notes.push(`The music is now ${song.title}.`);
  }
  const longer = /\b(longer|shorter)\b/.exec(text);
  if (longer && timeline.clips.length > 0) {
    const clip = timeline.clips.findIndex((entry) => entry.room && text.includes(entry.room.toLowerCase()));
    const index = clip >= 0 ? clip : 0;
    const factor = longer[1] === "longer" ? 1.5 : 0.7;
    ops.push({ ...blank, op: "trim", clip: index + 1, lengthMs: Math.round(clipDurationMs(timeline.clips[index]) * factor) });
    notes.push(`Clip ${index + 1} is ${longer[1]}.`);
  }
  if (/\b(cut (it|a|an)|make something|make a reel|from scratch)\b/.test(text) && timeline.clips.length > 0) {
    ops.push({ ...blank, op: "addText", content: "Just listed", style: "headline", startMs: 0, y: 0.3 });
    if (timeline.music?.bpm) ops.push({ ...blank, op: "snapToBeat" });
    if (timeline.clips.some((clip) => clip.room)) ops.push({ ...blank, op: "roomLabels", on: true });
    notes.push("The reel opens with a headline" + (timeline.music?.bpm ? ", the cuts are on the beat" : "") + ".");
  }
  if (/\broom (labels|names)\b/.test(text)) {
    const on = !/\b(off|remove|no|hide)\b/.test(text);
    ops.push({ ...blank, op: "roomLabels", on });
    notes.push(`Room labels are ${on ? "on" : "off"}.`);
  }
  return { ops, questions: [], note: notes.join(" ") || "I could not tell what to change from that. Try naming a clip, the music, the text or the look." };
}
