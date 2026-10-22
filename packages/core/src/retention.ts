/**
 * The retention critic (ADR 0071): what decides whether a reel is watched
 * to the end, measured from the timeline and the frames rather than from a
 * style checklist. Each finding names the moment, carries a fix that is a
 * document command (ADR 0048) and an impact tag: `hook` (the first three
 * seconds), `hold` (the middle), `finish` (the ending and the loop).
 *
 *   dead air        over 1.2 s with no cut, no motion, no speech and no title change
 *   reading time    a title held shorter than words × 250 ms + 400 ms, or far longer
 *   cut rate        shots in a section of the song twice as long (or short) as the pacing engine wants
 *   beat            cuts off the beat; the snap offered moves them to frame-exact times, never within 60 ms of another cut
 *   presenter       a presenter on screen over 6 s with no cutaway and no title arriving
 *   opening         frame 0 empty, or the opening title not readable by 300 ms
 *   stock           a stock video played as it came: no move, zoom, grade, speed or title
 *
 * Pure. Frames come as a FrameSeries (render-checks.ts): dense from the
 * worker's decode of the export, sparse from the editor's sampled frames
 * (`seriesFromSamples`). A window with no frames is not judged.
 */
import { nearestBeatMs } from "./beats";
import type { Command } from "./commands";
import { CRITIC, criticSamples, momentAt, type CriticFinding, type CriticFix, type CriticFrame } from "./critic";
import { heldByPace, reelGrid, reelSections } from "./pacing";
import { isGeneratedAssetId } from "./presenter";
import { analyseSeries, frameStats, isEmptyFrame, isNearBlack, motionEnergyProfile, titleEntranceMs, RENDER_CHECKS, type FrameSeries, type HookFacts } from "./render-checks";
import { clipDurationMs, clipStartsMs, MIN_CLIP_MS, REEL_FORMAT, SPEEDS, timelineDurationMs, type Clip, type SectionKind, type TextOverlay, type Timeline } from "./timeline";
import { sourceToReelMs, transcriptWindow, type Transcript } from "./transcript";

export const RETENTION = {
  /** Longer than this with nothing happening is dead air. */
  deadAirMs: 1200,
  /** Motion energy (mean luma difference over a 500 ms span) at or under which the picture is still (CRITIC.motion). */
  motion: 0.02,
  /** Reading time: this per word plus the base. */
  readMsPerWord: 250,
  readBaseMs: 400,
  /** A title held this many times its reading time, plus the slack, is held too long. */
  holdFactor: 3,
  holdSlackMs: 2000,
  /** A presenter on screen longer than this with no cutaway. */
  presenterHoldMs: 6000,
  /** A cut further than this from the beat is off it (CRITIC.beatToleranceMs: a frame and a half). */
  beatToleranceMs: 50,
  /** A snapped cut never lands within this of another cut. */
  snapGapMs: 60,
  /** Shots this many times longer or shorter than the song's section wants. */
  cutRateFactor: 2,
  /** A stock clip with a transform score (W3-E) under this is untouched. */
  stockUntouched: 0.2,
  /** A stock clip shorter than this is a flash and needs no move. */
  stockMinMs: 1500,
} as const;

const FRAME_MS = 1000 / REEL_FORMAT.fps;

export type RetentionInput = {
  timeline: Timeline;
  /** Frames of the reel in time order; dense (the render) or sparse (the editor's samples). */
  series?: FrameSeries | null;
  /** What each video says, by asset id (the library's transcripts). */
  transcripts?: Record<string, Transcript | null | undefined>;
  /** Assets that are presenter takes (voiced or not); AI assets (`ai-…`) count without being listed. */
  presenterAssetIds?: readonly string[];
  /** How much each stock clip was changed from the file, 0..1 by asset id (W3-E's transformScore), when measured. */
  transformScores?: Record<string, number>;
  /** The hook planner's opening facts (W3-C), when it has them; they replace the frame-0 reading here. */
  hook?: HookFacts | null;
  sourceDurationsMs?: Record<string, number | null | undefined>;
};

