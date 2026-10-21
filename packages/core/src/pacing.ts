/**
 * Editing to the song (ADR 0059): a cut plan that moves with the music, and
 * "On the beat", which puts the things that happen inside a shot (a title's
 * entrance, a particle burst, a whip, the presenter's pass) on the bar.
 *
 * Pure and deterministic: the same reel, song and energy always give the same
 * cut, so moving the Energy control back to where it was gives back the same
 * reel, and the plan is tested without a browser.
 */
import { beatPeriodMs } from "./beats";
import type { MotionSample } from "./motion";
import { BEATS_PER_BAR, sectionAt } from "./song";
import { clipRunEndMs, retimeTexts, textAttachment } from "./text-timing";
import { MIN_CLIP_MS, clipDurationMs, clipStartsMs, timelineDurationMs, type Clip, type Music, type SectionKind, type SongSection, type Timeline } from "./timeline";

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
const PANO_MIN_MS = 3500;

export type PaceShot = { clipId: string; startMs: number; endMs: number; beats: number; section: SectionKind | "none"; hero: boolean };
export type PacePlan = { clips: Clip[]; shots: PaceShot[]; heroClipId: string | null };

export type PaceOptions = {
  /** 0 (chill) to 1 (hype). */
  energy: number;
  /** Measured energy of each clip by clip id (`clipEnergyFromMotion`); clips left out use `fallbackClipEnergy`. */
  clipEnergy?: Record<string, number>;
  sourceDurationsMs?: Record<string, number | null | undefined>;
};

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
 * faster cuts through the build, the hero shot (the clip that moves most)
 * held on the drop, and the outro slowing down again. Cuts land on a grid of
 * the shot's length laid from the bar lines (a four-beat shot cuts on a
 * downbeat) and on every section start, so the drop is a cut. A video is
 * never played past its source (it keeps the middle of what it showed); when
 * not even one beat fits, it cuts off the beat and the next cut goes back on
 * it. Null when the song has no tempo or there is nothing to cut.
 */
export function planPace(timeline: Timeline, options: PaceOptions): PacePlan | null {
  const music = timeline.music;
  const grid = reelGrid(music);
  if (!grid || timeline.clips.length === 0) return null;
  const energy = Math.min(1, Math.max(0, options.energy));
  const durations = options.sourceDurationsMs ?? {};
  const P = grid.periodMs;
  const minBeats = Math.max(1, Math.ceil(MIN_CLIP_MS / P - 1e-9));
  const sections = reelSections(music);
  const energyOf = (clip: Clip) => options.clipEnergy?.[clip.id] ?? fallbackClipEnergy(clip);
  const speedOf = (clip: Clip) => (clip.kind === "IMAGE" ? 1 : clip.speed);
  const longest = (clip: Clip) => {
    if (clip.kind !== "VIDEO") return Infinity;
    const source = durations[clip.assetId] ?? clip.sourceEndMs;
    return Math.floor(source / speedOf(clip));
  };

  // The hero: the clip that moves most, when the clips differ at all and there is a drop to put it on.
  const drop = sections.find((section) => section.kind === "drop");
  const energies = timeline.clips.map(energyOf);
  const spread = Math.max(...energies) - Math.min(...energies);
  let heroClip: Clip | null = null;
  if (drop && timeline.clips.length > 1 && spread >= 0.05) {
    const heroMin = HERO_BEATS[1] * P * 0.5;
    let best = -1;
    for (const [index, clip] of timeline.clips.entries()) {
      if (longest(clip) < heroMin || energies[index] <= best) continue;
      best = energies[index];
      heroClip = clip;
    }
  }
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
    const beats = isHero ? shotBeats(HERO_BEATS, energy, 0.5, minBeats) : shotBeats(SHOT_BEATS[kind], energy, energyOf(clip), minBeats);
    const minimum = Math.max(MIN_CLIP_MS, clip.pano ? PANO_MIN_MS : 0);
    const step = Math.min(beats, BEATS_PER_BAR);
    let end = gridAtOrAfter(grid, Math.max(t + beats * P - (step * P) / 2, t + minimum), step);
    // Every section start is a cut, so the drop lands on one.
    const boundary = sections.find((section) => section.startMs > t + minimum && section.startMs < end - 1);
    if (boundary) end = boundary.startMs;
    // A video plays no further than its source: the longest whole number of beats that fits, else what fits.
    const most = longest(clip);
    if (end - t > most) {
      const fit = gridAtOrBefore(grid, t + most, 1);
      end = fit - t >= minimum ? fit : t + most;
    }
    const length = Math.max(1, Math.round(end) - t);
    const next = withLength(clip, length, durations);
    const actual = clipDurationMs(next);
    clips.push(next);
    shots.push({ clipId: clip.id, startMs: t, endMs: t + actual, beats, section: kind, hero: isHero });
    t += actual;
  }
  return { clips, shots, heroClipId: heroClip?.id ?? null };
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

