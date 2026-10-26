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
import { captionsFromSpeech, describeSpeech, hasSpeech, type Transcript } from "./transcript";
import { singleAiVoice, tidyCaptions } from "./guards";
import { attachedAnchors, retimeTexts } from "./text-timing";
import {
  CORNERS,
  DEFAULT_IMAGE_MS,
  DEFAULT_PANO,
  DEFAULT_PANO_MS,
  DETAILS_PLACEMENTS,
  FILTERS,
  MIN_CLIP_MS,
  MOTIONS,
  SPEEDS,
  TAG_Y,
  TEXT_ANIMATIONS,
  TEXT_COLORS,
  TEXT_SAFE_BOTTOM,
  TEXT_STYLES,
  TRANSITIONS,
  ZOOM_MAX,
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
  setCover,
  setDetails,
  setLogo,
  setMusic,
  detailsCardWindows,
  keepTextsClearOfCard,
  splitClip,
  timelineDurationMs,
  trimClip,
  updateClip,
  updateText,
  coverMs,
  type Clip,
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
  "captionSpeech",
  "editText",
  "removeText",
  "music",
  "musicVolume",
  "snapToBeat",
  "details",
  "roomLabels",
  "room",
  "split",
  "zoom",
  "cover",
  "logo",
  "turn",
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
  placement: nullable(z.enum(DETAILS_PLACEMENTS)),
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
  /** addText/editText: 0.3 to 2.5 of the normal text size; logo: 0.1 to 0.4 of the frame width. */
  size: nullable(z.number().min(0.1).max(2.5)),
  y: nullable(z.number().min(0).max(1)),
  songId: nullable(z.string().min(1).max(64)),
  on: nullable(z.boolean()),
  details: nullable(detailsPatchSchema),
  /** add: an id from the unused media list. */
  assetId: nullable(z.string().min(1).max(64)),
  /** order: every clip's number, in the new order. */
  order: nullable(z.array(z.number().int().min(1).max(100)).max(100)),
  /** split: how many shots to cut a video into. */
  pieces: nullable(z.number().int().min(2).max(4)),
  /** addText/editText: the clip the text shows over, start to end. */
  atClip: nullable(z.number().int().min(1).max(100)),
  animation: nullable(z.enum(TEXT_ANIMATIONS)),
  /** zoom: 1 shows the whole picture, 2 the middle half. */
  zoom: nullable(z.number().min(1).max(ZOOM_MAX)),
  /** logo: which corner. */
  corner: nullable(z.enum(CORNERS)),
  /** turn: the heading to end on, in degrees (0 = the middle of the 360 photo, clockwise positive). Found from `content` when null. */
  yaw: nullable(z.number().min(-360).max(360)),
  /** turn: how far the camera sweeps on its way there, in degrees; negative turns the other way; 0 holds still. */
  sweep: nullable(z.number().min(-360).max(360)),
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
  /** The Instagram post text, when the user asked for one; otherwise null. */
  caption: z.string().trim().max(2200).nullable().default(null),
});

export type AiEditOp = z.infer<typeof aiEditOpSchema>;
export type AiEditPlan = z.infer<typeof aiEditPlanSchema>;