export type Impact = "hook" | "hold" | "finish";

// ── Series from the editor's samples ───────────────────────────

/**
 * A series from frames the critic sampled: one frame every `stepMs` of reel
 * time where a frame for that moment was read. Two moments on the same
 * still photo share a frame and so read as no motion, which is right.
 */
export function seriesFromSamples(timeline: Timeline, frames: ReadonlyMap<string, CriticFrame>, stepMs: number = CRITIC.stepMs): FrameSeries {
  const total = timelineDurationMs(timeline);
  const times = new Set<number>();
  for (let t = 0; t < total; t += stepMs) times.add(t);
  // The sampled moments themselves (each clip's last frame, the loop ends, the titles), so a still stretch reaches its cut.
  for (const sample of criticSamples(timeline)) times.add(sample.reelMs);
  times.add(Math.max(0, total - FRAME_MS));
  const out: FrameSeries = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const moment = momentAt(timeline, t);
    const frame = moment ? frames.get(moment.key) : undefined;
    if (frame) out.push({ ms: Math.round(moment!.reelMs), frame });
  }
  return out.filter((f, i) => i === 0 || f.ms > out[i - 1].ms);
}

// ── Helpers ─────────────────────────────────────────────────────

export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
/** How long it takes to read a title: words × 250 ms + 400 ms. */
export const readingTimeMs = (text: string) => wordCount(text) * RETENTION.readMsPerWord + RETENTION.readBaseMs;

/** Reel time rounded to the frame grid (30 fps), in whole ms: 33, 67, 100, … */
export const frameExactMs = (ms: number) => Math.round(Math.round(ms / FRAME_MS) * FRAME_MS);
/** Whether a reel time sits on a frame boundary (within a millisecond). */
export const isFrameExact = (ms: number) => Math.abs(ms - Math.round(ms / FRAME_MS) * FRAME_MS) <= 1;

const isPresenter = (clip: Clip, ids?: readonly string[]) => isGeneratedAssetId(clip.assetId) || Boolean(ids?.includes(clip.assetId));

/** Reel windows in which someone is heard: words of a video's transcript playing with its sound on, and voiced presenter takes. */
export function speechWindowsOf(timeline: Timeline, transcripts: RetentionInput["transcripts"], presenterAssetIds?: readonly string[]): [number, number][] {
  const starts = clipStartsMs(timeline);
  const out: [number, number][] = [];
  timeline.clips.forEach((clip, index) => {
    if (clip.kind !== "VIDEO" || clip.volume <= 0) return;
    const transcript = transcripts?.[clip.assetId];
    if (transcript?.words.length) {
      for (const word of transcriptWindow(transcript, clip.sourceStartMs, clip.sourceEndMs)) {
        out.push([sourceToReelMs(clip, starts[index], Math.max(word.s, clip.sourceStartMs)), sourceToReelMs(clip, starts[index], Math.min(word.e, clip.sourceEndMs))]);
      }
    } else if (transcripts && !(clip.assetId in transcripts) && presenterAssetIds?.includes(clip.assetId)) {
      // A voiced take whose words are not known: she talks all through it.
      out.push([starts[index], starts[index] + clipDurationMs(clip)]);
    }
  });
  return out.sort((a, b) => a[0] - b[0]);
}

const impactOf = (atMs: number, total: number): Impact => (atMs < 3000 ? "hook" : atMs > total - 3000 ? "finish" : "hold");

// ── Dead air ────────────────────────────────────────────────────

/** Windows in which the picture does not move: from the series, plus whole photo clips without a camera move. */
export function stillWindows(timeline: Timeline, series: FrameSeries | null | undefined): [number, number][] {
  const starts = clipStartsMs(timeline);
  const out: [number, number][] = [];
  timeline.clips.forEach((clip, index) => {
    if (clip.kind === "IMAGE" && clip.motion === "none" && !clip.pano) out.push([starts[index], starts[index] + clipDurationMs(clip)]);
  });
  if (series?.length) {
    for (const point of motionEnergyProfile(series, RENDER_CHECKS.motionSpanMs, starts.slice(1))) {
      if (point.energy <= RETENTION.motion) out.push([point.ms, point.toMs]);
    }
  }
  return merge(out);
}

