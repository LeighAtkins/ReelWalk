/**
 * Recipe 5, "a day at" (ADR 0090): the music-only cinematic cut of the owner's reference reel 5 (DZThJZ5Sa3Z, ac_media_
 * for Marshall White), as a planner preset. Measured there (output/references/report.md, recipes.json "a-day-at"):
 *
 * - every picture change on the music's beat (71 % within ±70 ms; shots of whole beats), median shot 1.64 s, a few
 *   3–6 s payoff holds;
 * - wide shots and textures (a door crack, pool tiles, reeds) alternating;
 * - the film is a day: morning light to golden hour to dusk, one grade family throughout;
 * - the biggest picture, the house lit up at dusk, arrives as the music comes back after a break (reentry.ts);
 * - tiny calm centred type (cap height 1.25–2 %) for the agency and the address, fading slowly, crossing cuts;
 * - hard cuts only, no effects, no sound but the song.
 *
 * What it needs from the footage, and what it does without it: each shot's role (wide or detail) and time of day are
 * read from the caller (an analysis tag, the director, the agent). Time of day falls back to the clip's measured colour
 * (ADR 0070 statistics: luma and the V−U warmth), which is a guess and is reported as one. With no dusk footage it makes
 * the reduced "daylight" variant and says so: it will not feel like the reference's dusk payoff.
 *
 * Pure: shots, song and lines in; the timeline and a report of what it did out.
 */
import type { ColorStats } from "./look";
import { findReentry, type Reentry } from "./reentry";
import { REEL_FORMAT, type Clip, type SongSection, type TextOverlay, type Timeline } from "./timeline";

export type DayPhase = "day" | "golden" | "dusk";

export type DayShot = {
  /** A clip of the library (its window is chosen here). */
  clip: Clip;
  sourceDurationMs: number;
  role: "wide" | "detail";
  /** Time of day, when known; otherwise estimated from `colorStats`. */
  phase?: DayPhase;
  colorStats?: ColorStats;
  /** The reveal: the house lit up at dusk, from above or across the land. Put on the music's return. */
  reveal?: boolean;
  /** An empty sky or sunset, for the music's break. */
  sky?: boolean;
  /** Where the best part of the clip starts, source ms (the middle when absent). */
  bestStartMs?: number;
  /** Clips filmed from the same place at different times of day share a key: a day→dusk blend joins them. */
  framingKey?: string;
};

export type DayMusic = {
  assetId: string;
  bpm: number;
  beatOffsetMs: number;
  durationMs: number;
  energy: { stepMs: number; values: readonly number[] };
  sections?: readonly SongSection[];
  drop?: { atMs: number } | null;
  volume?: number;
};

export type DayLines = { credit?: string; place?: string };

export type DayReport = {
  variant: "faithful" | "daylight";
  /** The beat the cuts sit on (the song's, halved or doubled into 600–1000 ms), ms. */
  cutBeatMs: number;
  reentry: Reentry | null;
  /** The beat phase the cuts follow, song ms (the stored one, or moved half a beat to the return). */
  gridOffsetMs: number;
  /** Where the song starts and where the reveal lands, song and reel ms. */
  songStartMs: number;
  revealReelMs: number | null;
  shots: { clipId: string; phase: DayPhase; phaseFrom: "given" | "colour"; role: "wide" | "detail"; beats: number; startMs: number; slot: string }[];
  /** Planned picture changes within ±70 ms of a song beat, of all changes. */
  plannedOnBeat: { hits: number; of: number };
  medianShotMs: number;
  notes: string[];
};

export const DAY_AT = {
  /** Cut beats are the song's beat halved or doubled into this range (reel 5: 836 ms). */
  beatRange: [600, 1000] as const,
  /** Ordinary shots take these many beats in turn (whole beats; median 2 at ~80 bpm is about 1.5 s). */
  pattern: [2, 1, 2, 2, 3, 2, 1, 2] as const,
  /** Payoff holds: the reveal and the last shot, ms. */
  revealHoldMs: 4400,
  lastHoldMs: 5000,
  /** Where the reveal should land, as a share of the reel. */
  revealAt: [0.35, 0.65] as const,
  /** The two lines: cap height 1.9 % and 1.4 % of the frame (title size × 2.77 %), centred, slow fades. */
  creditSize: 0.68,
  placeSize: 0.5,
  textY: 0.49,
  onBeatToleranceMs: 70,
} as const;

