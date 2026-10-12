/**
 * Finished reels the landing page plays, from env so real exports can be
 * dropped in without a deploy of code: SAMPLE_REEL_URL holds one or more
 * public video URLs separated by commas, SAMPLE_REEL_POSTER_URL the matching
 * poster images in the same order (optional). Nothing set: the page shows a
 * drawn placeholder frame instead.
 */
export type SampleReel = { src: string; poster: string | null };

const MAX_SAMPLES = 3;

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\//.test(item));
}

export function sampleReels(env: NodeJS.ProcessEnv = process.env): SampleReel[] {
  const posters = list(env.SAMPLE_REEL_POSTER_URL);
  return list(env.SAMPLE_REEL_URL)
    .slice(0, MAX_SAMPLES)
    .map((src, index) => ({ src, poster: posters[index] ?? null }));
}