/** The same shape for OpenAI's strict structured output: every key required, nulls allowed. */
export const AI_EDIT_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ops", "note", "questions", "caption"],
  properties: {
    questions: { type: "array", items: { type: "string" }, description: "At most three, only when the reel cannot be cut without the answer; then ops is empty" },
    caption: { type: ["string", "null"], description: "The Instagram caption, only when the user asks for one (the post text, hashtags); otherwise null" },
    ops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "op", "clip", "text", "startMs", "endMs", "lengthMs", "speed", "filter", "motion", "transition", "fit", "volume",
          "toPosition", "content", "style", "color", "size", "y", "songId", "on", "details", "assetId", "order",
          "pieces", "atClip", "animation", "zoom", "corner", "yaw", "sweep",
        ],
        properties: {
          op: { type: "string", enum: [...AI_EDIT_OPS] },
          clip: { type: ["integer", "null"], description: "Clip number from the description; 0 = every clip (look, motion, transition, fit, volume only); captionSpeech: the clip whose speech to caption" },
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
          content: { type: ["string", "null"], description: "addText/editText: the words; room: the room's name, lower case (kitchen, living room, primary bedroom, pool); turn: the thing to face (door, window, the view, the bed, the fireplace)" },
          pieces: { type: ["integer", "null"], description: "split: 2 to 4 shots from different parts of the video" },
          atClip: { type: ["integer", "null"], description: "addText/editText: the clip number the text shows over, from its start to its end" },
          animation: { type: ["string", "null"], enum: [...TEXT_ANIMATIONS, null], description: "addText/editText: how the text arrives" },
          zoom: { type: ["number", "null"], description: "zoom: 1 = the whole picture, 1.3 a little closer, 2 = the middle half" },
          corner: { type: ["string", "null"], enum: [...CORNERS, null], description: "logo: where it sits" },
          yaw: { type: ["number", "null"], description: "turn: heading to end on, degrees, 0 = the middle of the 360 photo; leave null and name the thing in content to have it found in the picture" },
          sweep: { type: ["number", "null"], description: "turn: degrees the camera sweeps before it gets there (90 a quarter turn, 180 half, 360 a full spin, 0 hold still, negative the other way); null keeps the sweep it has" },
          style: { type: ["string", "null"], enum: [...TEXT_STYLES, null] },
          color: { type: ["string", "null"], description: "#rrggbb" },
          size: { type: ["number", "null"], description: "text: 0.3 to 2.5, 1 = normal; logo: 0.1 to 0.4 of the frame width" },
          y: { type: ["number", "null"], description: "0 = top of frame, 1 = bottom" },
          songId: { type: ["string", "null"], description: "music: a song id from the list, or null for no music" },
          assetId: { type: ["string", "null"], description: "add: an id from the unused media list; the clip goes at toPosition, or the end. logo: an unused image to show as the logo, null to remove the logo" },
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
              placement: { type: ["string", "null"], enum: [...DETAILS_PLACEMENTS, null], description: "end/start/both: a card; throughout: a thin strip at the top for the whole reel; none: keep the facts, show nothing" },
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
    text: "Cut a 20 to 30 second just-listed reel from my shots: open on the best exterior or drone shot, then living, kitchen, bedrooms, bath, outdoor last. Quick cuts of 1.5 to 2.5 seconds on the beat, a bright song, no room labels, a short headline at the start and the details card at the end.",
  },
  {
    id: "privacy",
    name: "The privacy I want",
    text: "Cut a slow, quiet 15 to 25 second reel in the luxury style from my shots: takes of 3 to 4 seconds, 360 photos as slow sweeps, calm music, no room labels, one line in the thin elegant serif at the start that reads like a thought (for example: the privacy I want), and no details card.",
  },
  {
    id: "open-house",
    name: "Open home",
    text: "Cut a 15 to 25 second open-home reel from my shots: the hook is the open-home day and time in a box at the start, the walk goes exterior, living, kitchen, primary bedroom, outdoor, cuts of 1.5 to 2.5 seconds on the beat; no room labels; the details card with the address and time at the end. Ask me for the day and time if I have not given them.",
  },
  {
    id: "walkthrough",
    name: "Walkthrough",
    text: "Cut a natural 25 to 40 second walkthrough from my shots in the order a visitor would see the rooms, every shot 2 to 3 seconds, gentle zoom on photos, warm look, no room labels, the details card at the end.",
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
  /** What a video says, with word timings, when the worker transcribed it. */
  transcript?: Transcript | null;
  /** Made by a generator (Veo), not shot: its voice is invented per take. */
  aiGenerated?: boolean;
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
- Refer to clips and texts by the numbers in the description. Those numbers never change during a plan: after an order, remove or add operation, clip 3 still means the third clip in the description, so number every operation from the description, not from the result of earlier operations. Never invent clips, assets or songs; the only songs you may switch to are in the list.
- Times are milliseconds. A clip must be at least ${MIN_CLIP_MS} ms. A video clip cannot show more than its source has; a photo can be any length.
- "Longer" without a number means about 1.5x the current length; "shorter" about 0.7x; "much" doubles the change. "Slower" halves speed, "faster" doubles it, within 0.5 to 3.
- Transitions (op transition, clip 0 for every cut): cut (no transition, the default and the house style); fade (a soft crossfade: "dissolve", "crossfade", "smooth transitions", "make it flow"); softDissolve (a crossfade with a slight breath of scale: "soft dissolve", "soft transition", "blend the shots"); focusPull (a rack focus through a soft blur: "focus pull", "rack focus", "dreamy"); lightLeak (a soft warm glint of light over the cut: "light leak", "film light", "warm flash"); walk (only between two 360 photos with known positions). There are no whip pans, swipes, whooshes or speed-ramp transitions: for those asks say they are not offered and leave the cuts. softDissolve, focusPull and lightLeak are events, not a default: put them on at most two cuts of a reel from one ask, the rest stay hard cuts, unless the user names the cuts. Even "smooth transitions where appropriate" means two good cuts, not every cut.
- Looks: warm, cool, vivid, mono (black and white), fade (soft, filmic), golden (golden hour, late low sun), dusk (twilight, blue hour), crisp (bright, clean, the look of listing photography), none. Use clip 0 to apply to every clip when the user means the whole reel.
- 360 photos (the clips marked "360 photo") are a camera turning inside the picture; each one's description gives its turn ("turns 90° clockwise"). op turn (clip) aims it: content names what to face (door, window, the view, the bed, the pool) and it is found in the picture; sweep is how far it turns on the way, 90 a quarter turn, 180 a half, 360 a full spin, 0 to hold still, negative to turn the other way (so "the other way" is the clip's turn with the sign flipped); null keeps the sweep it has. A sweep alone, with content and yaw null, keeps the direction the shot ends on. "Turn slower" or "faster" on a 360 photo is op trim with a longer or shorter lengthMs (the same sweep over more or less time), never speed. A 360 photo has no speed and no motion.
- Zoom: op zoom (clip, zoom) crops closer into a shot about its centre: 1.3 is "a bit closer", 1.6 "much closer", 1 is the whole picture; clip 0 is every clip. It adds to any motion a photo has.
- More cuts from one video: op split (clip, pieces 2 to 4) replaces the clip with that many shots from different parts of its source, in order. Use duplicate only with startMs and lengthMs so the copy shows another part of the video; a duplicate without them repeats the same seconds, which nobody wants. A photo cannot be split.
- The cover: op cover (clip, startMs = how far into that clip, 0 for its first frame) picks the frame Instagram shows in the grid and feed. Without one the cover is 0.7 s into the reel.
- A logo: op logo with assetId of an unused image whose name suggests a logo, a brand, a mark or a headshot puts it in a corner (corner, default top-right; size as a fraction of the frame's width, 0.2 is usual, 0.12 small, 0.3 large) for the whole reel; assetId null removes it. When no such image exists, do nothing and say the logo must be uploaded first.
- Music requests like "calmer" or "more energy" pick the song whose mood fits best; say which in the note. Songs marked "from Instagram" come from Instagram's library for business accounts and are the ones to use; their mood says which search found them, and "popular with business accounts right now" is the safest pick when nothing more specific fits. Bright listings suit house and nu disco, slow luxury suits piano, luxury and soft house, walkthroughs suit real estate, soft house and lo-fi. Songs marked "the studio's own" were chosen by the studio: prefer one of them when its mood fits, ahead of stock songs. Never pick the song already playing. Leave the music alone unless the user asks about it (the song, the mood, "calmer", "more energy") or the reel has none: a request about clips, text, the look or the order keeps the song it has, and so does cutting a whole reel that already has music. "No music" is op music with songId null.
- Text: keep it short; style "elegant" is a thin serif, "headline" is bold, "box" is text on a pill, "plain" is white text with a shadow. y is 0 at the top and 1 at the bottom. Where text goes: the opening hook at y 0.42 (the middle, where the eye is), size 1.1 to 1.3; a second line or caption-style text at y 0.6; never above 0.3 or below ${TEXT_SAFE_BOTTOM}, because Instagram's name, caption and buttons cover the top fifth and the bottom quarter. Room labels and the details card place themselves. A hook shows over the whole first clip. To put text over a particular shot give atClip (the clip's number): the text then starts and ends with that shot, which is how "at the start" (atClip 1), "at the end" (the last clip's number) and "over the kitchen" are done; prefer atClip to startMs and endMs.
- Speech: a clip line that includes "says:" gives the words spoken and when, measured from the audio (times from that clip's own start as played). To caption dialogue use op captionSpeech with clip: it lays one caption per phrase, timed to the words (style and y optional; default a thin serif at y 0.6). Never hand-time captions over speech with addText, and never claim a muted clip is heard. The editor enforces: captions stay between y 0.3 and ${TEXT_SAFE_BOTTOM}, two captions never share a line at the same time, and only the first voiced AI take plays with sound (later voiced AI takes are muted; caption their lines).
- A status sticker (JUST LISTED, PRICE DROP, NEW PRICE, SOLD, UNDER CONTRACT, OPEN HOUSE, COMING SOON) is addText with style "tag": two or three words in capitals, size 0.8 to 1; it places itself at the top of the safe area, over the first clip unless atClip says otherwise. One sticker at a time: change an existing tag with editText rather than adding a second.
- How text arrives (animation on addText or editText): pop (a quick pop, the bold styles' own), fade (a slow fade, the elegant style's own), rise (drifts up as it fades in), type (letter by letter, like typing), none (simply there); auto is the style's own.
- Quiet reveals for a title: fadeQuick (a 200 ms fade, nearly a cut), maskUp (rises into view through a hard edge, no fade), trackIn (the letters close up as it fades in), blurIn (comes into focus out of a soft blur). Use them only when asked for a reveal or an elegant entrance.
- Room labels are the texts whose number is marked (room label); to turn them all off use roomLabels on=false rather than removing each.
- When clips are trimmed, moved or removed, the other texts follow their clips, cuts that were on the beat stay on it, and room labels are redrawn, all by themselves: do not re-time texts or snap to the beat to compensate for your own edits.
- The details card (price, beds, baths, area, address, contact) is op details; pass only the fields to change, null for the rest; to remove the card pass details null. A phone number, an email or a handle the user gives goes in contact on the card, not as text over the picture. An open home day and time goes both as a box text at the start ("Open home · Sat 2–4") and in contact. placement: end, start or both show it as a card; "throughout" shows the facts as a thin strip at the top for the whole reel ("keep the price on screen the whole time"); "none" keeps the facts without showing them. Facts the description lists as known but not shown may be used for text, the caption and the card without asking.
- The caption: when the user asks for the caption, the post text or hashtags, write it in "caption": two to four short lines in the voice of the listing agent, the facts you know (never invented ones), a call to action, then a line of at most five hashtags, #realestate and the city's among them when the address is known; otherwise caption is null. Writing a caption needs no operations.
- A new brief or whole-reel cut on a reel that already has a cut replaces the earlier styling: remove the earlier hook texts and stickers and write the brief's own, re-trim every shot to the pace the brief asks, and set room labels and the details card as the brief says; keep the clips and the music.
- Cutting a whole reel ("cut it", "make something from these", a brief): the clips already in the reel are the user's shoot of this property; build the reel from them. Never remove them to make room for other media. Use "unused media" only when the user asks for it, or when the reel has fewer than three clips. Order them with op order, then cut fast: a reel is 1.5 to 2.5 s a shot unless the brief says slower (luxury, slow: 3 to 4 s); a photo 2 s with motion zoom-in, a 360 photo 4 s. A video longer than 6 s can give two or three shots: duplicate it and trim each copy to a different part (startMs, lengthMs) so the reel has more cuts instead of longer ones. Aim for 8 to 14 cuts in a 20 to 30 s reel. If the user names a length (15 seconds, 10 seconds), make the reel that long; never refuse a length. Pick a song, snapToBeat, add the hook, and the details card as the brief says. Lead with the strongest exterior or wide shot and end on an outdoor or view shot.
- Rooms: when room labels are wanted and a clip does not know its room, name it with op room (clip, content: the room in lower case) from its file name or your best reading of it, before turning room labels on.
- Questions: if, and only if, a brief needs a fact you do not have (an address, a price, an open-house time) return up to three short questions in "questions", no operations, and a note saying what you will do once you know. Otherwise decide for yourself and never ask. You may ask once: if the user has given answers, cut the reel with what you have, leave unknown details-card fields empty, use only the shots that exist, and do not ask again.
- If the request is unclear, impossible with these operations, or not about the reel, return no operations and say so in the note in one sentence, without apologising, and never claim a change you did not make. Footage cannot be stabilised, sharpened or re-shot here. Undo is the arrow above the reel; posting is Export, then Share to Instagram on the export screen.
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
      clip.kind === "VIDEO" && hasSpeech(asset?.transcript) ? describeSpeech(asset!.transcript!, clip) : null,
      `look ${clip.filter}`,
      clip.zoom !== 1 ? `zoom ${clip.zoom}` : null,
      !clip.pano && (clip.kind === "IMAGE" || clip.motion !== "none") ? `motion ${clip.motion}` : null,
      clip.pano ? `turns ${Math.abs(clip.pano.yawEnd - clip.pano.yawStart)}° ${clip.pano.yawEnd >= clip.pano.yawStart ? "clockwise" : "anticlockwise"}, ends facing ${Math.round(clip.pano.yawEnd)}°` : null,
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
        `${index + 1}. "${text.text}"${room}, style ${text.style}, color ${text.color}, size ${text.size}, y ${text.y.toFixed(2)}${text.animation !== "auto" ? `, animation ${text.animation}` : ""}, shown ${ms(text.startMs)}–${ms(text.endMs)}`,
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
    const where =
      details.placement === "none" ? "known but not shown (placement none)" : details.placement === "throughout" ? "shown as a strip at the top throughout" : `shown as a card at the ${details.placement}`;
    lines.push(`Details: ${fields.join(", ")}; ${where}.`);
  } else lines.push("Details: none known.");
  const logoAsset = timeline.logo ? assets[timeline.logo.assetId] : undefined;
  lines.push(timeline.logo ? `Logo: "${logoAsset?.title ?? "image"}" at the ${timeline.logo.corner}, size ${timeline.logo.size}.` : "Logo: none.");
  const coverIndex = timeline.cover ? timeline.clips.findIndex((clip) => clip.id === timeline.cover!.clipId) : -1;
  lines.push(coverIndex >= 0 ? `Cover: clip ${coverIndex + 1}, ${ms(timeline.cover!.offsetMs)} in (${ms(coverMs(timeline))} into the reel).` : `Cover: the usual frame, ${ms(coverMs(timeline))} in.`);
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
  /** A caption the plan wrote, for the reel's post text. */
  caption?: string;
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
  /** The user named the cuts for an effect transition (`namesCuts`): the two-per-reel limit on soft dissolves, focus pulls and light leaks does not apply. */
  namedCuts?: boolean;
};