function merge(windows: [number, number][]): [number, number][] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

/** `windows` with `cuts` splitting them and `alive` windows taken out. */
function subtract(windows: [number, number][], cuts: number[], alive: [number, number][]): [number, number][] {
  let pieces = windows.flatMap(([a, b]) => {
    const inside = cuts.filter((c) => c > a && c < b).sort((p, q) => p - q);
    const out: [number, number][] = [];
    let from = a;
    for (const c of inside) { out.push([from, c]); from = c; }
    out.push([from, b]);
    return out;
  });
  for (const [a, b] of alive) {
    pieces = pieces.flatMap(([p, q]) => {
      if (b <= p || a >= q) return [[p, q]];
      const out: [number, number][] = [];
      if (a > p) out.push([p, a]);
      if (b < q) out.push([b, q]);
      return out;
    });
  }
  return pieces;
}

function deadAirFindings(input: RetentionInput, total: number): CriticFinding[] {
  const { timeline } = input;
  const starts = clipStartsMs(timeline);
  const cuts = starts.slice(1);
  const events = timeline.texts.flatMap((text) => [text.startMs, text.endMs]);
  const alive = speechWindowsOf(timeline, input.transcripts, input.presenterAssetIds);
  const still = subtract(stillWindows(timeline, input.series), [...cuts, ...events], alive).filter(([a, b]) => b - a > RETENTION.deadAirMs);
  return still.map(([from, to]) => {
    const moment = momentAt(timeline, from + Math.min((to - from) / 2, 1000));
    const index = moment ? timeline.clips.findIndex((clip) => clip.id === moment.clipId) : -1;
    const clip = index >= 0 ? timeline.clips[index] : null;
    const fixes: CriticFix[] = [];
    if (clip) {
      const s = starts[index], d = clipDurationMs(clip);
      const stillMs = to - from, excess = stillMs - CRITIC.stillTargetMs;
      const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
      const atEnd = to >= s + d - FRAME_MS, atStart = from <= s + 1;
      const cut = Math.round(Math.min(excess, d - MIN_CLIP_MS) * speed);
      if ((atEnd || atStart) && cut > 0) {
        const window = atEnd || clip.kind === "IMAGE"
          ? { sourceStartMs: clip.sourceStartMs, sourceEndMs: clip.sourceEndMs - cut }
          : { sourceStartMs: clip.sourceStartMs + cut, sourceEndMs: clip.sourceEndMs };
        fixes.push({ kind: "command", label: `Trim ${(cut / speed / 1000).toFixed(1)} s`, command: { type: "trimClip", clipId: clip.id, window }, safe: false });
      }
      if (clip.kind === "VIDEO") {
        const faster = SPEEDS.find((candidate) => candidate > clip.speed && (stillMs * clip.speed) / candidate <= RETENTION.deadAirMs);
        if (faster) fixes.push({ kind: "command", label: `Play it at ${faster}×`, command: { type: "setSpeed", clipId: clip.id, speed: faster }, safe: false });
      }
      if (clip.motion === "none" && !clip.pano) {
        fixes.push({ kind: "command", label: "Slow push in", command: { type: "updateClip", clipId: clip.id, patch: { motion: "zoom-in" } }, safe: false });
      }
    }
    return {
      id: `dead-air:${clip?.id ?? "reel"}:${Math.round(from)}`, check: "dead-air" as const, severity: "medium" as const, impact: impactOf(from, total),
      reason: `${clip ? `Shot ${index + 1}` : "The reel"} holds still for ${((to - from) / 1000).toFixed(1)} s with no cut, motion, speech or title.`,
      atMs: moment?.reelMs ?? from, clipId: clip?.id ?? null, sourceMs: moment?.sourceMs ?? null, fixes,
    };
  });
}

// ── Reading time ────────────────────────────────────────────────

