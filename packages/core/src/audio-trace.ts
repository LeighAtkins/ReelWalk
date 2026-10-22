import { z } from "zod";
import { reelBeats, type AudioAnalysis } from "./audio-analysis";
import { speechWindows, type SpeechWindow } from "./ducking";
import { recommendSoundVolume, type SoundVolumeAdvice } from "./mix";
import { reelDropMs, sfxEndMs } from "./sfx";
import { clipStartsMs, isInstagramMusic, timelineDurationMs, type Timeline } from "./timeline";
import type { Transcript } from "./transcript";

/**
 * What an agent (and the critic, W3-F) reads instead of listening (ADR
 * 0066): the reel's beats, cuts, speech and sounds in reel time, the
 * export's loudness every 250 ms when it has been rendered, and the
 * problems a sound editor would flag. Pure; the route feeds it the reel,
 * the track's analysis, the transcripts and the export's sidecar.
 */

export const AUDIO_TRACE_VERSION = 1;
export const TRACE_STEP_MS = 250;
/** A cut further than this from a beat is off it. */
export const OFF_BEAT_MS = 60;
/** Quiet this long, where sound was expected, is a hole. */
export const SILENCE_MS = 1500;
const SILENCE_LUFS = -50;

export type AudioProblemKind = "cut-off-beat" | "speech-under-music" | "silence" | "drop-mid-shot";

export type AudioProblem = {
  kind: AudioProblemKind;
  severity: "high" | "medium" | "low";
  atMs: number;
  endMs?: number;
  clipId?: string;
  /** One plain line. */
  detail: string;
};

export type ExportLoudness = {
  stepMs: number;
  /** Momentary loudness per step, LUFS. */
  lufs: number[];
  integratedLufs: number | null;
  truePeakDb: number | null;
};

export type AudioTrace = {
  version: typeof AUDIO_TRACE_VERSION;
  durationMs: number;
  music: { kind: "instagram" | "own" | "none"; bpm: number | null; sourceStartMs: number; analysed: boolean };
  /** Reel ms. */
  beats: number[];
  downbeats: number[];
  /** The song's drop in reel time, when analysed and inside the reel. */
  dropMs: number | null;
  cuts: { atMs: number; clipId: string; transition: string; offBeatMs: number | null }[];
  speech: SpeechWindow[];
  sfx: { id: string; sound: string; atMs: number; endMs: number; reason: string | null }[];
  loudness: ExportLoudness | null;
  recommended: SoundVolumeAdvice;
  problems: AudioProblem[];
};

/** Distance (ms) from `atMs` to the nearest of `beats`, or null without beats. */
export function beatDistanceMs(beats: readonly number[], atMs: number): number | null {
  if (beats.length === 0) return null;
  let best = Infinity;
  for (const beat of beats) best = Math.min(best, Math.abs(beat - atMs));
  return Math.round(best);
}