/** Transitions that are an event rather than a hard cut. A reel of them on every cut reads as a template, so one ask gets at most `EFFECT_TRANSITION_LIMIT`. */
const EFFECT_TRANSITIONS: ReadonlySet<string> = new Set(["softDissolve", "focusPull", "lightLeak"]);
export const EFFECT_TRANSITION_LIMIT = 2;

/** Whether a request points at particular cuts ("the cut into the kitchen", "between clips 2 and 3", "the last cut") rather than asking for them in general. */
export function namesCuts(request: string): boolean {
  const text = request.toLowerCase();
  return /\b(clip|shot|cut|transition)s?\s*#?\d/.test(text) || /\b(between|into|before|after|from)\b[^.]{0,40}\b(clip|shot|cut|kitchen|bed|bath|living|pool|exterior|view|room)\b/.test(text) || /\b(first|last|second|third|fourth|final)\s+(cut|clip|shot|transition)\b/.test(text);
}

const defaultId = () => `ai-${Math.random().toString(36).slice(2, 10)}`;

function clipLabel(timeline: Timeline, clip: Clip, assets: ApplyOptions["assets"]): string {
  const index = timeline.clips.findIndex((entry) => entry.id === clip.id) + 1;
  const name = clip.room ?? assets[clip.assetId]?.title;
  return `clip ${index}${name ? ` (${name})` : ""}`;
}


