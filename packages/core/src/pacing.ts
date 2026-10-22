/**
 * Editing to the song (ADR 0059): a cut plan that moves with the music, and
 * "On the beat", which puts the things that happen inside a shot (a title's
 * entrance, a particle burst, a whip) on the bar.
 *
 * Pure and deterministic: the same reel, song and energy always give the same
 * cut, so moving the Energy control back to where it was gives back the same
 * reel, and the plan is tested without a browser.
 */
import { beatPeriodMs } from "./beats";
import type { MotionSample } from "./motion";
import { setTypeMotionCue, typeMotionCues } from "./kinetic";
import { isGeneratedAssetId } from "./presenter";
import { rampPreset } from "./ramp";
import { BEATS_PER_BAR, sectionAt } from "./song";
import { clipRunEndMs, retimeTexts, textAttachment } from "./text-timing";
import { MIN_CLIP_MS, clipDurationMs, clipStartsMs, timelineDurationMs, type Clip, type Music, type SectionKind, type SongSection, type TextOverlay, type Timeline } from "./timeline";

/** The Energy control's stops, chill to hype. */
export const ENERGY_STOPS = [
  { label: "Chill", value: 0 },
  { label: "Easy", value: 0.25 },
  { label: "Steady", value: 0.5 },
  { label: "Lively", value: 0.75 },
  { label: "Hype", value: 1 },
] as const;
export const DEFAULT_ENERGY = 0.5;

/** The song's beats in reel time: beat k is at `firstMs + k * periodMs` (k may be negative); it starts a bar when (k - phase) is a multiple of 4. */
export type ReelGrid = { periodMs: number; firstMs: number; phase: number };

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The beat grid of the reel's song, in reel time, or null when its tempo is unknown. */
export function reelGrid(music: Music | null | undefined): ReelGrid | null {
  if (!music?.bpm) return null;
  const periodMs = beatPeriodMs({ bpm: music.bpm, offsetMs: music.beatOffsetMs ?? 0 });
  const offset = music.beatOffsetMs ?? 0;
  // The analysed bar lines when there are any; otherwise the first beat starts a bar.
  const first = music.downbeats?.[0];
  const phase = first === undefined ? 0 : mod(Math.round((first - offset) / periodMs), BEATS_PER_BAR);
  return { periodMs, firstMs: offset - music.sourceStartMs, phase };
}

/** Reel time of beat `k`. */
const beatAt = (grid: ReelGrid, k: number) => grid.firstMs + k * grid.periodMs;

/** The first beat at or after `ms` whose index is on a grid of `step` beats laid from the bar lines (step 4: downbeats). */
function gridAtOrAfter(grid: ReelGrid, ms: number, step: number): number {
  let k = Math.ceil((ms - grid.firstMs) / grid.periodMs - 1e-9);
  while (mod(k - grid.phase, step) !== 0) k++;
  return beatAt(grid, k);
}

/** The last beat at or before `ms` on a grid of `step` beats. */
function gridAtOrBefore(grid: ReelGrid, ms: number, step: number): number {
  let k = Math.floor((ms - grid.firstMs) / grid.periodMs + 1e-9);
  while (mod(k - grid.phase, step) !== 0) k--;
  return beatAt(grid, k);
}

/** The downbeat (first beat of a bar) nearest to reel time `ms`. */
export function nearestDownbeatMs(grid: ReelGrid, ms: number): number {
  const before = gridAtOrBefore(grid, ms, BEATS_PER_BAR);
  const after = gridAtOrAfter(grid, ms, BEATS_PER_BAR);
  return Math.round(ms - before <= after - ms ? before : after);
}

/** Downbeats (reel time, ms, rounded) within [fromMs, toMs]. */
export function downbeatsBetween(grid: ReelGrid, fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  for (let at = gridAtOrAfter(grid, fromMs, BEATS_PER_BAR); at <= toMs + 1e-6; at += grid.periodMs * BEATS_PER_BAR) out.push(Math.round(at));
  return out;
}

/** The song's sections moved into reel time (the reel starts `sourceStartMs` into the song). */
export function reelSections(music: Music | null | undefined): SongSection[] {
  if (!music?.sections?.length) return [];
  return music.sections
    .map((section) => ({ ...section, startMs: section.startMs - music.sourceStartMs, endMs: section.endMs - music.sourceStartMs }))
    .filter((section) => section.endMs > 0)
    .map((section) => ({ ...section, startMs: Math.max(0, section.startMs) }));
}

