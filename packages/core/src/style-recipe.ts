import { z } from "zod";
import { TEXT_ANIMATIONS } from "./timeline";

/**
 * Style references (ADR 0102): a reel the owner downloaded from Instagram (or anywhere) and shared with ReelWalk, read
 * into a "style recipe": how it is cut, how fast it talks, where its titles sit and how they arrive. The recipe is
 * what a reel is made to follow; the reference's own footage is never rendered, posted or reused.
 *
 *   parseSceneCuts(ffmpegLog)              cut times (ms) from ffmpeg's scene-score showinfo lines
 *   shotsFromCuts(cutsMs, durationMs)      the shots between those cuts, near-duplicate cuts merged
 *   pacingOf(shots)                        shot count, median and mean length, cuts per second, the first cut
 *   speechOf(words, durationMs)            words per minute, when speech starts, how much of the reel is spoken
 *   recipeCutsOnBeat(shots, beatsMs)             the share of cuts within a tolerance of a beat
 *   effectSupport(effect)                  whether ReelWalk renders a named title effect, and as what
 *   recipeGaps(recipe)                     the recipe's title effects ReelWalk cannot draw yet
 *   describeRecipe(recipe)                 a short plain summary, for the page and for an assistant following it
 */

/**
 * Title effects a reference can use. The first group are ReelWalk's own (TEXT_ANIMATIONS); the rest are named effects
 * read off references, grouped by family. The four families of sixteen come from the owner's reference of
 * 2026-10-31 ("16 ways to hook viewers with a title"): dots, line art, drop-ins and pixels.
 */
export const EFFECT_FAMILIES = {
  dots: ["dotHop", "rollout", "slingshot", "splits"],
  lineArt: ["timelineScrub", "tracedOutline", "orbitRing", "pluckedString"],
  dropIns: ["stickerStack", "oneBigSlam", "tumblingLetters", "heavyLanding"],
  pixels: ["pixelSwarm", "pixelRain", "mosaicResolve", "ledScoreboard"],
} as const;
export type EffectFamily = keyof typeof EFFECT_FAMILIES;
export const NAMED_EFFECTS = Object.values(EFFECT_FAMILIES).flat() as readonly (typeof EFFECT_FAMILIES)[EffectFamily][number][];
export type NamedEffect = (typeof NAMED_EFFECTS)[number];

/** What each named effect is, in a line: used in prompts and on the recipe page. */
export const EFFECT_NOTES: Record<NamedEffect, string> = {
  dotHop: "a dot hops along the line and the word appears behind it",
  rollout: "a dot rolls in and the word unrolls from it",
  slingshot: "a dot slings the word in from the side with an overshoot",
  splits: "three dots split apart and become the word",
  timelineScrub: "a thin line scrubs across and reveals the word as it passes",
  tracedOutline: "the word's outline is drawn as a stroke, then fills",
  orbitRing: "a ring orbits the line, then the word settles inside it",
  pluckedString: "a line vibrates like a plucked string, then resolves into the word",
  stickerStack: "each word drops in on its own label sticker, stacking upwards",
  oneBigSlam: "one huge word slams down with motion trails and a hit",
  tumblingLetters: "the letters fall and rotate into place one by one",
  heavyLanding: "the word drops from above and lands with a squash",
  pixelSwarm: "particles swarm in and converge into the word",
  pixelRain: "pixels rain down and stack into the word",
  mosaicResolve: "chunky mosaic blocks resolve into the sharp word",
  ledScoreboard: "the word scrolls in as an LED dot-matrix",
};

const ownAnimations = TEXT_ANIMATIONS.filter((a) => a !== "auto");
export const TITLE_EFFECTS = [...ownAnimations, ...NAMED_EFFECTS, "other"] as const;
export type TitleEffect = (typeof TITLE_EFFECTS)[number];

const ms = z.number().int().min(0).max(600_000);
/** At most this many keyframes are saved and read per reference. */
export const MAX_KEYFRAMES = 40;
const unit = z.number().min(0).max(1);

export const recipeShotSchema = z.object({
  startMs: ms,
  endMs: ms,
  /** Mean frame-to-frame change in the shot, 0..1 (the render checks' motion measure). */
  motion: unit.optional(),
});
export type RecipeShot = z.infer<typeof recipeShotSchema>;