/**
 * The reel cut to the song at `energy`, titles following their clips by the
 * attachment rule (ADR 0048), and, when "On the beat" is on, entrances,
 * bursts, whips and the pass on the bar. The reel as it was when the song has
 * no tempo.
 */
export function paceTimeline(timeline: Timeline, options: PaceOptions): Timeline {
  const plan = planPace(timeline, options);
  if (!plan) return timeline;
  const cut = retimeTexts(timeline, { ...timeline, clips: plan.clips });
  return timeline.music?.onBeat ? putOnTheBeat(cut, options.sourceDurationsMs) : cut;
}

// ── On the beat ─────────────────────────────────────────────────

/** Shortest a title is left after its entrance moves onto the bar. */
const MIN_TEXT_MS = 300;

/**
 * "On the beat": each of these goes to the nearest downbeat, never so far
 * that it changes what it belongs to:
 * - a whip's cut (the clip before it lengthens or shortens, within its
 *   source; titles follow by the attachment rule);
 * - a title's entrance (`startMs`; the title keeps its length), staying over
 *   the clip it is attached to, and for a pinned title inside the frames its
 *   path was tracked on;
 * - a particle burst (`particles.burstMs`), inside the title's life;
 * - the presenter's pass (`passMs`), inside the title's life and only when
 *   a downbeat is within one beat: the pass is where she really crosses the
 *   words, so it may move by at most a beat.
 * Nothing that is not set is added. The reel as it was without a tempo.
 */
export function putOnTheBeat(timeline: Timeline, sourceDurationsMs: Record<string, number | null | undefined> = {}): Timeline {
  const grid = reelGrid(timeline.music);
  if (!grid || timeline.clips.length === 0) return timeline;
  const afterWhips = whipsOnTheBeat(timeline, grid, sourceDurationsMs);
  const current = afterWhips === timeline ? timeline : retimeTexts(timeline, afterWhips);
  const total = timelineDurationMs(current);
  const starts = clipStartsMs(current);
  const nearestWithin = (ms: number, from: number, to: number, tolerance = Infinity) => {
    const candidates = downbeatsBetween(grid, from, to);
    if (candidates.length === 0) return null;
    const best = candidates.reduce((a, b) => (Math.abs(b - ms) < Math.abs(a - ms) ? b : a));
    return Math.abs(best - ms) <= tolerance ? best : null;
  };
  const texts = current.texts.map((text) => {
    if (text.id.startsWith("room-")) return text;
    let next = text;
    const attachment = textAttachment(current, text);
    const index = attachment.kind === "clip" ? current.clips.findIndex((clip) => clip.id === attachment.clipId) : -1;
    // Where the entrance may go: over its own clip when attached, the pinned frames when pinned, else the reel.
    let from = index >= 0 ? starts[index] : 0;
    let to = index >= 0 ? clipRunEndMs(current, index, starts) : total;
    if (text.pin && index >= 0) {
      const clip = current.clips[index];
      const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
      from = Math.max(from, starts[index] + (text.pin.fromMs - clip.sourceStartMs) / speed);
      to = Math.min(to, starts[index] + (text.pin.toMs - clip.sourceStartMs) / speed);
    }
    const length = text.endMs - text.startMs;
    const entrance = nearestWithin(text.startMs, from, Math.min(to, total) - MIN_TEXT_MS);
    if (entrance !== null && entrance !== text.startMs) {
      const endMs = Math.min(entrance + length, to, total);
      if (endMs - entrance >= Math.min(length, MIN_TEXT_MS)) next = { ...next, startMs: entrance, endMs: Math.round(endMs) };
    }
    if (next.particles?.burstMs !== undefined) {
      const burst = nearestWithin(next.particles.burstMs, next.startMs, next.endMs);
      if (burst !== null && burst !== next.particles.burstMs) next = { ...next, particles: { ...next.particles, burstMs: burst } };
    }
    if (next.passMs !== undefined) {
      const pass = nearestWithin(next.passMs, next.startMs, next.endMs, grid.periodMs);
      if (pass !== null && pass !== next.passMs) next = { ...next, passMs: pass };
    }
    return next;
  });
  const changed = texts.some((text, i) => text !== current.texts[i]);
  return changed ? { ...current, texts } : current;
}

/** Each whip's cut moved to the nearest downbeat by lengthening or shortening the clip before it, where its source and the shortest clip allow. */
function whipsOnTheBeat(timeline: Timeline, grid: ReelGrid, durations: Record<string, number | null | undefined>): Timeline {
  let clips = timeline.clips;
  for (let i = 1; i < clips.length; i++) {
    if (clips[i].transitionIn !== "whip") continue;
    const cut = clipStartsMs({ ...timeline, clips })[i];
    const target = nearestDownbeatMs(grid, cut);
    const before = clips[i - 1];
    const length = clipDurationMs(before) + (target - cut);
    if (target === cut || length < MIN_CLIP_MS) continue;
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