export function audioTrace(input: {
  timeline: Timeline;
  analysis: AudioAnalysis | null;
  transcripts: Record<string, Transcript | null | undefined>;
  loudness?: ExportLoudness | null;
}): AudioTrace {
  const { timeline, analysis } = input;
  const durationMs = timelineDurationMs(timeline);
  const music = timeline.music;
  const sourceStartMs = music?.sourceStartMs ?? 0;
  const bpm = analysis?.bpm ?? music?.bpm ?? null;
  // Measured beats when the track was analysed; the reel's stored grid otherwise (the same comb, from the editor's analysis).
  const grid = analysis ?? (music?.bpm ? { bpm: music.bpm, beatOffsetMs: music.beatOffsetMs ?? 0, beats: [] } : null);
  const beats = grid ? reelBeats(grid, sourceStartMs, durationMs) : [];
  const downbeatsSong = analysis?.downbeats ?? music?.downbeats ?? [];
  const downbeats = downbeatsSong.map((at) => at - sourceStartMs).filter((at) => at >= 0 && at <= durationMs);
  const dropMs = reelDropMs(analysis?.drop?.atMs ?? music?.drop?.songMs ?? null, music, durationMs);
  const starts = clipStartsMs(timeline);
  const cuts = timeline.clips.slice(1).map((clip, index) => ({ atMs: starts[index + 1], clipId: clip.id, transition: clip.transitionIn, offBeatMs: beatDistanceMs(beats, starts[index + 1]) }));
  const speech = speechWindows(timeline, input.transcripts);
  const sfx = (timeline.sfx ?? []).map((clip) => ({ id: clip.id, sound: clip.sound, atMs: clip.atMs, endMs: sfxEndMs(clip), reason: clip.reason ?? null }));
  const loudness = input.loudness ?? null;
  const hasOwnSound = timeline.clips.some((clip) => clip.kind === "VIDEO" && clip.volume > 0) || Boolean(timeline.sfx?.length) || Boolean(music && !isInstagramMusic(music));
  const recommended = recommendSoundVolume({ integratedLufs: loudness?.integratedLufs ?? null, hasSpeech: speech.length > 0, hasOwnSound });

  const problems: AudioProblem[] = [];
  for (const cut of cuts) {
    if (cut.offBeatMs !== null && cut.offBeatMs > OFF_BEAT_MS) {
      problems.push({ kind: "cut-off-beat", severity: "medium", atMs: cut.atMs, clipId: cut.clipId, detail: `The cut into ${cut.clipId} at ${sec(cut.atMs)} is ${cut.offBeatMs} ms off the beat.` });
    }
  }
  if (music && !isInstagramMusic(music) && music.volume * 0.3 > 0.25) {
    for (const window of speech) {
      problems.push({ kind: "speech-under-music", severity: "medium", atMs: window.startMs, endMs: window.endMs, detail: `Speech at ${sec(window.startMs)}–${sec(window.endMs)} has the music at ${Math.round(music.volume * 100)}%: ducked to 30% it still sits at ${Math.round(music.volume * 30)}%. Lower the music.` });
    }
  }
  if (dropMs !== null && !cuts.some((cut) => Math.abs(cut.atMs - dropMs) <= 120)) {
    problems.push({ kind: "drop-mid-shot", severity: "low", atMs: dropMs, detail: `The song's drop at ${sec(dropMs)} falls mid-shot; put a cut on it (dropOnCut).` });
  }
  if (loudness && loudness.integratedLufs !== null && loudness.integratedLufs > SILENCE_LUFS && !(music && isInstagramMusic(music))) {
    let from: number | null = null;
    const flush = (toMs: number) => {
      if (from !== null && toMs - from >= SILENCE_MS) problems.push({ kind: "silence", severity: "low", atMs: from, endMs: toMs, detail: `Silence from ${sec(from)} to ${sec(toMs)} (${((toMs - from) / 1000).toFixed(1)} s) with nothing under it.` });
      from = null;
    };
    loudness.lufs.forEach((value, i) => {
      const at = i * loudness.stepMs;
      if (value < SILENCE_LUFS) from ??= at;
      else flush(at);
    });
    flush(Math.min(durationMs, loudness.lufs.length * loudness.stepMs));
  }
  problems.sort((a, b) => a.atMs - b.atMs);

  return {
    version: AUDIO_TRACE_VERSION,
    durationMs,
    music: { kind: !music ? "none" : isInstagramMusic(music) ? "instagram" : "own", bpm, sourceStartMs, analysed: analysis !== null },
    beats,
    downbeats,
    dropMs,
    cuts,
    speech,
    sfx,
    loudness,
    recommended,
    problems,
  };
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Where an export's measured audio (ExportLoudness, as JSON) sits in storage: beside the MP4. */
export const exportAudioKeyFor = (objectKey: string): string => `${objectKey}.audio.json`;

export const exportLoudnessSchema = z.object({
  stepMs: z.number().int().positive(),
  lufs: z.array(z.number()).max(20_000),
  integratedLufs: z.number().nullable(),
  truePeakDb: z.number().nullable(),
});

/** Reads a stored sidecar; null when it is missing or malformed. */
export function parseExportLoudness(value: unknown): ExportLoudness | null {
  const parsed = exportLoudnessSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
