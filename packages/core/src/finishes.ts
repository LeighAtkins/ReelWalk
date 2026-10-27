/**
 * Two finishes (ADR 0064): "Make it pop" and "Make it premium". Each sets the
 * four things that make a reel feel one way or the other together, as one
 * command and so one undo step: the music's mood, the type, the pace and
 * the colour look. They are built from settings the editor already has
 * (looks, text styles and typefaces, the review's pace, the luxury grade) so
 * a finished reel stays editable control by control afterwards.
 *
 * A finish restyles; it never undoes the studio's own work:
 *  - clips that carry speech, and AI takes (the presenter), keep their
 *    windows and places (`heldByFinish`);
 *  - a song the studio picked stays (only an automatic pick, or none, is
 *    replaced: `pickFinishSong`);
 *  - placed and crafted titles (pinned, on a surface, extruded, a callout,
 *    kinetic, shining, a status tag, the hook's words) are left as they are
 *    (`finishRestyles`), and no title is made smaller than it was set.
 *
 * Premium follows the @reelwalking house style: serif type, quiet captions,
 * a slower cut and the refined golden grade. Pop is the other end: bold sans
 * headlines that pop in, vivid colour, two-second shots and an energetic song.
 */
import type { AiSong } from "./ai-edit";
import type { MusicChoice } from "./commands";
import { REPACE_FLOOR_MS, heldByPace, paceTimeline, putOnTheBeat } from "./pacing";
import type { SongMap } from "./song";
import { snapCutsToBeats } from "./beats";
import { retime, setLook } from "./review";
import { retimeTexts } from "./text-timing";
import { fitTextSize, setMusic, timelineDurationMs, type Clip, type Filter, type TextOverlay, type TextStyle, type Timeline } from "./timeline";

export const FINISH_IDS = ["pop", "premium"] as const;
export type FinishId = (typeof FINISH_IDS)[number];

export type Finish = {
  id: FinishId;
  /** The button's words. */
  label: string;
  /** What it does, in one line, for the toast and the ADR table. */
  summary: string;
  /** A song whose mood matches is kept or picked. Matched against `AiSong.mood`. */
  mood: RegExp;
  /** Where the Energy control goes (ADR 0059), 0 chill to 1 hype: the pacing engine cuts to the bars and sections. */
  energy: number;
  /** Seconds each shot plays when the song has no tempo to pace to (the review's pace, ADR 0022). */
  shotMs: number;
  /** The colour look on every clip; "golden" also softens the lens edges, as the luxury finish does. */
  look: Filter;
  /** Soft lens edges (the luxury finish's 0.28) or none. */
  lensSoftness: number | null;
  type: {
    style: TextStyle;
    font: NonNullable<TextOverlay["font"]>;
    animation: TextOverlay["animation"];
    shadow: NonNullable<TextOverlay["shadow"]>;
    /** A smaller title is brought up to this; a larger one keeps the size it was set to. */
    minSize: number;
  };
  /** The drawn hook's typeface (ADR 0041). */
  hookFont: "sans" | "serif";
};

export const FINISHES: Record<FinishId, Finish> = {
  pop: {
    id: "pop",
    label: "Make it pop",
    summary: "energetic music, bold type, faster cuts and vivid colour",
    mood: /energetic|upbeat|bright|bouncy|cheerful|funky|playful|sunny|nu disco|fast tempo|popular/i,
    energy: 0.85,
    shotMs: 2000,
    look: "vivid",
    lensSoftness: null,
    type: { style: "headline", font: "sans", animation: "pop", shadow: "strong", minSize: 1 },
    hookFont: "sans",
  },
  premium: {
    id: "premium",
    label: "Make it premium",
    summary: "calm music, quiet serif type, slower cuts and a refined grade",
    mood: /piano|luxury|polished|elegant|classy|calm|smooth|lounge|ambient|cinematic/i,
    energy: 0.3,
    shotMs: 3500,
    look: "golden",
    lensSoftness: 0.28,
    type: { style: "elegant", font: "serif", animation: "fade", shadow: "soft", minSize: 0.5 },
    hookFont: "serif",
  },
};

