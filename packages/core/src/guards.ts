import type { Timeline } from "./timeline";
import { hasSpeech, type Transcript } from "./transcript";

/**
 * Rules the editor keeps after every model edit, whatever the model asked
 * for. They came out of the villa reel (docs/postmortems/2026-10-19): captions
 * drifted under Instagram's buttons, two captions stacked at the same height,
 * and two voiced AI takes gave the presenter two accents. Telling the model
 * was not enough; the timeline enforces them.
 */

/** Instagram's name, caption and buttons cover the top fifth and the bottom quarter. */
export const CAPTION_SAFE = { top: 0.3, bottom: 0.72 } as const;
/** Captions closer than this in y are read as the same line on screen. */
const SAME_LINE = 0.1;
/** A caption shorter than this is not readable; drop it rather than flash it. */
const MIN_CAPTION_MS = 300;

const isCaption = (text: Timeline["texts"][number]) => !text.id.startsWith("room-") && text.style !== "tag";

/** Captions inside the safe band, and no two captions on the same line at the same time. */
export function tidyCaptions(timeline: Timeline): { timeline: Timeline; notes: string[] } {
  const notes: string[] = [];
  let texts = timeline.texts.map((text) => {
    if (!isCaption(text)) return text;
    const y = Math.min(CAPTION_SAFE.bottom, Math.max(CAPTION_SAFE.top, text.y));
    if (y !== text.y) notes.push(`moved "${text.text}" into the safe area`);
    return y === text.y ? text : { ...text, y };
  });
  // Earliest first; an earlier caption gives way to a later one on the same line.
  const order = texts.map((text, index) => ({ text, index })).filter(({ text }) => isCaption(text)).sort((a, b) => a.text.startMs - b.text.startMs);
  const dropped = new Set<number>();
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j];
      if (dropped.has(a.index) || Math.abs(a.text.y - b.text.y) >= SAME_LINE || b.text.startMs >= a.text.endMs) continue;
      if (b.text.startMs - a.text.startMs >= MIN_CAPTION_MS) {
        a.text = { ...a.text, endMs: b.text.startMs };
        notes.push(`"${a.text.text}" now ends when "${b.text.text}" starts`);
      } else {
        dropped.add(a.index);
        notes.push(`removed "${a.text.text}": it showed at the same time and height as "${b.text.text}"`);
      }
    }
  }
  texts = texts.map((text, index) => order.find((entry) => entry.index === index)?.text ?? text).filter((_, index) => !dropped.has(index));
  return { timeline: notes.length ? { ...timeline, texts } : timeline, notes };
}

export type VoiceAsset = { aiGenerated?: boolean; transcript?: Transcript | null } | undefined;

/**
 * One AI presenter voice. Each voiced AI take invents its own voice, so when
 * several play with sound the presenter changes accent mid-reel. The first
 * voiced AI clip keeps its sound; the others are muted (their lines can be
 * captioned from their transcripts). Real footage is never touched.
 */
export function singleAiVoice(timeline: Timeline, assets: Record<string, VoiceAsset>): { timeline: Timeline; notes: string[] } {
  const voiced = timeline.clips
    .map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => clip.kind === "VIDEO" && clip.volume > 0 && assets[clip.assetId]?.aiGenerated && hasSpeech(assets[clip.assetId]?.transcript));
  if (voiced.length < 2) return { timeline, notes: [] };
  const [keep, ...mute] = voiced;
  const muted = new Set(mute.map(({ clip }) => clip.id));
  return {
    timeline: { ...timeline, clips: timeline.clips.map((clip) => (muted.has(clip.id) ? { ...clip, volume: 0 } : clip)) },
    notes: mute.map(({ index }) => `muted clip ${index + 1}: only one AI presenter voice plays (clip ${keep.index + 1})`),
  };
}