function readingFindings(input: RetentionInput, total: number): CriticFinding[] {
  const { timeline } = input;
  const out: CriticFinding[] = [];
  for (const text of timeline.texts) {
    if (text.id.startsWith("room-")) continue;
    const need = readingTimeMs(text.text), shown = text.endMs - text.startMs;
    const moment = momentAt(timeline, (text.startMs + text.endMs) / 2);
    const base = { atMs: moment?.reelMs ?? text.startMs, clipId: moment?.clipId ?? null, sourceMs: moment?.sourceMs ?? null, textId: text.id, impact: impactOf(text.startMs, total) };
    if (need - shown > 100) {
      const endMs = Math.min(total, text.startMs + need);
      const fixes: CriticFix[] = endMs > text.endMs ? [{ kind: "command", label: `Hold it ${((endMs - text.endMs) / 1000).toFixed(1)} s longer`, command: { type: "updateText", textId: text.id, patch: { endMs } }, safe: true }] : [];
      out.push({ ...base, id: `reading-short:${text.id}`, check: "reading", severity: "medium",
        reason: `${quote(text)} is on screen ${(shown / 1000).toFixed(1)} s; ${wordCount(text.text)} word${wordCount(text.text) === 1 ? "" : "s"} take about ${(need / 1000).toFixed(1)} s to read.`, fixes });
    } else if (shown > need * RETENTION.holdFactor + RETENTION.holdSlackMs && !text.pin && !text.path && !text.callout && text.kinetic?.preset !== "count") {
      const endMs = text.startMs + need * 2;
      out.push({ ...base, id: `reading-long:${text.id}`, check: "reading", severity: "low",
        reason: `${quote(text)} stays ${(shown / 1000).toFixed(1)} s, well past the ${(need / 1000).toFixed(1)} s it takes to read; nothing new arrives meanwhile.`,
        fixes: [{ kind: "command", label: `End it at ${(endMs / 1000).toFixed(1)} s`, command: { type: "updateText", textId: text.id, patch: { endMs } }, safe: false }] });
    }
  }
  return out;
}

const quote = (text: TextOverlay) => `“${text.text.length > 24 ? `${text.text.slice(0, 23)}…` : text.text}”`;

// ── Cut rate against the song ───────────────────────────────────

/** Beats a shot holds in each part of the song at chill and hype (the pacing engine's bands, ADR 0059). */
const SHOT_BEATS: Record<SectionKind | "none", [number, number]> = { intro: [8, 4], build: [4, 2], drop: [4, 1], outro: [8, 4], none: [4, 2] };

/** The shot length (beats) the pacing engine wants in a section at this energy, for a middling clip. */
export function wantedShotBeats(kind: SectionKind | "none", energy: number): number {
  const [chill, hype] = SHOT_BEATS[kind].map(Math.log2);
  return 2 ** Math.min(3, Math.max(0, Math.round(chill + (hype - chill) * energy)));
}

function cutRateFinding(input: RetentionInput, total: number): CriticFinding | null {
  const { timeline } = input;
  const music = timeline.music;
  const grid = reelGrid(music);
  const sections = reelSections(music);
  if (!grid || !sections.length || timeline.clips.length < 3) return null;
  const starts = clipStartsMs(timeline);
  const energy = music?.energy ?? 0.5;
  // Held as the pacing engine holds them (ADR 0059): AI takes, and videos heard speaking (every sounded video when the words are not known).
  const speechAssetIds = speechAssetIdsOf(input);
  let worst: { kind: SectionKind; median: number; wanted: number; atMs: number; ratio: number } | null = null;
  for (const section of sections) {
    const shots = timeline.clips.flatMap((clip, index) => {
      const held = heldByPace(clip, speechAssetIds) || isPresenter(clip, input.presenterAssetIds);
      const inSection = starts[index] >= section.startMs && starts[index] < section.endMs && starts[index] < total;
      return inSection && !held ? [clipDurationMs(clip) / grid.periodMs] : [];
    });
    if (shots.length < 2) continue;
    const sorted = [...shots].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const wanted = wantedShotBeats(section.kind, energy);
    const ratio = median / wanted;
    if (ratio >= RETENTION.cutRateFactor || ratio <= 1 / RETENTION.cutRateFactor) {
      const strength = Math.max(ratio, 1 / ratio);
      if (!worst || strength > Math.max(worst.ratio, 1 / worst.ratio)) worst = { kind: section.kind, median, wanted, atMs: section.startMs, ratio };
    }
  }
  if (!worst) return null;
  const moment = momentAt(timeline, worst.atMs);
  const slow = worst.ratio > 1;
  return {
    id: `cut-rate:${worst.kind}`, check: "cut-rate", severity: slow && worst.kind === "drop" ? "medium" : "low", impact: impactOf(worst.atMs, total),
    reason: `Shots in the ${worst.kind} run about ${Math.round(worst.median * 10) / 10} beats each; the song wants about ${worst.wanted} there, so the cut ${slow ? "drags behind" : "races ahead of"} the music.`,
    atMs: moment?.reelMs ?? worst.atMs, clipId: moment?.clipId ?? null, sourceMs: moment?.sourceMs ?? null,
    fixes: [{ kind: "command", label: "Cut to the song", command: { type: "pace", energy, ...(speechAssetIds ? { speechAssetIds } : {}) }, safe: false }],
  };
}

