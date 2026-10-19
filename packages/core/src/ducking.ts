import { clipStartsMs, type Timeline } from "./timeline";
import { hasSpeech, sourceToReelMs, transcriptWindow, type Transcript } from "./transcript";

/**
 * Music under speech. The villa reel's score had its dips baked in by hand,
 * so when the lines moved the dips stayed behind. Here the dips come from
 * the transcripts of the clips that play with sound, at render time, so
 * they follow every edit.
 */

export type SpeechWindow = { startMs: number; endMs: number };

/**
 * Reel-time spans where a clip's own speech is heard: its transcript words
 * inside the played window, at the clip's speed, muted clips left out.
 * Nearby words are merged and each span is padded so the music settles
 * before the first word and lifts after the last.
 */
export function speechWindows(
  timeline: Timeline,
  transcripts: Record<string, Transcript | null | undefined>,
  { padMs = 150, mergeGapMs = 500 }: { padMs?: number; mergeGapMs?: number } = {},
): SpeechWindow[] {
  const starts = clipStartsMs(timeline);
  const spans: SpeechWindow[] = [];
  timeline.clips.forEach((clip, index) => {
    const transcript = transcripts[clip.assetId];
    if (clip.kind !== "VIDEO" || clip.volume <= 0 || !hasSpeech(transcript)) return;
    for (const word of transcriptWindow(transcript, clip.sourceStartMs, clip.sourceEndMs)) {
      const startMs = Math.max(starts[index], sourceToReelMs(clip, starts[index], word.s));
      const endMs = Math.min(sourceToReelMs(clip, starts[index], clip.sourceEndMs), sourceToReelMs(clip, starts[index], word.e));
      if (endMs > startMs) spans.push({ startMs, endMs });
    }
  });
  spans.sort((a, b) => a.startMs - b.startMs);
  const merged: SpeechWindow[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.startMs - last.endMs <= mergeGapMs) last.endMs = Math.max(last.endMs, span.endMs);
    else merged.push({ ...span });
  }
  return merged.map((span) => ({ startMs: Math.max(0, span.startMs - padMs), endMs: span.endMs + padMs }));
}

/** Music level at `atMs`: 1 clear of speech, `duckTo` under it, eased over `rampMs` either side. */
export function duckGain(windows: SpeechWindow[], atMs: number, { duckTo = 0.3, rampMs = 250 }: { duckTo?: number; rampMs?: number } = {}): number {
  let gain = 1;
  for (const { startMs, endMs } of windows) {
    let level = 1;
    if (atMs >= startMs && atMs <= endMs) level = duckTo;
    else if (atMs > startMs - rampMs && atMs < startMs) level = 1 - (1 - duckTo) * ((atMs - (startMs - rampMs)) / rampMs);
    else if (atMs > endMs && atMs < endMs + rampMs) level = duckTo + (1 - duckTo) * ((atMs - endMs) / rampMs);
    gain = Math.min(gain, level);
  }
  return gain;
}