/** The time of day a clip's colour suggests (ADR 0070 statistics: Y, U, V means): dark and cool is dusk, warm is golden hour. */
export function phaseFromColour(stats: ColorStats): DayPhase {
  const [y, u, v] = stats.mean;
  const warmth = v - u;
  if (y < 0.2 && warmth < 0.08) return "dusk";
  if (warmth >= 0.06 && y >= 0.2) return "golden";
  return "day";
}

/** The beat the cuts sit on: the song's beat, halved or doubled into DAY_AT.beatRange. */
export function cutBeatMs(bpm: number): number {
  let beat = 60_000 / bpm;
  while (beat < DAY_AT.beatRange[0]) beat *= 2;
  while (beat > DAY_AT.beatRange[1]) beat /= 2;
  return beat;
}

const ORDER: Record<DayPhase, number> = { day: 0, golden: 1, dusk: 2 };

/** Shots in an order that alternates wide and detail where it can, keeping the order given within each role. */
function alternate<T extends { role: "wide" | "detail" }>(shots: T[], startWith: "wide" | "detail" = "detail"): T[] {
  const wides = shots.filter((shot) => shot.role === "wide"), details = shots.filter((shot) => shot.role === "detail");
  const out: T[] = [];
  let want = startWith;
  while (wides.length || details.length) {
    const from = want === "wide" ? (wides.length ? wides : details) : (details.length ? details : wides);
    out.push(from.shift()!);
    want = want === "wide" ? "detail" : "wide";
  }
  return out;
}

/** The window of `durationMs` a shot plays: its best start, or the middle, kept inside the source. */
function windowOf(shot: DayShot, durationMs: number): { sourceStartMs: number; sourceEndMs: number } {
  const room = Math.max(0, shot.sourceDurationMs - durationMs);
  const wanted = shot.bestStartMs ?? room / 2;
  const start = Math.round(Math.max(0, Math.min(room, wanted)));
  return { sourceStartMs: start, sourceEndMs: Math.min(shot.sourceDurationMs, start + Math.round(durationMs)) };
}

/**
 * The "a day at" cut of `shots` to `music`. `base` gives the reel's other fields (logo, details, brand); its clips,
 * texts and music are replaced. Throws when there is too little to make it (fewer than 6 video shots, or a song with no
 * tempo); the report says what was guessed and what was missing.
 */
