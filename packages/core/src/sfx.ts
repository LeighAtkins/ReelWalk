import { clipDurationMs, clipStartsMs, MAX_SFX, SFX_SOUND_IDS, timelineDurationMs, type Clip, type SfxClip, type SfxSoundId, type TextOverlay, type Timeline } from "./timeline";

/**
 * Sound design (ADR 0066): a small set of bundled sounds (made by ReelWalk's
 * own synthesis script, CC0; see docs/licences/sfx.md) and the rule that
 * places them: a whoosh under every whip, a riser into the reveal with a
 * soft impact on it, ambience under the clips that call for it. Everything
 * here is pure; the composition plays the `sfx` track the same in the
 * preview and the export.
 */

export type SfxKind = "whoosh" | "riser" | "impact" | "ambience";

export type SfxSound = {
  id: SfxSoundId;
  /** File name under the bundled `sfx/` directory. */
  file: string;
  kind: SfxKind;
  durationMs: number;
  /** Loops to fill a longer window (ambience); the others play once. */
  loop: boolean;
  /** Usual level, 0 to 1, under the clips' sound and the music. */
  gain: number;
  /** Where the sound peaks (ms from its start): a whoosh is placed this far before the cut so the peak lands on it. */
  peakMs: number;
};

export const SFX_SOUNDS: Record<SfxSoundId, SfxSound> = {
  "whoosh-1": { id: "whoosh-1", file: "whoosh-1.wav", kind: "whoosh", durationMs: 700, loop: false, gain: 0.5, peakMs: 300 },
  "whoosh-2": { id: "whoosh-2", file: "whoosh-2.wav", kind: "whoosh", durationMs: 700, loop: false, gain: 0.5, peakMs: 300 },
  "whoosh-3": { id: "whoosh-3", file: "whoosh-3.wav", kind: "whoosh", durationMs: 700, loop: false, gain: 0.5, peakMs: 300 },
  riser: { id: "riser", file: "riser.wav", kind: "riser", durationMs: 3000, loop: false, gain: 0.45, peakMs: 3000 },
  "impact-soft": { id: "impact-soft", file: "impact-soft.wav", kind: "impact", durationMs: 900, loop: false, gain: 0.6, peakMs: 0 },
  fire: { id: "fire", file: "fire.wav", kind: "ambience", durationMs: 4000, loop: true, gain: 0.22, peakMs: 0 },
  water: { id: "water", file: "water.wav", kind: "ambience", durationMs: 4000, loop: true, gain: 0.2, peakMs: 0 },
  wind: { id: "wind", file: "wind.wav", kind: "ambience", durationMs: 4000, loop: true, gain: 0.18, peakMs: 0 },
  "room-tone": { id: "room-tone", file: "room-tone.wav", kind: "ambience", durationMs: 4000, loop: true, gain: 0.5, peakMs: 0 },
};

export const WHOOSHES: readonly SfxSoundId[] = ["whoosh-1", "whoosh-2", "whoosh-3"];

/** The asset id the composition looks a sound's file up under. */
export const sfxAssetKey = (sound: SfxSoundId): string => `sfx:${sound}`;

/** The sounds a reel uses, each once, in id order. */
export function sfxSoundsUsed(timeline: Pick<Timeline, "sfx">): SfxSoundId[] {
  const used = new Set((timeline.sfx ?? []).map((clip) => clip.sound));
  return SFX_SOUND_IDS.filter((id) => used.has(id));
}

/** When a placed sound stops, reel ms. */
export function sfxEndMs(clip: SfxClip): number {
  return clip.atMs + (clip.durationMs ?? Math.max(0, SFX_SOUNDS[clip.sound].durationMs - (clip.offsetMs ?? 0)));
}

/** The level of a placed sound at reel `atMs`: its gain through its fades, 0 outside its window. */
export function sfxGainAt(clip: SfxClip, atMs: number): number {
  const end = sfxEndMs(clip);
  if (atMs < clip.atMs || atMs >= end) return 0;
  const gain = clip.gain ?? SFX_SOUNDS[clip.sound].gain;
  const fadeIn = clip.fadeInMs ?? 0;
  const fadeOut = clip.fadeOutMs ?? 0;
  let level = 1;
  if (fadeIn > 0 && atMs < clip.atMs + fadeIn) level = Math.min(level, (atMs - clip.atMs) / fadeIn);
  if (fadeOut > 0 && atMs > end - fadeOut) level = Math.min(level, (end - atMs) / fadeOut);
  return gain * Math.max(0, level);
}

// ── Ambience ────────────────────────────────────────────────────