export const recipeTitleSchema = z.object({
  text: z.string().min(1).max(200),
  startMs: ms,
  endMs: ms,
  /** The title's box as fractions of the frame (0..1 from the top left). */
  box: z.object({ x: unit, y: unit, w: unit, h: unit }).optional(),
  effect: z.enum(TITLE_EFFECTS).default("other"),
  /** What the effect looks like when it is "other", or anything worth keeping about it. */
  effectNote: z.string().max(300).optional(),
  /** Plain words about the type: weight, case, colour, plate or outline. */
  look: z.string().max(200).optional(),
  /** Hex colour of the type, when one dominates. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Set when the title shows words being said (a caption) rather than a written headline. */
  spoken: z.boolean().optional(),
});
export type RecipeTitle = z.infer<typeof recipeTitleSchema>;

export const styleRecipeSchema = z.object({
  version: z.literal(1),
  durationMs: ms,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  shots: z.array(recipeShotSchema).max(400),
  pacing: z.object({
    shotCount: z.number().int().min(0),
    medianShotMs: ms,
    meanShotMs: ms,
    cutsPerSecond: z.number().min(0),
    /** When the first cut lands; null for a single-shot reel. */
    firstCutMs: ms.nullable(),
  }),
  speech: z.object({
    words: z.number().int().min(0),
    wordsPerMinute: z.number().min(0),
    firstWordMs: ms.nullable(),
    /** Share of the reel with someone speaking. */
    spokenShare: unit,
    text: z.string().max(4000),
  }).nullable(),
  beat: z.object({ bpm: z.number().positive(), cutsOnBeatShare: unit }).nullable(),
  titles: z.array(recipeTitleSchema).max(100),
  /** The reel's shape in a sentence or two (talking head, grid demo, walkthrough...), from the frame reading. */
  format: z.string().max(600).optional(),
  /** Anything else a reel following it should copy: an outro card, a recurring layout, a colour. */
  notes: z.array(z.string().max(300)).max(20).default([]),
});
export type StyleRecipe = z.infer<typeof styleRecipeSchema>;

/** Cut times in ms from ffmpeg's `select='gt(scene,T)',showinfo` stderr. */
export function parseSceneCuts(log: string): number[] {
  const cuts: number[] = [];
  for (const match of log.matchAll(/pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g)) cuts.push(Math.round(Number(match[1]) * 1000));
  return [...new Set(cuts)].sort((a, b) => a - b);
}

/**
 * The shots between cuts. Cuts closer than `minShotMs` to the previous kept cut (a two-frame flash scores twice) or to
 * either end of the reel are dropped, so every shot is at least that long.
 */
export function shotsFromCuts(cutsMs: readonly number[], durationMs: number, minShotMs = 200): RecipeShot[] {
  const kept: number[] = [];
  for (const cut of [...cutsMs].sort((a, b) => a - b)) {
    const previous = kept.at(-1) ?? 0;
    if (cut - previous < minShotMs || durationMs - cut < minShotMs) continue;
    kept.push(cut);
  }
  const edges = [0, ...kept, durationMs];
  return edges.slice(1).map((endMs, i) => ({ startMs: edges[i], endMs }));
}

/** Gives each shot the mean of the motion samples ({ ms, value }) that fall in it. */
export function withMotion(shots: readonly RecipeShot[], samples: readonly { ms: number; value: number }[]): RecipeShot[] {
  return shots.map((shot) => {
    const inShot = samples.filter((s) => s.ms >= shot.startMs && s.ms < shot.endMs);
    if (inShot.length === 0) return { ...shot };
    const mean = inShot.reduce((sum, s) => sum + s.value, 0) / inShot.length;
    return { ...shot, motion: Math.round(Math.min(1, Math.max(0, mean)) * 1000) / 1000 };
  });
}