// ── Clip energy ─────────────────────────────────────────────────

/**
 * How much a shot moves, 0 (a still) to 1 (a whip pan), from the measured
 * motion (motion.ts) of frames sampled across it: mostly how fast the
 * picture travels, a little how much it changes.
 */
export function clipEnergyFromMotion(samples: readonly MotionSample[]): number | null {
  if (samples.length === 0) return null;
  let speed = 0;
  let change = 0;
  for (const sample of samples) {
    const seconds = Math.max(0.04, (sample.t2 - sample.t) / 1000);
    // Pixels per second at the 48-px-wide analysis size; 24 px/s is half the frame a second.
    speed += Math.hypot(sample.dx, sample.dy) / seconds;
    change += sample.change;
  }
  speed /= samples.length;
  change /= samples.length;
  return round2(Math.min(1, 0.7 * Math.min(1, speed / 24) + 0.3 * Math.min(1, change / 0.06)));
}

/** An energy for a clip nothing was measured for: a photo by its camera move, a 360 by its sweep, a video in the middle. */
export function fallbackClipEnergy(clip: Clip): number {
  if (clip.kind === "VIDEO") return 0.5;
  if (clip.pano) return 0.35;
  if (clip.motion === "snap-in" || clip.motion === "snap-out") return 0.6;
  return clip.motion === "none" ? 0.15 : 0.3;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

// ── The cut plan ────────────────────────────────────────────────

/** Beats a shot holds in each part of the song: [at chill, at hype]. */
const SHOT_BEATS: Record<SectionKind | "none", [number, number]> = {
  intro: [8, 4],
  build: [4, 2],
  drop: [4, 1],
  outro: [8, 4],
  none: [4, 2],
};
/** The hero shot, on the drop, holds longer than the shots around it. */
const HERO_BEATS: [number, number] = [8, 4];
/** A 360 photo needs time for its sweep to read. */
export const PANO_MIN_MS = 3500;

export type PaceShot = { clipId: string; startMs: number; endMs: number; beats: number; section: SectionKind | "none"; hero: boolean; held: boolean };
export type PacePlan = { clips: Clip[]; shots: PaceShot[]; heroClipId: string | null };

export type PaceOptions = {
  /** 0 (chill) to 1 (hype). */
  energy: number;
  /** MEASURED energy of each clip by clip id (`clipEnergyFromMotion`). Only measured clips can be the hero; the rest use `fallbackClipEnergy` for their length. */
  clipEnergy?: Record<string, number>;
  /**
   * Assets whose clips carry speech (a transcript with words). A video playing its own sound (volume > 0) from one of
   * these is held: never shortened, moved or reordered. Left out (unknown), every video with its sound on is held.
   */
  speechAssetIds?: readonly string[];
  /** The hero an earlier Energy change chose; kept while it can still be the hero, so later changes do not churn the order. */
  heroClipId?: string | null;
  sourceDurationsMs?: Record<string, number | null | undefined>;
  /**
   * Ramp into the cut (ADR 0067): a video shot in the build or the drop (or anywhere, with no sections, from Steady
   * up) that has no ramp of its own accelerates into its cut, so the beat-cut lands on the fast part. Held clips and
   * the hero (held longer, on the drop) are left alone.
   */
  ramps?: boolean;
};

/**
 * Whether pacing must leave a clip exactly as it is: an AI take (a presenter speaking, generated footage), or a video
 * whose own speech is heard. Cutting either to its middle loses the line.
 */
export function heldByPace(clip: Clip, speechAssetIds?: readonly string[]): boolean {
  if (isGeneratedAssetId(clip.assetId)) return true;
  if (clip.kind !== "VIDEO" || clip.volume <= 0) return false;
  return speechAssetIds ? speechAssetIds.includes(clip.assetId) : true;
}

/** Beats for one shot: the section's chill-to-hype range at this energy, shortened a little for a lively clip and lengthened for a still one, in powers of two. */
function shotBeats(range: [number, number], energy: number, clipEnergy: number, minBeats: number): number {
  const [chill, hype] = range.map(Math.log2);
  const level = chill + (hype - chill) * energy - (clipEnergy - 0.5);
  const floor = Math.ceil(Math.log2(minBeats));
  return 2 ** Math.min(3, Math.max(floor, Math.round(level)));
}

/**
 * The cut plan: every clip, in order, for a number of beats chosen by the
 * part of the song it plays over and the energy: slow holds in the intro,
 * faster cuts through the build, the hero shot held on the drop, and the
 * outro slowing down again. Cuts land on a grid of the shot's length laid
 * from the bar lines (a four-beat shot cuts on a downbeat) and on every
 * section start, so the drop is a cut. A video is never played past its
 * source (it keeps the middle of what it showed); when not even one beat
 * fits, it cuts off the beat and the next cut goes back on it.
 *
 * The hero is the clip MEASURED to move most, and only when at least two
 * clips were measured and they differ; with nothing measured the order is
 * kept. A held clip (`heldByPace`) keeps its window and its place among the
 * other clips; the hero never jumps over one. Null when the song has no tempo
 * or there is nothing to cut.
 */
export function planPace(timeline: Timeline, options: PaceOptions): PacePlan | null {
  const music = timeline.music;
  const grid = reelGrid(music);
  if (!grid || timeline.clips.length === 0) return null;
  const sections = reelSections(music);
  const held = (clip: Clip) => heldByPace(clip, options.speechAssetIds);
  const hero = chooseHero(timeline, options, sections, grid, held);
  const plan = cutPlan(timeline, options, sections, grid, held, hero);
  if (!hero) return plan;
  // The hero never jumps over a held clip: that would reorder a take with its own sound.
  const before = timeline.clips.map((clip) => clip.id);
  const after = plan.clips.map((clip) => clip.id);
  const crosses = timeline.clips.some((clip) => {
    if (!held(clip)) return false;
    const was = Math.sign(before.indexOf(hero.id) - before.indexOf(clip.id));
    return was !== Math.sign(after.indexOf(hero.id) - after.indexOf(clip.id));
  });
  return crosses ? cutPlan(timeline, options, sections, grid, held, null) : plan;
}

function chooseHero(timeline: Timeline, options: PaceOptions, sections: SongSection[], grid: ReelGrid, held: (clip: Clip) => boolean): Clip | null {
  if (!sections.some((section) => section.kind === "drop") || timeline.clips.length < 2) return null;
  const heroMin = HERO_BEATS[1] * grid.periodMs * 0.5;
  const durations = options.sourceDurationsMs ?? {};
  const eligible = (clip: Clip) => !held(clip) && longestMs(clip, durations) >= heroMin;
  if (options.heroClipId) {
    const kept = timeline.clips.find((clip) => clip.id === options.heroClipId);
    if (kept && eligible(kept)) return kept;
  }
  const measured = timeline.clips.filter((clip) => options.clipEnergy?.[clip.id] !== undefined);
  if (measured.length < 2) return null;
  const energies = measured.map((clip) => options.clipEnergy![clip.id]);
  if (Math.max(...energies) - Math.min(...energies) < 0.05) return null;
  let hero: Clip | null = null;
  let best = -1;
  for (const clip of measured) {
    const energy = options.clipEnergy![clip.id];
    if (!eligible(clip) || energy <= best) continue;
    best = energy;
    hero = clip;
  }
  return hero;
}

function longestMs(clip: Clip, durations: Record<string, number | null | undefined>): number {
  if (clip.kind !== "VIDEO") return Infinity;
  return Math.floor((durations[clip.assetId] ?? clip.sourceEndMs) / clip.speed);
}

function cutPlan(timeline: Timeline, options: PaceOptions, sections: SongSection[], grid: ReelGrid, held: (clip: Clip) => boolean, heroClip: Clip | null): PacePlan {
  const energy = Math.min(1, Math.max(0, options.energy));
  const durations = options.sourceDurationsMs ?? {};
  const P = grid.periodMs;
  const minBeats = Math.max(1, Math.ceil(MIN_CLIP_MS / P - 1e-9));
  const energyOf = (clip: Clip) => options.clipEnergy?.[clip.id] ?? fallbackClipEnergy(clip);
  const drop = sections.find((section) => section.kind === "drop");
  const queue = timeline.clips.filter((clip) => clip !== heroClip);
  let heroPending = heroClip !== null;

  const clips: Clip[] = [];
  const shots: PaceShot[] = [];
  let t = 0;
  while (queue.length > 0 || heroPending) {
    let clip: Clip;
    let isHero = false;
    if (heroPending && (t >= drop!.startMs - P / 2 || queue.length === 0)) {
      clip = heroClip!;
      heroPending = false;
      isHero = true;
    } else clip = queue.shift()!;

    const kind: SectionKind | "none" = sectionAt(sections, t + P / 4)?.kind ?? "none";
    if (held(clip)) {
      // Exactly as it was: the next cut goes back on the grid.
      const actual = clipDurationMs(clip);
      clips.push(clip);
      shots.push({ clipId: clip.id, startMs: t, endMs: t + actual, beats: Math.round(actual / P), section: kind, hero: false, held: true });
      t += actual;
      continue;
    }
    const beats = isHero ? shotBeats(HERO_BEATS, energy, 0.5, minBeats) : shotBeats(SHOT_BEATS[kind], energy, energyOf(clip), minBeats);
    const minimum = Math.max(MIN_CLIP_MS, clip.pano ? PANO_MIN_MS : 0);
    const step = Math.min(beats, BEATS_PER_BAR);
    let end = gridAtOrAfter(grid, Math.max(t + beats * P - (step * P) / 2, t + minimum), step);
    // Every section start is a cut, so the drop lands on one.
    const boundary = sections.find((section) => section.startMs > t + minimum && section.startMs < end - 1);
    if (boundary) end = boundary.startMs;
    // A video plays no further than its source: the longest whole number of beats that fits, else what fits.
    const most = longestMs(clip, durations);
    if (end - t > most) {
      const fit = gridAtOrBefore(grid, t + most, 1);
      end = fit - t >= minimum ? fit : t + most;
    }
    const length = Math.max(1, Math.round(end) - t);
    const ramped = options.ramps && !isHero && rampsHere(clip, kind, energy) ? { ...clip, ramp: rampPreset("into-cut") } : clip;
    const next = withLength(ramped, length, durations);
    const actual = clipDurationMs(next);
    clips.push(next);
    shots.push({ clipId: clip.id, startMs: t, endMs: t + actual, beats, section: kind, hero: isHero, held: false });
    t += actual;
  }
  return { clips, shots, heroClipId: heroClip?.id ?? null };
}

/** Whether pacing gives this shot a ramp into its cut: a video without one, in a part of the song that drives. */
function rampsHere(clip: Clip, kind: SectionKind | "none", energy: number): boolean {
  if (clip.kind !== "VIDEO" || clip.ramp) return false;
  return kind === "build" || kind === "drop" || (kind === "none" && energy >= 0.5);
}

/** The clip playing `lengthMs` of reel time: a photo simply that long, a video keeping the middle of what it showed, inside its source. */
function withLength(clip: Clip, lengthMs: number, durations: Record<string, number | null | undefined>): Clip {
  if (clip.kind === "IMAGE") return { ...clip, sourceEndMs: clip.sourceStartMs + lengthMs };
  const source = durations[clip.assetId] ?? Math.max(clip.sourceEndMs, Math.round(lengthMs * clip.speed));
  const length = Math.min(source, Math.max(1, Math.round(lengthMs * clip.speed)));
  const middle = (clip.sourceStartMs + clip.sourceEndMs) / 2;
  const start = Math.max(0, Math.min(source - length, Math.round(middle - length / 2)));
  return { ...clip, sourceStartMs: start, sourceEndMs: start + length };
}

/** A short, stable key of the clips' order and windows (FNV-1a), to tell whether the reel is still the cut pacing made. */
export function clipsKey(clips: readonly Clip[]): string {
  let h = 0x811c9dc5;
  const text = clips.map((clip) => `${clip.id}:${clip.sourceStartMs}-${clip.sourceEndMs}`).join("|");
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * What an Energy change cuts from: while the reel is still exactly the cut the
 * last change made (`music.pace.resultKey`), the clips as they were before
 * pacing and the hero chosen then; once anything else changed the cut (a
 * trim, a reorder, a new clip), the reel as it is now.
 */
export function paceOrigin(timeline: Timeline): { clips: Clip[]; heroClipId: string | null } {
  const pace = timeline.music?.pace;
  if (!pace || pace.resultKey !== clipsKey(timeline.clips)) return { clips: timeline.clips, heroClipId: null };
  const byId = new Map(timeline.clips.map((clip) => [clip.id, clip]));
  if (pace.base.length !== timeline.clips.length || pace.base.some((entry) => !byId.has(entry.id))) return { clips: timeline.clips, heroClipId: null };
  return { clips: pace.base.map((entry) => ({ ...byId.get(entry.id)!, sourceStartMs: entry.sourceStartMs, sourceEndMs: entry.sourceEndMs })), heroClipId: pace.heroClipId };
}

/**
 * The reel cut to the song at `energy` (planned from `paceOrigin`), titles
 * following their clips by the attachment rule (ADR 0048), the plan recorded
 * on the music, and, when "On the beat" is on, entrances, bursts and whips on
 * the bar. The reel as it was when the song has no tempo.
 */
export function paceTimeline(timeline: Timeline, options: PaceOptions): Timeline {
  if (!timeline.music) return timeline;
  const origin = paceOrigin(timeline);
  const plan = planPace({ ...timeline, clips: origin.clips }, { ...options, heroClipId: options.heroClipId ?? origin.heroClipId });
  if (!plan) return timeline;
  const pace = { base: origin.clips.map(({ id, sourceStartMs, sourceEndMs }) => ({ id, sourceStartMs, sourceEndMs })), resultKey: clipsKey(plan.clips), heroClipId: plan.heroClipId };
  const music = { ...timeline.music, energy: Math.round(Math.min(1, Math.max(0, options.energy)) * 100) / 100, pace };
  const cut = retimeTexts(timeline, { ...timeline, music, clips: plan.clips });
  return music.onBeat ? putOnTheBeat(cut, options.sourceDurationsMs, options.speechAssetIds) : cut;
}

/** How far (ms) the reel runs past the end of its song, 0 when it does not or the song's length is unknown. */
export function pastSongEndMs(timeline: Timeline, songDurationMs: number | null | undefined): number {
  if (!timeline.music || !songDurationMs) return 0;
  return Math.max(0, timelineDurationMs(timeline) - (songDurationMs - timeline.music.sourceStartMs));
}

// ── On the beat ─────────────────────────────────────────────────

/** A title whose entrance moving would leave it shorter than this (or than it was, if shorter) stays where it is. */
const MIN_TEXT_MS = 800;
/** Titles that open the reel are on the first frames, and the cover: they never move. */
const OPENING_MS = 500;

/** Whether "On the beat" leaves a title where it is: the hook (its words are the cover), anything on the opening frames, room labels (redrawn by their own rule). */
function fixedTitle(text: TextOverlay): boolean {
  return text.id.startsWith("hook") || text.id.startsWith("room-") || text.startMs < OPENING_MS;
}

/**
 * "On the beat": each of these goes to the nearest downbeat, never so far
 * that it changes what it belongs to:
 * - a whip's cut (the clip before it lengthens or shortens, within its
 *   source, never below a 360's sweep and never a held clip; titles follow by
 *   the attachment rule);
 * - a title's entrance (`startMs`; the title keeps its length), staying over
 *   the clip it is attached to, and for a pinned title inside the frames its
 *   path was tracked on. Titles over one clip keep their order and never land
 *   on the same moment; a move that would leave a title under 800 ms is not
 *   made. The hook and anything starting in the first 500 ms never move;
 * - a particle burst (`particles.burstMs`), inside the title's life;
 * - the start of a title's shine or kinetic move (ADR 0061), inside the
 *   title's life, never for the hook or an opening title.
 * The presenter's pass (`passMs`) is never moved: it is where she really
 * crosses the words. Nothing that is not set is added. The reel as it was
 * without a tempo.
 */
export function putOnTheBeat(timeline: Timeline, sourceDurationsMs: Record<string, number | null | undefined> = {}, speechAssetIds?: readonly string[]): Timeline {
  const grid = reelGrid(timeline.music);
  if (!grid || timeline.clips.length === 0) return timeline;
  const afterWhips = whipsOnTheBeat(timeline, grid, sourceDurationsMs, speechAssetIds);
  const current = afterWhips === timeline ? timeline : retimeTexts(timeline, afterWhips);
  const total = timelineDurationMs(current);
  const starts = clipStartsMs(current);
  const nearestWithin = (ms: number, from: number, to: number) => {
    const candidates = downbeatsBetween(grid, from, to);
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (Math.abs(b - ms) < Math.abs(a - ms) ? b : a));
  };

  // Each title's scope (its clip, or the reel) and the window its entrance may move in.
  const placed = current.texts.map((text, at) => {
    const attachment = textAttachment(current, text);
    const index = attachment.kind === "clip" ? current.clips.findIndex((clip) => clip.id === attachment.clipId) : -1;
    let from = index >= 0 ? starts[index] : 0;
    let to = index >= 0 ? clipRunEndMs(current, index, starts) : total;
    if (text.pin && index >= 0) {
      const clip = current.clips[index];
      const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
      from = Math.max(from, starts[index] + (text.pin.fromMs - clip.sourceStartMs) / speed);
      to = Math.min(to, starts[index] + (text.pin.toMs - clip.sourceStartMs) / speed);
    }
    return { at, text, scope: index >= 0 ? current.clips[index].id : "", from: Math.max(from, OPENING_MS), to: Math.min(to, total) };
  });
  const texts = [...current.texts];
  const scopes = new Map<string, typeof placed>();
  for (const entry of placed) scopes.set(entry.scope, [...(scopes.get(entry.scope) ?? []), entry]);
  for (const group of scopes.values()) {
    group.sort((a, b) => a.text.startMs - b.text.startMs || a.at - b.at);
    let previous = -Infinity;
    group.forEach((entry, i) => {
      const { text } = entry;
      let next = text;
      if (!fixedTitle(text)) {
        const length = text.endMs - text.startMs;
        const entrance = nearestWithin(text.startMs, entry.from, entry.to - Math.min(length, MIN_TEXT_MS));
        const following = group[i + 1]?.text.startMs ?? Infinity;
        // Order kept, never two entrances on one moment, and never under 800 ms (or its own length) at the clip's end.
        if (entrance !== null && entrance !== text.startMs && entrance > previous && entrance < following) {
          const endMs = Math.round(Math.min(entrance + length, entry.to));
          if (endMs - entrance >= Math.min(length, MIN_TEXT_MS)) next = { ...next, startMs: entrance, endMs };
        }
      }
      // Its shine and kinetic move (ADR 0061) begin on a downbeat inside the title, with the same exclusions as the entrance.
      if (!fixedTitle(text)) {
        for (const cue of typeMotionCues(next)) {
          const at = nearestWithin(cue.reelMs, Math.max(next.startMs, OPENING_MS), next.endMs);
          if (at !== null && at !== cue.reelMs) next = setTypeMotionCue(next, cue.key, at);
        }
      }
      if (next.particles?.burstMs !== undefined && !next.id.startsWith("room-")) {
        const burst = nearestWithin(next.particles.burstMs, Math.max(next.startMs, OPENING_MS), next.endMs);
        if (burst !== null && burst !== next.particles.burstMs) next = { ...next, particles: { ...next.particles, burstMs: burst } };
      }
      previous = next.startMs;
      texts[entry.at] = next;
    });
  }
  const changed = texts.some((text, i) => text !== current.texts[i]);
  return changed ? { ...current, texts } : current;
}

/** Each whip's cut moved to the nearest downbeat by lengthening or shortening the clip before it, where its source, the shortest clip (a 360's sweep) and a held clip allow. */
function whipsOnTheBeat(timeline: Timeline, grid: ReelGrid, durations: Record<string, number | null | undefined>, speechAssetIds?: readonly string[]): Timeline {
  let clips = timeline.clips;
  for (let i = 1; i < clips.length; i++) {
    if (clips[i].transitionIn !== "whip") continue;
    const before = clips[i - 1];
    if (heldByPace(before, speechAssetIds)) continue;
    const cut = clipStartsMs({ ...timeline, clips })[i];
    const target = nearestDownbeatMs(grid, cut);
    const length = clipDurationMs(before) + (target - cut);
    if (target === cut || length < Math.max(MIN_CLIP_MS, before.pano ? PANO_MIN_MS : 0)) continue;
    let next: Clip;
    if (before.kind === "IMAGE") next = { ...before, sourceEndMs: before.sourceStartMs + length };
    else {
      const source = durations[before.assetId] ?? before.sourceEndMs;
      const sourceLength = Math.round(length * before.speed);
      if (sourceLength > source) continue;
      // Grow at the end, sliding the window earlier only when the source runs out.
      const start = Math.max(0, Math.min(before.sourceStartMs, source - sourceLength));
      next = { ...before, sourceStartMs: start, sourceEndMs: start + sourceLength };
    }
    clips = clips.map((clip, at) => (at === i - 1 ? next : clip));
  }
  return clips === timeline.clips ? timeline : { ...timeline, clips };
}