/** Assets whose clips carry speech, for the pacing engine: known only when transcripts were handed in. */
function speechAssetIdsOf(input: RetentionInput): string[] | undefined {
  if (!input.transcripts) return undefined;
  const spoken = Object.entries(input.transcripts).filter(([, transcript]) => Boolean(transcript?.words.length)).map(([id]) => id);
  return [...new Set([...spoken, ...(input.presenterAssetIds ?? [])])];
}

// ── Beat: frame-exact snap ──────────────────────────────────────

/**
 * Trims that put every off-beat cut on the nearest beat at a frame-exact
 * time (30 fps grid, whole ms), one clip at a time in order so later cuts
 * carry the shift. A cut is left alone when its beat is within 60 ms of
 * another cut, the clip before it would fall under the minimum, or a video
 * would run past its source. Empty when nothing can be moved.
 */
export function frameExactSnap(timeline: Timeline, sourceDurationsMs: Record<string, number | null | undefined> = {}): Extract<Command, { type: "trimClip" }>[] {
  const music = timeline.music;
  if (!music?.bpm || timeline.clips.length < 2) return [];
  const grid = { bpm: music.bpm, offsetMs: music.beatOffsetMs ?? 0 };
  const starts = clipStartsMs(timeline);
  const cuts = starts.slice(1);
  const commands: Extract<Command, { type: "trimClip" }>[] = [];
  /** Where each earlier cut now is, after the trims so far. */
  const placed: number[] = [];
  let shift = 0;
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i] + shift;
    const target = frameExactMs(nearestBeatMs(cut, grid, music.sourceStartMs));
    if (Math.abs(target - cuts[i]) <= RETENTION.beatToleranceMs && isFrameExact(cuts[i]) && shift === 0) { placed.push(cut); continue; }
    if (Math.abs(target - cut) <= 1) { placed.push(cut); continue; }
    const others = [...placed, ...cuts.slice(i + 1).map((c) => c + shift)];
    if (others.some((other) => Math.abs(other - target) < RETENTION.snapGapMs)) { placed.push(cut); continue; }
    const clip = timeline.clips[i];
    const start = starts[i] + shift;
    const duration = target - start;
    const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
    const sourceEndMs = clip.sourceStartMs + Math.round(duration * speed);
    const sourceLength = clip.kind === "VIDEO" ? sourceDurationsMs[clip.assetId] : null;
    if (duration < MIN_CLIP_MS || (sourceLength && sourceEndMs > sourceLength)) { placed.push(cut); continue; }
    commands.push({ type: "trimClip", clipId: clip.id, window: { sourceStartMs: clip.sourceStartMs, sourceEndMs } });
    shift += target - cut;
    placed.push(target);
  }
  return commands;
}