export function pacingOf(shots: readonly RecipeShot[]): StyleRecipe["pacing"] {
  const lengths = shots.map((s) => s.endMs - s.startMs).sort((a, b) => a - b);
  const durationMs = shots.length ? shots[shots.length - 1].endMs - shots[0].startMs : 0;
  const mid = Math.floor(lengths.length / 2);
  const median = lengths.length === 0 ? 0 : lengths.length % 2 ? lengths[mid] : (lengths[mid - 1] + lengths[mid]) / 2;
  const mean = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const cuts = Math.max(0, shots.length - 1);
  return {
    shotCount: shots.length,
    medianShotMs: Math.round(median),
    meanShotMs: Math.round(mean),
    cutsPerSecond: durationMs > 0 ? Math.round((cuts / (durationMs / 1000)) * 100) / 100 : 0,
    firstCutMs: shots.length > 1 ? shots[1].startMs : null,
  };
}

export type RecipeWord = { text: string; startMs: number; endMs: number };

/** Speech facts from a transcript's words; null when nothing is said. */
export function speechOf(words: readonly RecipeWord[], durationMs: number): StyleRecipe["speech"] {
  const said = words.filter((w) => w.text.trim() && !/^\[.*\]?$/.test(w.text.trim()));
  if (said.length === 0 || durationMs <= 0) return null;
  // Spoken time: the union of word spans, with gaps under 300 ms treated as one breath.
  let spoken = 0;
  let runStart = said[0].startMs;
  let runEnd = said[0].endMs;
  for (const word of said.slice(1)) {
    if (word.startMs - runEnd < 300) runEnd = Math.max(runEnd, word.endMs);
    else { spoken += runEnd - runStart; runStart = word.startMs; runEnd = word.endMs; }
  }
  spoken += runEnd - runStart;
  const speakingMs = said[said.length - 1].endMs - said[0].startMs;
  return {
    words: said.length,
    wordsPerMinute: speakingMs > 0 ? Math.round((said.length / (speakingMs / 60_000)) * 10) / 10 : 0,
    firstWordMs: said[0].startMs,
    spokenShare: Math.round(Math.min(1, spoken / durationMs) * 100) / 100,
    text: said.map((w) => w.text.trim()).join(" ").slice(0, 4000),
  };
}

/** Share of cuts that land within `toleranceMs` of a beat (0 when there are no cuts or beats). */
export function recipeCutsOnBeat(shots: readonly RecipeShot[], beatsMs: readonly number[], toleranceMs = 60): number {
  const cuts = shots.slice(1).map((s) => s.startMs);
  if (cuts.length === 0 || beatsMs.length === 0) return 0;
  const hits = cuts.filter((cut) => beatsMs.some((beat) => Math.abs(beat - cut) <= toleranceMs)).length;
  return Math.round((hits / cuts.length) * 100) / 100;
}

export type EffectSupport =
  | { supported: true; animation: (typeof TEXT_ANIMATIONS)[number] }
  | { supported: false; family: EffectFamily | null; note: string };

/** Whether ReelWalk draws a title effect today, and with which animation. */
export function effectSupport(effect: TitleEffect): EffectSupport {
  if ((ownAnimations as readonly string[]).includes(effect)) return { supported: true, animation: effect as (typeof TEXT_ANIMATIONS)[number] };
  for (const [family, members] of Object.entries(EFFECT_FAMILIES) as [EffectFamily, readonly NamedEffect[]][]) {
    if (members.includes(effect as NamedEffect)) return { supported: false, family, note: EFFECT_NOTES[effect as NamedEffect] };
  }
  return { supported: false, family: null, note: "an effect with no name yet" };
}

/** The distinct title effects in a recipe that ReelWalk cannot draw yet, in the order they first appear. */
export function recipeGaps(recipe: Pick<StyleRecipe, "titles">): { effect: TitleEffect; family: EffectFamily | null; note: string; firstMs: number }[] {
  const seen = new Map<TitleEffect, { effect: TitleEffect; family: EffectFamily | null; note: string; firstMs: number }>();
  for (const title of [...recipe.titles].sort((a, b) => a.startMs - b.startMs)) {
    const support = effectSupport(title.effect);
    if (support.supported || seen.has(title.effect)) continue;
    seen.set(title.effect, { effect: title.effect, family: support.family, note: title.effect === "other" ? (title.effectNote ?? support.note) : support.note, firstMs: title.startMs });
  }
  return [...seen.values()];
}

const seconds = (value: number) => `${(value / 1000).toFixed(1)} s`;