export const AMBIENCE_TAGS = ["fire", "water", "snow", "wind", "forest", "city", "room"] as const;
export type AmbienceTag = (typeof AMBIENCE_TAGS)[number];

export function isAmbienceTag(value: unknown): value is AmbienceTag {
  return typeof value === "string" && (AMBIENCE_TAGS as readonly string[]).includes(value);
}

/** The bundled sound for a tag and its level: the set is small, so snow and a forest both breathe as wind, a city as room tone. */
export function ambienceFor(tag: AmbienceTag): { sound: SfxSoundId; gain: number } {
  switch (tag) {
    case "fire":
      return { sound: "fire", gain: SFX_SOUNDS.fire.gain };
    case "water":
      return { sound: "water", gain: SFX_SOUNDS.water.gain };
    case "snow":
    case "wind":
      return { sound: "wind", gain: SFX_SOUNDS.wind.gain };
    case "forest":
      return { sound: "wind", gain: SFX_SOUNDS.wind.gain * 0.6 };
    case "city":
    case "room":
      return { sound: "room-tone", gain: SFX_SOUNDS["room-tone"].gain };
  }
}

const AMBIENCE_WORDS: [RegExp, AmbienceTag][] = [
  [/\b(fire|fireplace|hearth|log burner|wood ?stove|campfire|bonfire|candles?)\b/i, "fire"],
  [/\b(pool|bath|bathroom|shower|lake|sea|ocean|beach|river|stream|waterfall|fountain|jacuzzi|hot tub|rain)\b/i, "water"],
  [/\b(snow|snowy|snowed|blizzard|ski|chalet|lodge)\b/i, "snow"],
  [/\b(wind|windy|cliff|dunes?|rooftop|terrace|balcony)\b/i, "wind"],
  [/\b(forest|woods|woodland|trees|garden|orchard|meadow)\b/i, "forest"],
  [/\b(city|skyline|street|downtown|traffic|urban)\b/i, "city"],
];

/** A clip's ambience from its room name and the titles over it, or null when nothing says. */
export function inferAmbienceTag(clip: Clip, textsOver: readonly Pick<TextOverlay, "text">[]): AmbienceTag | null {
  const words = [clip.room ?? "", ...textsOver.map((text) => text.text)].join(" ");
  for (const [pattern, tag] of AMBIENCE_WORDS) if (pattern.test(words)) return tag;
  return null;
}

// ── Auto placement ──────────────────────────────────────────────

export type AutoSfxOptions = {
  /** Ambience by clip id; null for none. Clips not named are inferred from their room and titles when `infer` is on. */
  ambience?: Record<string, AmbienceTag | null>;
  /** Infer ambience from room names and titles for clips not in `ambience` (default on). */
  infer?: boolean;
  /** Where the reveal is, reel ms: the riser ends and the impact lands here. Default: the drop in reel time, else the start of the longest hold. */
  revealMs?: number | null;
  /** The song's drop in reel time, when known (`reelDropMs`). Used when `revealMs` is not given. */
  dropMs?: number | null;
  /** Also whoosh on hard cuts inside a quick-cut run (three or more shots of 1.2 s or less). Off by default: it tires fast. */
  whooshHardCuts?: boolean;
  /** No riser or impact, only whooshes and ambience. */
  noReveal?: boolean;
};

/** Reel time of the drop for this reel's music, or null without one (the reel starts `sourceStartMs` into the song). */
export function reelDropMs(dropSongMs: number | null | undefined, music: Pick<Timeline, "music">["music"], reelMs: number): number | null {
  if (dropSongMs === null || dropSongMs === undefined || !music) return null;
  const at = dropSongMs - music.sourceStartMs;
  return at > 0 && at < reelMs ? at : null;
}

const QUICK_CUT_MS = 1200;
const AMBIENCE_FADE_MS = 400;

/**
 * Where the sounds go. Hand-placed sounds (without `auto`) are kept; the
 * sounds this placed before are replaced. Deterministic for the same reel
 * and options, so running it twice changes nothing.
 */
