/**
 * Finished reels the landing page plays, from env so real exports can be
 * dropped in without a deploy of code: SAMPLE_REEL_URL holds one or more
 * public video URLs separated by commas, SAMPLE_REEL_POSTER_URL the matching
 * poster images in the same order (optional). Nothing set: the page shows a
 * drawn placeholder frame instead.
 *
 * The samples show off the editing, not the houses (ADR 0085), so each may
 * also carry, in the same order: a label saying what it shows
 * (SAMPLE_REEL_LABELS, "From 9 phone clips"), and an image of the raw clips
 * it was cut from (SAMPLE_REEL_RAW_URLS), which the page offers as "Your
 * clips" beside "Your reel". An empty entry leaves that sample without one.
 */
import { env as serverEnv } from "../env";

export type SampleReel = { src: string; poster: string | null; label: string | null; raw: string | null };

const MAX_SAMPLES = 3;

/** Comma-separated entries, positions kept: an empty entry is a gap, not a shift. */
function entries(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim());
}

const url = (value: string | undefined) => (value && /^https?:\/\//.test(value) ? value : null);

/** A short plain label: no markup, at most 40 characters. */
const label = (value: string | undefined) => {
  const text = value?.replace(/[<>]/g, "").trim();
  return text ? text.slice(0, 40) : null;
};

export function sampleReels(env: { readonly [name: string]: string | undefined } = serverEnv): SampleReel[] {
  const posters = entries(env.SAMPLE_REEL_POSTER_URL);
  const labels = entries(env.SAMPLE_REEL_LABELS);
  const raws = entries(env.SAMPLE_REEL_RAW_URLS);
  return entries(env.SAMPLE_REEL_URL)
    .map((src, index) => ({ src: url(src), poster: url(posters[index]), label: label(labels[index]), raw: url(raws[index]) }))
    .filter((sample): sample is SampleReel => sample.src !== null)
    .slice(0, MAX_SAMPLES);
}