/**
 * Whether a finish leaves a clip's window and place alone: the pacing
 * engine's rule (ADR 0059 `heldByPace`: an AI take, the presenter included,
 * or a video whose own speech is heard), plus a take a script placed.
 */
export function heldByFinish(clip: Clip, speechAssetIds: readonly string[] = []): boolean {
  return clip.id.startsWith("script-") || heldByPace(clip, speechAssetIds);
}

/** Whether a finish restyles this title: a plain caption or headline, not one the studio placed or crafted (ADR 0039, 0055, 0061). */
export function finishRestyles(text: TextOverlay): boolean {
  if (text.id.startsWith("hook-word-") || text.style === "tag") return false;
  // An inverted title (ADR 0091) keeps its tint: a finish's colour would change what the negative is multiplied by.
  if (text.pin || text.surface || text.blend === "surface" || text.blend === "invert" || text.depth === "extruded") return false;
  return !text.callout && !text.kinetic && !text.shine;
}

function restyleTexts(timeline: Timeline, finish: Finish): Timeline {
  const { type } = finish;
  return {
    ...timeline,
    texts: timeline.texts.map((text) =>
      finishRestyles(text)
        ? { ...text, style: type.style, font: type.font, animation: type.animation, shadow: type.shadow, size: fitTextSize(type.style, Math.max(type.minSize, text.size)) }
        : text,
    ),
    hook: timeline.hook ? { ...timeline.hook, font: finish.hookFont } : timeline.hook,
  };
}

function setFinishLook(timeline: Timeline, finish: Finish): Timeline {
  const looked = setLook(timeline, finish.look);
  return {
    ...looked,
    clips: looked.clips.map((clip) => {
      if (finish.lensSoftness === null) return clip.lensSoftness === undefined ? clip : { ...clip, lensSoftness: undefined };
      return clip.pano ? clip : { ...clip, lensSoftness: finish.lensSoftness };
    }),
  };
}

/** A song set the way the setMusic command sets one (commands.ts `withMusic`): snapped to, then onto the bar when On the beat is on. */
function withSong(timeline: Timeline, choice: MusicChoice, durations: Record<string, number | null | undefined>): Timeline {
  const set = setMusic(timeline, { ...choice, volume: choice.volume ?? timeline.music?.volume ?? 0.8, onBeat: choice.onBeat ?? timeline.music?.onBeat ?? true });
  if (!set.music?.bpm || set.clips.length < 2) return set;
  const snapped = retimeTexts(timeline, snapCutsToBeats(set, durations));
  return snapped.music?.onBeat ? putOnTheBeat(snapped) : snapped;
}

/** Without a tempo there is nothing to pace to: every shot about `shotMs`, except the held ones, which keep their windows. */
function paceExceptHeld(timeline: Timeline, shotMs: number, durations: Record<string, number | null | undefined>, speechAssetIds: readonly string[]): Timeline {
  const paced = retime(timeline, shotMs, durations);
  const held = new Map(timeline.clips.filter((clip) => heldByFinish(clip, speechAssetIds)).map((clip) => [clip.id, clip]));
  if (held.size === 0) return paced;
  const clips = paced.clips.map((clip) => {
    const before = held.get(clip.id);
    return before ? { ...clip, sourceStartMs: before.sourceStartMs, sourceEndMs: before.sourceEndMs, speed: before.speed } : clip;
  });
  return retimeTexts(timeline, { ...paced, clips }, { keepInsideClip: false });
}

/**
 * `paceExceptHeld`, lengthened when it would leave the reel short: a finish changes the feel, not the length, so the
 * reel keeps 15 s or what it was, whichever is smaller (shots a little longer, as far as their sources allow).
 */