/** A short plain summary of a recipe. */
export function describeRecipe(recipe: StyleRecipe): string {
  const lines: string[] = [];
  const { pacing } = recipe;
  lines.push(`${seconds(recipe.durationMs)}, ${pacing.shotCount} shot${pacing.shotCount === 1 ? "" : "s"}` +
    (pacing.firstCutMs !== null ? `, first cut at ${seconds(pacing.firstCutMs)}, a median shot of ${seconds(pacing.medianShotMs)}` : ", one continuous shot") + ".");
  if (recipe.format) lines.push(recipe.format);
  if (recipe.speech) lines.push(`Spoken: ${recipe.speech.words} words at ${Math.round(recipe.speech.wordsPerMinute)} a minute, from ${seconds(recipe.speech.firstWordMs ?? 0)}.`);
  if (recipe.beat) lines.push(`Music at ${Math.round(recipe.beat.bpm)} BPM; ${Math.round(recipe.beat.cutsOnBeatShare * 100)}% of cuts on a beat.`);
  if (recipe.titles.length) {
    const effects = [...new Set(recipe.titles.map((t) => t.effect))];
    lines.push(`${recipe.titles.length} title${recipe.titles.length === 1 ? "" : "s"}; effects: ${effects.join(", ")}.`);
  }
  const gaps = recipeGaps(recipe);
  if (gaps.length) lines.push(`Not drawn by ReelWalk yet: ${gaps.map((g) => g.effect).join(", ")}.`);
  for (const note of recipe.notes) lines.push(note);
  return lines.join("\n");
}

// ── What the worker measures (before any model reads it) ─────────────────────

export const referenceAnalysisSchema = z.object({
  version: z.literal(1),
  durationMs: ms,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  shots: z.array(recipeShotSchema).max(400),
  beat: z.object({ bpm: z.number().positive(), beatsMs: z.array(ms).max(2000) }).nullable(),
  words: z.array(z.object({ text: z.string().max(100), startMs: ms, endMs: ms })).max(3000),
  /** Keyframes the worker saved for the title reading: when, and the object key of the JPEG. */
  keyframes: z.array(z.object({ atMs: ms, key: z.string().min(1).max(512) })).max(MAX_KEYFRAMES),
});
export type ReferenceAnalysis = z.infer<typeof referenceAnalysisSchema>;

/**
 * Motion samples from a frame series (the render checks' 72x128 grey frames): the mean absolute luma change from the
 * previous frame, 0..1, stamped with the later frame's time. The first frame has nothing to compare and is skipped.
 */
export function motionSamples(series: readonly { ms: number; frame: { luma: Float32Array } }[]): { ms: number; value: number }[] {
  const out: { ms: number; value: number }[] = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1].frame.luma, b = series[i].frame.luma;
    const n = Math.min(a.length, b.length);
    if (!n) continue;
    let sum = 0;
    for (let p = 0; p < n; p++) sum += Math.abs(b[p] - a[p]);
    out.push({ ms: series[i].ms, value: sum / n });
  }
  return out;
}

/**
 * When to take the keyframes a model reads titles from: the first three seconds every 250 ms (where hooks and their
 * title animations live), then every 500 ms, plus a frame 150 ms into each shot; deduplicated, in order, and thinned
 * evenly to at most `max`. Titles that animate are caught mid-move; titles that hold are seen more than once.
 */
export function keyframeTimes(shots: readonly RecipeShot[], durationMs: number, max = MAX_KEYFRAMES): number[] {
  const last = Math.max(0, durationMs - 50);
  const times = new Set<number>();
  for (let t = 0; t <= Math.min(3000, last); t += 250) times.add(t);
  for (let t = 3500; t <= last; t += 500) times.add(t);
  for (const shot of shots) if (shot.startMs + 150 <= last) times.add(shot.startMs + 150);
  const sorted = [...times].sort((a, b) => a - b);
  if (sorted.length <= max) return sorted;
  return Array.from({ length: max }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (max - 1))]);
}

/** What the model reads off the keyframes (REFERENCE_READ_JSON_SCHEMA is the same shape for structured output). */
export const referenceReadSchema = z.object({
  format: z.string().max(600),
  titles: z.array(recipeTitleSchema).max(100),
  notes: z.array(z.string().max(300)).max(20),
});
export type ReferenceRead = z.infer<typeof referenceReadSchema>;