/** Whether a text shown from `startMs` to `endMs` would sit on screen with the details card (which takes the lower part of the frame). */
export function overlapsDetailsCard(timeline: Timeline, startMs: number, endMs: number): boolean {
  return detailsCardWindows(timeline).some(([start, end]) => startMs < end && endMs > start);
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

const STRUCTURAL_OPS: ReadonlySet<AiEditOpName> = new Set(["add", "order", "trim", "speed", "move", "remove", "duplicate", "split", "snapToBeat"]);

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
  // Only texts attached to a clip follow it (ADR 0048); captions across cuts keep their seconds.
  const anchors = attachedAnchors(timeline);
  const onBeat = cutsOnBeat(timeline);
  const removedTexts = new Set<string>();
  // Texts the plan itself re-timed: the model placed them, so the reflow leaves them.
  const retimedTexts = new Set<string>();
  let instagramPick: InstagramAudioTrack | undefined;
  // Clips added by this plan get numbers after the ones the model was shown.
  const added: string[] = [];
  const numberOf = (n: number) => clipIds[n - 1] ?? added[n - 1 - clipIds.length];
  // Cuts this plan gave an effect transition, counted against the limit.
  const effectCuts = new Set<string>();
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
        const flat = clips.filter((clip) => !clip.pano);
        if (flat.length === 0) {
          skipped.push("motion: use camera turns for panorama clips");
          break;
        }
        for (const clip of flat) current = updateClip(current, clip.id, { motion: op.motion });
        applied.push(`${flat.length === 1 ? clipLabel(current, flat[0], assets) : `${flat.length} clips`}: motion ${op.motion}`);
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
        let chosen = eligible;
        if (EFFECT_TRANSITIONS.has(op.transition) && !options.namedCuts) {
          // An effect on every cut is a template: one ask gets a couple, spread through the reel; the rest stay hard cuts.
          const room = Math.max(0, EFFECT_TRANSITION_LIMIT - effectCuts.size);
          const kept = eligible.filter((clip) => effectCuts.has(clip.id));
          const fresh = eligible.filter((clip) => !effectCuts.has(clip.id));
          const take = Math.min(room, fresh.length);
          chosen = [...kept, ...Array.from({ length: take }, (_, k) => fresh[Math.min(fresh.length - 1, Math.floor(((k + 1) * fresh.length) / (take + 1)))])];
          if (chosen.length < eligible.length) skipped.push(`transition ${op.transition}: only ${EFFECT_TRANSITION_LIMIT} cuts get a ${op.transition} unless you name them; the rest stay cuts`);
          if (chosen.length === 0) break;
          for (const clip of chosen) effectCuts.add(clip.id);
        } else if (EFFECT_TRANSITIONS.has(op.transition)) for (const clip of eligible) effectCuts.add(clip.id);
        for (const clip of chosen) current = updateClip(current, clip.id, { transitionIn: op.transition });
        applied.push(`${chosen.length === 1 ? clipLabel(current, chosen[0], assets) : `${chosen.length} clips`}: transition ${op.transition}`);
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
        const copyId = newId();
        current = duplicateClip(current, clips[0].id, copyId);
        added.push(copyId);
        const copy = current.clips.find((entry) => entry.id === copyId)!;
        const wantsWindow = op.startMs !== null && op.startMs !== undefined || op.lengthMs !== null && op.lengthMs !== undefined || op.endMs !== null && op.endMs !== undefined;
        if (wantsWindow && copy.kind === "VIDEO") {
          // The copy shows another part of the video, as asked.
          const speed = copy.speed;
          const start = op.startMs ?? copy.sourceStartMs;
          const end = op.endMs ?? (op.lengthMs !== null && op.lengthMs !== undefined ? start + Math.round(op.lengthMs * speed) : copy.sourceEndMs);
          current = trimClip(current, copyId, { sourceStartMs: start, sourceEndMs: end }, assets[copy.assetId]?.durationMs ?? undefined);
        }
        if (op.toPosition) current = moveClip(current, copyId, op.toPosition - 1);
        const after = current.clips.find((entry) => entry.id === copyId)!;
        applied.push(`${clipLabel(current, clips[0], assets)} duplicated${wantsWindow && copy.kind === "VIDEO" ? ` (${ms(after.sourceStartMs)}–${ms(after.sourceEndMs)} of the source)` : ""}`);
        break;
      }
      case "split": {
        const clips = clipsFor(op, false);
        if (!clips) break;
        const clip = clips[0];
        if (clip.kind !== "VIDEO") {
          skipped.push(`split: ${clipLabel(current, clip, assets)} is a photo; duplicate it instead`);
          break;
        }
        const pieces = op.pieces ?? 2;
        const before = current.clips.length;
        const ids = new Set(current.clips.map((entry) => entry.id));
        current = splitClip(current, clip.id, pieces, newId, assets[clip.assetId]?.durationMs);
        if (current.clips.length === before) {
          skipped.push(`split: ${clipLabel(current, clip, assets)} is too short to cut into ${pieces}`);
          break;
        }
        for (const entry of current.clips) if (!ids.has(entry.id)) added.push(entry.id);
        applied.push(`${clipLabel(current, clip, assets)} cut into ${current.clips.length - before + 1} shots`);
        break;
      }
      case "zoom": {
        const clips = clipsFor(op, true);
        if (!clips) break;
        if (op.zoom === null || op.zoom === undefined) {
          skipped.push("zoom: no zoom given");
          break;
        }
        const zoom = Math.round(op.zoom * 100) / 100;
        for (const clip of clips) current = updateClip(current, clip.id, { zoom });
        applied.push(`${op.clip === 0 ? "every clip" : clipLabel(current, clips[0], assets)}: zoom ${zoom}x`);
        break;
      }
      case "cover": {
        const clips = clipsFor(op, false);
        if (!clips) break;
        const offsetMs = Math.max(0, Math.round(op.startMs ?? 0));
        current = setCover(current, { clipId: clips[0].id, offsetMs });
        applied.push(`cover: ${clipLabel(current, clips[0], assets)}, ${ms(offsetMs)} in`);
        break;
      }
      case "turn": {
        const clips = clipsFor(op, false);
        if (!clips) break;
        const clip = clips[0];
        if (!clip.pano) {
          skipped.push(`turn: ${clipLabel(current, clip, assets)} is not a 360 photo`);
          break;
        }
        // Something named but not found in the picture: nothing to aim at.
        if ((op.yaw === null || op.yaw === undefined) && op.content) {
          skipped.push(`turn: could not find ${op.content} in ${clipLabel(current, clip, assets)}`);
          break;
        }
        // Only the sweep changes ("a full spin", "the other way", "hold still"): it still ends where it ends now.
        if ((op.yaw === null || op.yaw === undefined) && (op.sweep === null || op.sweep === undefined)) {
          skipped.push("turn: nothing to face and no sweep");
          break;
        }
        const had = clip.pano.yawEnd - clip.pano.yawStart;
        const sweep = op.sweep ?? had;
        // Arrive on the target: the sweep ends looking at it.
        const yawEnd = Math.round(op.yaw ?? clip.pano.yawEnd);
        const yawStart = Math.max(-360, Math.min(360, yawEnd - sweep));
        current = updateClip(current, clip.id, { pano: { ...clip.pano, yawStart, yawEnd: Math.max(-360, Math.min(360, yawEnd)) } });
        applied.push(
          op.content
            ? `${clipLabel(current, clip, assets)}: turns ${Math.abs(sweep)}° to face ${op.content}`
            : sweep === 0
              ? `${clipLabel(current, clip, assets)}: holds still`
              : `${clipLabel(current, clip, assets)}: turns ${Math.abs(sweep)}° ${sweep < 0 ? "anticlockwise" : "clockwise"}`,
        );
        break;
      }
      case "logo": {
        if (op.assetId === null || op.assetId === undefined) {
          if (!current.logo) {
            skipped.push("logo: there is no logo to remove");
            break;
          }
          current = setLogo(current, null);
          applied.push("logo removed");
          break;
        }
        const asset = options.unused?.find((entry) => entry.id === op.assetId) ?? assets[op.assetId];
        if (!asset || asset.kind !== "IMAGE") {
          skipped.push(`logo: no image ${op.assetId}`);
          break;
        }
        current = setLogo(current, { assetId: asset.id, corner: op.corner ?? current.logo?.corner ?? "top-right", size: Math.max(0.1, Math.min(0.4, op.size ?? current.logo?.size ?? 0.2)) });
        applied.push(`logo "${asset.title}" at the ${current.logo!.corner}`);
        break;
      }
      case "addText": {
        if (!op.content) {
          skipped.push("addText: no words given");
          break;
        }
        const style = op.style ?? "plain";
        // Over one shot: from its first frame to its last.
        let window: { startMs: number; endMs?: number } = { startMs: op.startMs ?? 0, endMs: op.endMs ?? undefined };
        if (op.atClip) {
          const id = numberOf(op.atClip);
          const index = current.clips.findIndex((entry) => entry.id === id);
          if (index === -1) {
            skipped.push(`addText: there is no clip ${op.atClip}`);
            break;
          }
          const starts = clipStartsMs(current);
          window = { startMs: starts[index], endMs: starts[index] + clipDurationMs(current.clips[index]) };
        } else if (style === "tag" && current.clips.length > 0) window = { startMs: 0, endMs: clipDurationMs(current.clips[0]) };
        if (window.startMs >= timelineDurationMs(current)) {
          skipped.push(`addText: "${op.content}" would start after the reel ends`);
          break;
        }
        // Text that shows while the details card is up goes above the card, not under it.
        let y = style === "tag" ? TAG_Y : op.y ?? 0.4;
        if (overlapsDetailsCard(current, window.startMs, window.endMs ?? window.startMs + 3000) && y > 0.45) y = 0.42;
        const before = current.texts.length;
        current = addText(current, {
          id: newId(),
          text: style === "tag" ? op.content.toUpperCase() : op.content,
          startMs: window.startMs,
          endMs: window.endMs,
          x: 0.5,
          y,
          style,
          color: op.color ?? "#ffffff",
          size: op.size ?? (style === "tag" ? 0.9 : 1),
          animation: op.animation ?? "auto",
        });
        if (current.texts.length === before) skipped.push(`addText: "${op.content}" would show outside the reel`);
        else applied.push(`added text "${op.content}"`);
        break;
      }
      case "captionSpeech": {
        const clips = clipsFor(op, false);
        if (!clips) break;
        const clip = clips[0];
        const transcript = assets[clip.assetId]?.transcript;
        if (!hasSpeech(transcript)) {
          skipped.push(`captionSpeech: ${clipLabel(current, clip, assets)} has no transcript`);
          break;
        }
        const index = current.clips.findIndex((entry) => entry.id === clip.id);
        const phrases = captionsFromSpeech(transcript, clip, clipStartsMs(current)[index]);
        if (!phrases.length) {
          skipped.push(`captionSpeech: no speech plays in ${clipLabel(current, clip, assets)}`);
          break;
        }
        // Captioning the same clip again replaces its speech captions rather than stacking them.
        current = { ...current, texts: current.texts.filter((entry) => !entry.id.startsWith(`speech-${clip.id}-`)) };
        for (const [n, phrase] of phrases.entries()) {
          current = addText(current, {
            id: `speech-${clip.id}-${n}`, text: phrase.text, startMs: phrase.startMs, endMs: phrase.endMs, x: 0.5,
            y: op.y ?? 0.6, style: op.style ?? "elegant", color: op.color ?? "#ffffff", size: op.size ?? 1, animation: op.animation ?? "none",
          });
        }
        applied.push(`captioned the speech in ${clipLabel(current, clip, assets)} (${phrases.length} ${phrases.length === 1 ? "caption" : "captions"})`);
        break;
      }
      case "editText": {
        const text = textFor(op);
        if (!text) break;
        const over = op.atClip ? current.clips.findIndex((entry) => entry.id === numberOf(op.atClip!)) : -1;
        const overStart = over >= 0 ? clipStartsMs(current)[over] : null;
        const tag = (op.style ?? text.style) === "tag";
        const patch = {
          ...(op.content ? { text: tag ? op.content.toUpperCase() : op.content } : {}),
          ...(op.style ? { style: op.style } : {}),
          ...(op.color ? { color: op.color } : {}),
          ...(op.size !== null && op.size !== undefined ? { size: op.size } : {}),
          ...(op.y !== null && op.y !== undefined ? { y: op.y } : op.style === "tag" ? { y: TAG_Y } : {}),
          ...(op.animation ? { animation: op.animation } : {}),
          ...(overStart !== null ? { startMs: overStart, endMs: overStart + clipDurationMs(current.clips[over]) } : {}),
          ...(overStart === null && op.startMs !== null && op.startMs !== undefined ? { startMs: op.startMs } : {}),
          ...(overStart === null && op.endMs !== null && op.endMs !== undefined ? { endMs: op.endMs } : {}),
        };
        if (Object.keys(patch).length === 0) {
          skipped.push(`editText: nothing to change on "${text.text}"`);
          break;
        }
        current = updateText(current, text.id, patch);
        if ("startMs" in patch || "endMs" in patch) retimedTexts.add(text.id);
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
          // An Instagram sound chosen in this plan is fetched by the editor, which snaps the cuts to it then.
          if (instagramPick) applied.push("cuts go on the beat once the Instagram sound loads");
          else skipped.push("snapToBeat: the music has no known tempo");
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
    // The same retiming every cut change goes through (text-timing.ts), room labels included.
    const follow = { anchors, except: retimedTexts, kept };
    current = retimeTexts(timeline, current, follow);
    if (onBeat && !plan.ops.some((op) => op.op === "snapToBeat") && current.music?.bpm && !cutsOnBeat(current)) {
      const durations = Object.fromEntries(Object.values(assets).map((asset) => [asset!.id, asset!.durationMs]));
      current = retimeTexts(timeline, snapCutsToBeats(current, durations), follow);
      applied.push("cuts kept on the beat");
    }
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
  // Whatever order the plan did things in (a text first, the card after), nothing ends up behind the card.
  current = keepTextsClearOfCard(current);
  const caption = plan.caption?.trim() || undefined;
  if (caption) applied.push("caption written");
  // House rules, whatever the plan asked for (guards.ts).
  const captions = tidyCaptions(current);
  const voice = singleAiVoice(captions.timeline, assets);
  current = voice.timeline;
  applied.push(...captions.notes, ...voice.notes);
  return { timeline: current, applied, skipped, instagramPick, caption };
}