export function planDayAt(base: Timeline, shots: readonly DayShot[], music: DayMusic, lines: DayLines, newId: () => string): { timeline: Timeline; report: DayReport } {
  const usable = shots.filter((shot) => shot.clip.kind === "VIDEO" && shot.sourceDurationMs >= 1200);
  if (usable.length < 6) throw new Error(`"A day at" needs at least 6 video shots; there are ${usable.length}.`);
  if (!(music.bpm > 0)) throw new Error(`"A day at" is cut on the beat: the song needs a tempo.`);
  const notes: string[] = [];
  const beat = cutBeatMs(music.bpm);
  const songBeat = 60_000 / music.bpm;

  const read = usable.map((shot) => {
    const phase = shot.phase ?? (shot.colorStats ? phaseFromColour(shot.colorStats) : "day");
    return { ...shot, phase, phaseFrom: (shot.phase ? "given" : "colour") as "given" | "colour" };
  });
  if (read.some((shot) => shot.phaseFrom === "colour")) notes.push("Time of day was guessed from colour for some shots (no tag given).");

  // The reveal: a shot marked as one, else the brightest dusk wide (the house lit up), else the reduced variant.
  const dusk = read.filter((shot) => shot.phase === "dusk");
  const luma = (shot: (typeof read)[number]) => shot.colorStats?.mean[0] ?? 0;
  let reveal = read.find((shot) => shot.reveal) ?? [...dusk].filter((shot) => shot.role === "wide").sort((a, b) => luma(b) - luma(a))[0] ?? null;
  const variant: DayReport["variant"] = reveal && reveal.phase === "dusk" ? "faithful" : "daylight";
  if (!reveal) {
    reveal = read.filter((shot) => shot.role === "wide").sort((a, b) => ORDER[b.phase] - ORDER[a.phase])[0] ?? read[0];
    notes.push("No dusk footage: the daylight variant puts the music's return on the latest wide shot. It will not feel like the reference's dusk payoff.");
  } else if (variant === "daylight") {
    notes.push("The reveal shot is not dusk: the daylight variant. It will not feel like the reference's dusk payoff.");
  }
  const sky = read.find((shot) => shot.sky && shot !== reveal) ?? null;
  const rest = read.filter((shot) => shot !== reveal && shot !== sky);
  const before = rest.filter((shot) => shot.phase !== "dusk");
  const after = rest.filter((shot) => shot.phase === "dusk");
  // Day before golden hour before dusk; wides and textures alternate inside each light.
  const pre = [...alternate(before.filter((shot) => shot.phase === "day"), "detail"), ...alternate(before.filter((shot) => shot.phase === "golden"), "wide")];
  // After the reveal, the dusk shots; the last is a wide, held.
  const postWides = after.filter((shot) => shot.role === "wide");
  const last = postWides.length > 1 || (postWides.length === 1 && after.length > 1) ? postWides[postWides.length - 1] : null;
  const post = [...alternate(after.filter((shot) => shot !== last), "detail"), ...(last ? [last] : [])];

  // Lengths in whole cut beats. The opening shot is one beat (the first change inside a second, as reel 5's 0.84 s).
  type Planned = { shot: (typeof read)[number]; beats: number; slot: string };
  const plan: Planned[] = [];
  let k = 0;
  const fits = (shot: DayShot, beats: number) => Math.max(1, Math.min(beats, Math.floor(shot.sourceDurationMs / beat)));
  pre.forEach((shot, i) => plan.push({ shot, beats: fits(shot, i === 0 ? 1 : DAY_AT.pattern[k++ % DAY_AT.pattern.length]), slot: i === 0 ? "open" : shot.phase }));
  const revealIndex = () => plan.findIndex((entry) => entry.slot === "reveal");

  // The song: find its return, then start it so the return lands on the reveal's first frame.
  const preMs = () => plan.reduce((sum, entry) => sum + entry.beats * beat, 0);
  const reentry = findReentry({ energy: music.energy, sections: music.sections ? [...music.sections] : undefined, drop: music.drop ?? null }, { fromMs: preMs() + 2 * beat });
  // The break plays under the empty sky: its length runs from the stop to the return.
  if (sky) {
    const quiet = reentry?.kind === "break" && reentry.breakFromMs != null ? reentry.atMs - reentry.breakFromMs : 2 * beat;
    // At most four beats: a long breakdown plays on under the golden-hour shots before it (reel 5's empty sky: 1.24 s).
    plan.push({ shot: sky, beats: fits(sky, Math.min(4, Math.max(2, Math.round(quiet / beat)))), slot: "break" });
  }
  plan.push({ shot: reveal, beats: fits(reveal, Math.round(DAY_AT.revealHoldMs / beat)), slot: "reveal" });
  // The last shot is held, a wide when there is one to end on.
  post.forEach((shot, i) => plan.push({ shot, beats: fits(shot, i === post.length - 1 ? Math.round(DAY_AT.lastHoldMs / beat) : DAY_AT.pattern[k++ % DAY_AT.pattern.length]), slot: "dusk" }));

  const revealReelMs = plan.slice(0, revealIndex()).reduce((sum, entry) => sum + entry.beats * beat, 0);
  let songStartMs: number;
  let gridOffsetMs = music.beatOffsetMs;
  if (reentry) {
    // The return snapped to the nearest half beat of the stored grid: a hard return is the song's clearest beat, and a
    // stored phase can sit half a beat off (it did on the proof track, ADR 0090). The cuts follow the return's phase.
    const half = songBeat / 2;
    const back = music.beatOffsetMs + Math.round((reentry.atMs - music.beatOffsetMs) / half) * half;
    gridOffsetMs = ((back % songBeat) + songBeat) % songBeat;
    if (Math.abs(gridOffsetMs - (music.beatOffsetMs % songBeat)) > 1) notes.push(`The beat phase was moved half a beat to the song's return (${music.beatOffsetMs} → ${Math.round(gridOffsetMs)} ms).`);
    songStartMs = back - revealReelMs;
    if (songStartMs < 0) {
      notes.push(`The song's return (${(reentry.atMs / 1000).toFixed(1)} s) comes before the reveal can (${(revealReelMs / 1000).toFixed(1)} s in): started at 0 and the reveal is not on it.`);
      songStartMs = 0;
    }
  } else {
    notes.push("The song has no break, section change or drop to put the reveal on: cut on the beat only.");
    songStartMs = music.beatOffsetMs;
  }
  gridOffsetMs = Math.round(gridOffsetMs);
  songStartMs = Math.round(songStartMs);
  const totalMs = plan.reduce((sum, entry) => sum + entry.beats * beat, 0);
  if (songStartMs + totalMs > music.durationMs) notes.push("The song ends before the reel does.");
  const share = totalMs > 0 ? revealReelMs / totalMs : 0;
  if (reentry && (share < DAY_AT.revealAt[0] || share > DAY_AT.revealAt[1])) notes.push(`The reveal lands ${Math.round(share * 100)} % of the way in (the reference: 43 %).`);

  // Clips: every cut on a whole cut beat from frame 0 (rounded to whole milliseconds; the frame plan rounds to frames).
  const fps = REEL_FORMAT.fps;
  let at = 0;
  const clips: Clip[] = plan.map((entry, i) => {
    const startMs = Math.round(at), endMs = Math.round(at + entry.beats * beat);
    at += entry.beats * beat;
    const window = windowOf(entry.shot, endMs - startMs);
    return { ...entry.shot.clip, id: i === 0 || !plan.slice(0, i).some((other) => other.shot.clip.id === entry.shot.clip.id) ? entry.shot.clip.id : newId(),
      ...window, speed: 1, filter: "warm", motion: "none", transitionIn: "cut", volume: 0, ramp: null, camera: null } as Clip;
  });
  // Day→dusk blends (gap #7, lite): only between neighbours filmed from the same place.
  plan.forEach((entry, i) => {
    const prev = plan[i - 1];
    if (prev && entry.shot.framingKey && entry.shot.framingKey === prev.shot.framingKey && entry.shot.phase !== prev.shot.phase) clips[i] = { ...clips[i], transitionIn: "softDissolve" };
  });

  // The lines: tiny, centred, fading slowly, crossing cuts (reel 5's credit 0.52–3.36 s; address over the land).
  const texts: TextOverlay[] = [];
  const line = (text: string, startMs: number, endMs: number, size: number): TextOverlay => ({
    id: newId(), text: text.toUpperCase(), startMs: Math.round(startMs), endMs: Math.round(endMs), x: 0.5, y: DAY_AT.textY, style: "elegant", color: "#ffffff",
    size, byApp: true, animation: "fade", shadow: "soft", tracking: 0.12,
  } as TextOverlay);
  if (lines.credit) texts.push(line(lines.credit, 500, Math.min(revealReelMs || totalMs, Math.max(3000, 4 * beat)), DAY_AT.creditSize));
  if (lines.place) {
    const from = Math.max(6000, Math.round(totalMs * 0.15 / beat) * beat) - 700;
    texts.push(line(lines.place, from, Math.min(from + 4000, (revealReelMs || totalMs) - 300), DAY_AT.placeSize));
  }

  const timeline: Timeline = {
    ...base,
    clips,
    texts,
    music: { assetId: music.assetId, sourceStartMs: songStartMs, volume: music.volume ?? 0.9, bpm: music.bpm, beatOffsetMs: gridOffsetMs, onBeat: false } as Timeline["music"],
  };

  // The plan's own beat check: each change against the song's beats (it should be all of them, to the frame).
  let cuts = 0, hits = 0, t = 0;
  for (let i = 0; i < plan.length - 1; i++) {
    t += plan[i].beats * beat;
    const frameMs = (Math.round((t * fps) / 1000) * 1000) / fps;
    const song = songStartMs + frameMs;
    const off = song - (gridOffsetMs + Math.round((song - gridOffsetMs) / songBeat) * songBeat);
    cuts++;
    if (Math.abs(off) <= DAY_AT.onBeatToleranceMs) hits++;
  }
  const lengths = plan.map((entry) => entry.beats * beat).sort((a, b) => a - b);
  let start = 0;
  const report: DayReport = {
    variant,
    cutBeatMs: Math.round(beat * 10) / 10,
    gridOffsetMs,
    reentry,
    songStartMs,
    revealReelMs: reentry ? Math.round(revealReelMs) : null,
    shots: plan.map((entry) => {
      const row = { clipId: entry.shot.clip.id, phase: entry.shot.phase, phaseFrom: entry.shot.phaseFrom, role: entry.shot.role, beats: entry.beats, startMs: Math.round(start), slot: entry.slot };
      start += entry.beats * beat;
      return row;
    }),
    plannedOnBeat: { hits, of: cuts },
    medianShotMs: Math.round(lengths[Math.floor(lengths.length / 2)]),
    notes,
  };
  return { timeline, report };
}