/** The JSON schema of `referenceReadSchema`, for strict structured output (every field required, nulls allowed). */
export const REFERENCE_READ_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["format", "titles", "notes"],
  properties: {
    format: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
    titles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "startMs", "endMs", "box", "effect", "effectNote", "look", "color", "spoken"],
        properties: {
          text: { type: "string" },
          startMs: { type: "integer" },
          endMs: { type: "integer" },
          box: {
            anyOf: [{ type: "null" }, {
              type: "object", additionalProperties: false, required: ["x", "y", "w", "h"],
              properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
            }],
          },
          effect: { type: "string", enum: [...TITLE_EFFECTS] },
          effectNote: { type: ["string", "null"] },
          look: { type: ["string", "null"] },
          color: { type: ["string", "null"] },
          spoken: { type: ["boolean", "null"] },
        },
      },
    },
  },
} as const;

const clampUnit = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The model's raw answer made safe: nulls dropped, times clamped into the reel and ordered, boxes clamped into the
 * frame, colours that are not #rrggbb dropped, texts trimmed. Throws only when the shape itself is wrong.
 */
export function parseReferenceRead(raw: unknown, durationMs: number): ReferenceRead {
  const input = (raw ?? {}) as { format?: unknown; titles?: unknown; notes?: unknown };
  const titles = Array.isArray(input.titles) ? input.titles : [];
  const cleaned = titles.flatMap((t) => {
    const title = t as Record<string, unknown>;
    const text = typeof title.text === "string" ? title.text.trim().slice(0, 200) : "";
    if (!text) return [];
    const a = Math.round(Math.min(durationMs, Math.max(0, Number(title.startMs) || 0)));
    const b = Math.round(Math.min(durationMs, Math.max(0, Number(title.endMs) || 0)));
    const box = title.box && typeof title.box === "object" ? title.box as Record<string, number> : null;
    const color = typeof title.color === "string" && /^#[0-9a-fA-F]{6}$/.test(title.color) ? title.color : undefined;
    const effect = (TITLE_EFFECTS as readonly string[]).includes(String(title.effect)) ? title.effect : "other";
    return [{
      text, startMs: Math.min(a, b), endMs: Math.max(a, b), effect,
      ...(box ? { box: { x: clampUnit(Number(box.x) || 0), y: clampUnit(Number(box.y) || 0), w: clampUnit(Number(box.w) || 0), h: clampUnit(Number(box.h) || 0) } } : {}),
      ...(typeof title.effectNote === "string" && title.effectNote.trim() ? { effectNote: title.effectNote.trim().slice(0, 300) } : {}),
      ...(typeof title.look === "string" && title.look.trim() ? { look: title.look.trim().slice(0, 200) } : {}),
      ...(color ? { color } : {}),
      ...(typeof title.spoken === "boolean" ? { spoken: title.spoken } : {}),
    }];
  });
  return referenceReadSchema.parse({
    format: typeof input.format === "string" ? input.format.trim().slice(0, 600) : "",
    titles: cleaned.slice(0, 100),
    notes: (Array.isArray(input.notes) ? input.notes : []).filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.trim().slice(0, 300)).slice(0, 20),
  });
}

/** The recipe from the worker's measurements and the model's reading of the keyframes. */
export function assembleRecipe(analysis: ReferenceAnalysis, read: ReferenceRead | null): StyleRecipe {
  return styleRecipeSchema.parse({
    version: 1,
    durationMs: analysis.durationMs,
    ...(analysis.width ? { width: analysis.width } : {}),
    ...(analysis.height ? { height: analysis.height } : {}),
    shots: analysis.shots,
    pacing: pacingOf(analysis.shots),
    speech: speechOf(analysis.words, analysis.durationMs),
    beat: analysis.beat ? { bpm: analysis.beat.bpm, cutsOnBeatShare: recipeCutsOnBeat(analysis.shots, analysis.beat.beatsMs) } : null,
    titles: read?.titles ?? [],
    ...(read?.format ? { format: read.format } : {}),
    notes: read?.notes ?? [],
  });
}