export function autoPlaceSfx(timeline: Timeline, options: AutoSfxOptions = {}): SfxClip[] {
  const { clips } = timeline;
  const starts = clipStartsMs(timeline);
  const total = timelineDurationMs(timeline);
  const kept = (timeline.sfx ?? []).filter((clip) => !clip.auto);
  const placed: SfxClip[] = [];
  let whooshIndex = 0;
  const whoosh = (cutMs: number, reason: string) => {
    const sound = WHOOSHES[whooshIndex++ % WHOOSHES.length];
    const spec = SFX_SOUNDS[sound];
    const atMs = cutMs - spec.peakMs;
    // A cut too close to the start: begin the sound part-way so its peak still lands on the cut.
    placed.push({ id: `sfx-auto-whoosh-${placed.length + 1}`, sound, atMs: Math.max(0, atMs), ...(atMs < 0 ? { offsetMs: -atMs } : {}), auto: true, reason });
  };

  // 1. Whooshes: every whip; hard cuts inside a quick-cut run when asked.
  const quick = clips.map((clip) => clipDurationMs(clip) <= QUICK_CUT_MS);
  for (let i = 1; i < clips.length; i++) {
    if (clips[i].transitionIn === "whip") whoosh(starts[i], `whoosh on the whip into clip ${i + 1}`);
    else if (options.whooshHardCuts && clips[i].transitionIn === "cut" && quick[i - 1] && quick[i] && (quick[i - 2] || quick[i + 1])) whoosh(starts[i], `whoosh on the quick cut into clip ${i + 1}`);
  }

  // 2. The reveal: a riser ending on it, a soft impact on it.
  if (!options.noReveal) {
    const reveal = options.revealMs ?? options.dropMs ?? longestHoldMs(timeline, starts);
    if (reveal !== null && reveal !== undefined && reveal > 1500 && reveal < total) {
      const riser = SFX_SOUNDS.riser;
      const atMs = reveal - riser.durationMs;
      placed.push({ id: "sfx-auto-riser", sound: "riser", atMs: Math.max(0, atMs), ...(atMs < 0 ? { offsetMs: -atMs } : {}), auto: true, reason: `riser into the reveal at ${(reveal / 1000).toFixed(1)} s` });
      placed.push({ id: "sfx-auto-impact", sound: "impact-soft", atMs: reveal, auto: true, reason: "impact on the reveal" });
    }
  }

  // 3. Ambience: by tag, consecutive clips with the same tag as one span, faded in and out.
  const infer = options.infer ?? true;
  const tags = clips.map((clip, index) => {
    const given = options.ambience?.[clip.id];
    if (given !== undefined) return given;
    if (!infer) return null;
    const over = timeline.texts.filter((text) => text.startMs < starts[index] + clipDurationMs(clip) && text.endMs > starts[index]);
    return inferAmbienceTag(clip, over);
  });
  let span: { tag: AmbienceTag; fromMs: number; toMs: number; firstClip: number } | null = null;
  const flush = () => {
    if (!span) return;
    const { sound, gain } = ambienceFor(span.tag);
    const durationMs = span.toMs - span.fromMs;
    placed.push({ id: `sfx-auto-ambience-${placed.length + 1}`, sound, atMs: span.fromMs, durationMs, gain: Math.round(gain * 100) / 100, fadeInMs: Math.min(AMBIENCE_FADE_MS, durationMs >> 1), fadeOutMs: Math.min(AMBIENCE_FADE_MS, durationMs >> 1), auto: true, reason: `${span.tag} under clip ${span.firstClip + 1}${span.toMs > starts[span.firstClip] + clipDurationMs(clips[span.firstClip]) ? " onwards" : ""}` });
    span = null;
  };
  clips.forEach((clip, index) => {
    const tag = tags[index];
    const from = starts[index];
    const to = from + clipDurationMs(clip);
    if (tag && span && span.tag === tag) span.toMs = to;
    else {
      flush();
      if (tag) span = { tag, fromMs: from, toMs: to, firstClip: index };
    }
  });
  flush();

  return [...kept, ...placed].slice(0, MAX_SFX);
}

/** The start of the longest shot after the opening, where a reveal usually sits; null when the reel has no second shot. */
function longestHoldMs(timeline: Timeline, starts: number[]): number | null {
  let best: { index: number; ms: number } | null = null;
  timeline.clips.forEach((clip, index) => {
    if (index === 0) return;
    const ms = clipDurationMs(clip);
    if (!best || ms > best.ms) best = { index, ms };
  });
  return best ? starts[(best as { index: number }).index] : null;
}

/** The reel with these sounds; an empty list removes the track. */
export function withSfx(timeline: Timeline, sfx: SfxClip[]): Timeline {
  if (sfx.length === 0) {
    if (!timeline.sfx) return timeline;
    const rest = { ...timeline };
    delete rest.sfx;
    return rest;
  }
  return { ...timeline, sfx };
}

/** Sounds that are no longer inside the reel after a cut change are dropped; the rest stay where they are. */
export function trimSfxToReel(timeline: Timeline): Timeline {
  if (!timeline.sfx?.length) return timeline;
  const total = timelineDurationMs(timeline);
  const inside = timeline.sfx.filter((clip) => clip.atMs < total);
  return inside.length === timeline.sfx.length ? timeline : withSfx(timeline, inside);
}