function beatFinding(input: RetentionInput): CriticFinding | null {
  const { timeline } = input;
  const music = timeline.music;
  if (!music?.bpm || timeline.clips.length < 2) return null;
  const grid = { bpm: music.bpm, offsetMs: music.beatOffsetMs ?? 0 };
  const cuts = clipStartsMs(timeline).slice(1);
  const off = cuts.filter((cut) => Math.abs(cut - nearestBeatMs(cut, grid, music.sourceStartMs)) > RETENTION.beatToleranceMs);
  if (!off.length) return null;
  const commands = frameExactSnap(timeline, input.sourceDurationsMs);
  const moment = momentAt(timeline, off[0]);
  return {
    id: "beat:cuts", check: "beat", severity: off.length * 2 >= cuts.length ? "medium" : "low", impact: "hold",
    reason: `${off.length} of ${cuts.length} cuts land between beats of the song.`,
    atMs: off[0], clipId: moment?.clipId ?? null, sourceMs: moment?.sourceMs ?? null,
    fixes: commands.length ? [{ kind: "command", label: "Snap to the beat", command: commands.length === 1 ? commands[0] : { type: "batch", commands }, safe: true }] : [],
  };
}

// ── The presenter ───────────────────────────────────────────────

function presenterFindings(input: RetentionInput, total: number): CriticFinding[] {
  const { timeline } = input;
  const starts = clipStartsMs(timeline);
  const out: CriticFinding[] = [];
  timeline.clips.forEach((clip, index) => {
    if (!isPresenter(clip, input.presenterAssetIds)) return;
    const d = clipDurationMs(clip), s = starts[index];
    if (d <= RETENTION.presenterHoldMs) return;
    const arrives = timeline.texts.some((text) => text.startMs > s + 500 && text.startMs < s + d - 500);
    if (arrives) return;
    const moment = momentAt(timeline, s + RETENTION.presenterHoldMs);
    out.push({
      id: `presenter-hold:${clip.id}`, check: "presenter", severity: "medium", impact: impactOf(s + RETENTION.presenterHoldMs, total),
      reason: `The presenter is on screen for ${(d / 1000).toFixed(1)} s in shot ${index + 1} with no cutaway and nothing arriving over her.`,
      atMs: moment?.reelMs ?? s, clipId: clip.id, sourceMs: moment?.sourceMs ?? null,
      fixes: [{ kind: "open", label: "Drop a cutaway in", sheet: "media", clipId: clip.id }],
    });
  });
  return out;
}

// ── The opening ─────────────────────────────────────────────────

function openingFindings(input: RetentionInput): CriticFinding[] {
  const { timeline } = input;
  const out: CriticFinding[] = [];
  const first = input.series?.length ? input.series[0] : null;
  const stats = first && first.ms <= FRAME_MS ? frameStats(first.frame) : null;
  const empty = input.hook?.openingEmpty !== undefined && input.hook.openingEmpty !== null ? input.hook.openingEmpty : stats ? isNearBlack(stats) || isEmptyFrame(stats) : null;
  if (empty) {
    const moment = momentAt(timeline, 0);
    out.push({ id: "opening:empty", check: "hook", severity: "high", impact: "hook", reason: "The first frame is empty: the cover and the first thing a viewer sees show nothing.",
      atMs: 0, clipId: moment?.clipId ?? null, sourceMs: moment?.sourceMs ?? null, fixes: [] });
  }
  const opener = timeline.texts.filter((text) => !text.id.startsWith("room-") && text.startMs <= RENDER_CHECKS.legibleByMs).sort((a, b) => a.startMs - b.startMs)[0];
  const legibleBy = input.hook?.titleLegibleByMs !== undefined ? input.hook.titleLegibleByMs : opener ? opener.startMs + titleEntranceMs(opener) : null;
  if (opener && legibleBy !== null && legibleBy > RENDER_CHECKS.legibleByMs) {
    const moment = momentAt(timeline, RENDER_CHECKS.legibleByMs);
    // A slow entrance is made a pop; a pop that starts too late is started earlier, so it is in by 300 ms.
    const animation = opener.animation === "auto" ? (opener.style === "elegant" ? "fade" : "pop") : opener.animation;
    const earlier = Math.max(0, RENDER_CHECKS.legibleByMs - titleEntranceMs(opener));
    const fixes: CriticFix[] = opener.kinetic
      ? []
      : animation !== "pop" && animation !== "none"
        ? [{ kind: "command", label: "Bring it in at once", command: { type: "updateText", textId: opener.id, patch: { animation: "pop" } }, safe: false }]
        : opener.startMs > earlier
          ? [{ kind: "command", label: `Start it at ${(earlier / 1000).toFixed(2)} s`, command: { type: "updateText", textId: opener.id, patch: { startMs: earlier } }, safe: false }]
          : [];
    out.push({ id: `opening:title:${opener.id}`, check: "hook", severity: "medium", impact: "hook", textId: opener.id,
      reason: `${quote(opener)} is only fully on screen at ${(legibleBy / 1000).toFixed(2)} s; the opening should read by ${RENDER_CHECKS.legibleByMs / 1000} s.`,
      atMs: moment?.reelMs ?? 0, clipId: moment?.clipId ?? null, sourceMs: moment?.sourceMs ?? null, fixes });
  }
  return out;
}