// ── A stand-in for the model ────────────────────────────────────

/**
 * A rule-based planner for local stacks and tests (DEV_FAKE_AI), covering a
 * handful of phrasings so the whole path can be exercised without a key.
 */
export function fakeAiEditPlan(request: string, timeline: Timeline, songs: AiSong[], unused: AiAsset[] = []): AiEditPlan {
  const text = request.toLowerCase();
  const blank: Omit<AiEditOp, "op"> = {
    clip: null, text: null, startMs: null, endMs: null, lengthMs: null, speed: null, filter: null, motion: null, transition: null, fit: null,
    volume: null, toPosition: null, content: null, style: null, color: null, size: null, y: null, songId: null, on: null, details: null,
    assetId: null, order: null, pieces: null, atClip: null, animation: null, zoom: null, corner: null, yaw: null, sweep: null,
  };
  const ops: AiEditOp[] = [];
  const notes: string[] = [];
  let caption: string | null = null;
  const face = /\b(face|look at|point at|turn to(?:wards)?) (?:the )?(\w+)/.exec(text);
  const panoIndex = timeline.clips.findIndex((entry) => entry.pano);
  if (face && panoIndex >= 0) {
    // The stand-in cannot look at the picture: the door is taken to be a quarter turn to the right.
    ops.push({ ...blank, op: "turn", clip: panoIndex + 1, content: face[2], yaw: 90 });
    notes.push(`The 360 shot now ends facing the ${face[2]}.`);
  } else if (/\b(full spin|spin|full turn)\b/.test(text) && panoIndex >= 0) {
    ops.push({ ...blank, op: "turn", clip: panoIndex + 1, yaw: timeline.clips[panoIndex].pano!.yawEnd, sweep: 360 });
    notes.push("The 360 shot does a full spin.");
  }
  if (/\b(soft dissolves?|smooth transitions?|blend the shots)\b/.test(text) && timeline.clips.length > 1) {
    ops.push({ ...blank, op: "transition", clip: 0, transition: "softDissolve" });
    notes.push("A couple of cuts are now a soft dissolve; name the cuts to add more.");
  }
  const look = FILTERS.filter((name) => name !== "none").find((name) => text.includes(name)) ?? (/black and white/.test(text) ? "mono" : /golden hour/.test(text) ? "golden" : null);
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
    notes.push("The reel opens with a headline" + (timeline.music?.bpm ? ", the cuts are on the beat" : "") + ".");
  }
  if (/\broom (labels|names)\b/.test(text)) {
    const on = !/\b(off|remove|no|hide)\b/.test(text);
    ops.push({ ...blank, op: "roomLabels", on });
    notes.push(`Room labels are ${on ? "on" : "off"}.`);
  }
  const sticker = /\b(sold|price drop|under contract|under offer|open house|open home|auction|coming soon|new price|just listed)\b/.exec(text);
  if (sticker && /\b(sticker|tag|badge|mark it|label it)\b/.test(text)) {
    ops.push({ ...blank, op: "addText", style: "tag", content: sticker[1].toUpperCase() });
    notes.push(`A ${sticker[1]} sticker is on the first shot.`);
  }
  const ending = /\b(at the end|over the last shot)\b/.test(text) && /["“]([^"”]+)["”]/.exec(request);
  if (ending && timeline.clips.length > 0) {
    ops.push({ ...blank, op: "addText", content: ending[1], atClip: timeline.clips.length, style: "box", y: 0.6 });
    notes.push(`"${ending[1]}" shows over the last shot.`);
  }
  const zoom = /\bzoom (in|closer)\b/.test(text) && !/\bzoom-?(in|out)\b.*motion/.test(text);
  if (zoom && timeline.clips.length > 0) {
    const index = timeline.clips.findIndex((entry) => entry.room && text.includes(entry.room.toLowerCase()));
    ops.push({ ...blank, op: "zoom", clip: index >= 0 ? index + 1 : 0, zoom: /\bmuch\b/.test(text) ? 1.6 : 1.3 });
    notes.push("The picture is cropped closer.");
  }
  const split = /\b(more cuts|more shots|split|cut (it|the [\w ]+?) into)\b/.exec(text);
  if (split && timeline.clips.some((entry) => entry.kind === "VIDEO")) {
    const index = timeline.clips.findIndex((entry) => entry.kind === "VIDEO" && (!entry.room || text.includes(entry.room.toLowerCase()) || !/\b(kitchen|living|bedroom|pool|exterior)\b/.test(text)));
    const clip = index >= 0 ? index : timeline.clips.findIndex((entry) => entry.kind === "VIDEO");
    const pieces = /\b(three|3)\b/.test(text) ? 3 : /\b(four|4)\b/.test(text) ? 4 : 2;
    ops.push({ ...blank, op: "split", clip: clip + 1, pieces });
    notes.push(`Clip ${clip + 1} is now ${pieces} shots.`);
  }
  if (/\bcover\b/.test(text) && timeline.clips.length > 0) {
    const index = timeline.clips.findIndex((entry) => entry.room && text.includes(entry.room.toLowerCase()));
    ops.push({ ...blank, op: "cover", clip: (index >= 0 ? index : 0) + 1, startMs: 500 });
    notes.push(`The cover is clip ${(index >= 0 ? index : 0) + 1}.`);
  }
  if (/\blogo\b/.test(text)) {
    if (/\b(remove|no|drop|without)\b/.test(text)) ops.push({ ...blank, op: "logo", assetId: null });
    else {
      // A logo already on the reel is moved; it is not "unused", so looking only there said "upload your logo first" (ADR 0054).
      const logo = timeline.logo ? { id: timeline.logo.assetId } : unused.find((asset) => asset.kind === "IMAGE" && /logo|brand|mark/i.test(asset.title));
      if (logo) ops.push({ ...blank, op: "logo", assetId: logo.id, corner: /bottom/.test(text) ? (/left/.test(text) ? "bottom-left" : "bottom-right") : /left/.test(text) ? "top-left" : "top-right" });
      else notes.push("Upload your logo first, then ask again.");
    }
    if (ops.some((entry) => entry.op === "logo")) notes.push("The logo is in the corner.");
  }
  const typed = /\b(type|typewriter|letter by letter|fade in|rise)\b/.exec(text);
  if (typed && timeline.texts.some((entry) => !entry.id.startsWith("room-"))) {
    const index = timeline.texts.findIndex((entry) => !entry.id.startsWith("room-"));
    const animation = /fade/.test(typed[1]) ? "fade" : typed[1] === "rise" ? "rise" : "type";
    ops.push({ ...blank, op: "editText", text: index + 1, animation });
    notes.push(`The title now arrives with a ${animation}.`);
  }
  if (/\b(whole time|throughout|the whole reel|on screen all the time)\b/.test(text) && timeline.details) {
    ops.push({ ...blank, op: "details", details: { price: null, beds: null, baths: null, area: null, address: null, contact: null, placement: "throughout" } });
    notes.push("The facts stay on screen as a strip at the top.");
  }
  if (/\bcaption\b/.test(text)) {
    const facts = timeline.details ? [timeline.details.price, timeline.details.address].filter(Boolean).join(" · ") : "";
    caption = `${facts || "Just listed"}\nDM for a private tour.\n\n#realestate #justlisted #housetour #dreamhome #newlisting`;
    notes.push("The caption is written.");
  }
  return { ops, questions: [], caption, note: notes.join(" ") || "I could not tell what to change from that. Try naming a clip, the music, the text or the look." };
}