function paceKeepingLength(timeline: Timeline, shotMs: number, durations: Record<string, number | null | undefined>, speechAssetIds: readonly string[]): Timeline {
  const floor = Math.min(REPACE_FLOOR_MS, timelineDurationMs(timeline));
  let paced = paceExceptHeld(timeline, shotMs, durations, speechAssetIds);
  for (let longer = shotMs + 500; timelineDurationMs(paced) < floor && longer <= 12_000; longer += 500) paced = paceExceptHeld(timeline, longer, durations, speechAssetIds);
  return paced;
}

export type FinishOptions = {
  /** The song to switch to (chosen and fetched by the caller, see `pickFinishSong`); without it the reel keeps its song. */
  music?: MusicChoice | null;
  sourceDurationsMs?: Record<string, number | null | undefined>;
  /** Assets whose clips carry speech: held. */
  speechAssetIds?: readonly string[];
  /** Measured clip motion and the song's bars, as the Energy control passes them (ADR 0059). */
  clipEnergy?: Record<string, number>;
  songMap?: SongMap;
};

/**
 * The reel with a finish applied. Pure. Look first, then the song (snapped
 * to, On the beat as the reel has it), then the pace: the pacing engine at
 * the finish's energy when the song has a tempo (sections, hero, held
 * clips, ADR 0059), else every unheld shot at `shotMs`. The type last, so
 * room labels the pace redraws are restyled too.
 */
export function applyFinish(timeline: Timeline, id: FinishId, options: FinishOptions = {}): Timeline {
  const finish = FINISHES[id];
  if (timeline.clips.length === 0) return timeline;
  const durations = options.sourceDurationsMs ?? {};
  const speech = options.speechAssetIds ?? [];
  let current = setFinishLook(timeline, finish);
  // A song a finish picks is its own pick: the next finish may replace it, as it may any automatic pick.
  if (options.music) current = withSong(current, { ...options.music, autoPicked: true }, durations);
  if (current.music?.bpm) {
    const map = options.songMap && !current.music.downbeats?.length ? { downbeats: options.songMap.downbeats, sections: options.songMap.sections } : {};
    current = paceTimeline({ ...current, music: { ...current.music, ...map, energy: finish.energy } }, { energy: finish.energy, clipEnergy: options.clipEnergy, speechAssetIds: speech, sourceDurationsMs: durations });
  } else {
    current = paceKeepingLength(current, finish.shotMs, durations, speech);
  }
  return restyleTexts(current, finish);
}

/** The finish a reel carries now, for showing which button is on; null when it has neither (or was changed since). */
export function currentFinish(timeline: Timeline): FinishId | null {
  if (timeline.clips.length === 0) return null;
  const texts = timeline.texts.filter(finishRestyles);
  for (const id of FINISH_IDS) {
    const finish = FINISHES[id];
    const looks = timeline.clips.every((clip) => clip.filter === finish.look);
    const type = texts.every((text) => text.style === finish.type.style && text.font === finish.type.font);
    if (looks && type) return id;
  }
  return null;
}

/**
 * The song a finish wants: null keeps the reel's song. A song the studio
 * picked itself is always kept; an automatic pick (Make it for me, a finish)
 * is kept when it already fits the mood. `songs` is the editor context's list
 * (ai-edit.ts `context`): Instagram's sounds where the studio can use them,
 * else the library with the studio's own songs first.
 */
export function pickFinishSong(
  songs: AiSong[],
  id: FinishId,
  current: { assetId?: string | null; instagramAudioId?: string | null; autoPicked?: boolean | null } = {},
): AiSong | null {
  if (current.assetId && !current.autoPicked) return null;
  const finish = FINISHES[id];
  const playing = current.assetId ? songs.find((song) => (song.instagram ? song.instagram.id === current.instagramAudioId : song.id === current.assetId)) : undefined;
  if (playing && finish.mood.test(playing.mood ?? "")) return null;
  const fits = songs.filter((song) => song !== playing && finish.mood.test(song.mood ?? ""));
  if (fits.length === 0) return null;
  // Prefer a song whose tempo is known: the cuts go on its beat.
  return fits.find((song) => song.instagram || song.bpm) ?? fits[0];
}