// ── Untouched stock ─────────────────────────────────────────────

/** How much a clip was changed from its file, 0 (as it came) to 1, by the timeline alone; W3-E's measured score replaces it when given. */
export function transformScoreOf(clip: Clip, timeline: Timeline, clipStartMs: number): number {
  let score = 0;
  if (clip.motion !== "none" || clip.pano) score += 0.4;
  if (clip.zoom > 1.02) score += 0.2;
  if (clip.filter !== "none") score += 0.15;
  if (clip.speed !== 1) score += 0.15;
  if (clip.transitionIn !== "cut") score += 0.1;
  const end = clipStartMs + clipDurationMs(clip);
  if (timeline.texts.some((text) => text.startMs < end && text.endMs > clipStartMs)) score += 0.3;
  return Math.min(1, score);
}

function stockFindings(input: RetentionInput, total: number): CriticFinding[] {
  const { timeline } = input;
  const starts = clipStartsMs(timeline);
  const out: CriticFinding[] = [];
  timeline.clips.forEach((clip, index) => {
    if (clip.kind !== "VIDEO" || isPresenter(clip, input.presenterAssetIds) || clipDurationMs(clip) < RETENTION.stockMinMs) return;
    const score = input.transformScores?.[clip.assetId] ?? transformScoreOf(clip, timeline, starts[index]);
    if (score >= RETENTION.stockUntouched) return;
    const moment = momentAt(timeline, starts[index] + Math.min(1000, clipDurationMs(clip) / 2));
    out.push({
      id: `stock:${clip.id}`, check: "stock", severity: "low", impact: impactOf(starts[index], total),
      reason: `Shot ${index + 1} plays exactly as the file came: no move, zoom, grade, speed or title makes it yours.`,
      atMs: moment?.reelMs ?? starts[index], clipId: clip.id, sourceMs: moment?.sourceMs ?? null,
      fixes: [{ kind: "command", label: "Slow push in", command: { type: "updateClip", clipId: clip.id, patch: { motion: "zoom-in" } }, safe: false }],
    });
  });
  return out;
}

// ── All of it ───────────────────────────────────────────────────

/** Every retention finding, unverified: `critique` tries each fix against the timeline before offering it. */
export function retentionFindings(input: RetentionInput): CriticFinding[] {
  const total = timelineDurationMs(input.timeline);
  if (!input.timeline.clips.length) return [];
  return [
    ...openingFindings(input),
    ...deadAirFindings(input, total),
    ...readingFindings(input, total),
    cutRateFinding(input, total),
    beatFinding(input),
    ...presenterFindings(input, total),
    ...stockFindings(input, total),
  ].filter((f): f is CriticFinding => f !== null);
}

/** The motion-per-second facts of a series, for callers that want the numbers without findings. */
export const motionFacts = (series: FrameSeries, timeline?: Timeline | null) => analyseSeries(series, timeline).motionPerSecond;
