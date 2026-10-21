import { rename } from "node:fs/promises";
import path from "node:path";
import { run } from "./library/tools";
import type { AttemptScope } from "./lifecycle";

/**
 * Exports come out at a broadcast-style level (−14 LUFS integrated, −1 dBTP)
 * so a reel with a quiet presenter and a loud score does not clip or sit
 * under the posts around it. Two ffmpeg passes: measure, then correct
 * linearly by the measurement, which keeps the mix's own dynamics.
 */

export const LOUDNESS_TARGET = { I: -14, TP: -1, LRA: 11 };

export type LoudnessMeasure = { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string };

/** The measurement block ffmpeg's loudnorm prints (as JSON, after the usual log lines). */
export function parseLoudnorm(output: string): LoudnessMeasure | null {
  const start = output.lastIndexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const data = JSON.parse(output.slice(start, end + 1)) as Partial<LoudnessMeasure>;
    if (!data.input_i || !data.input_tp || !data.input_lra || !data.input_thresh || !data.target_offset) return null;
    return data as LoudnessMeasure;
  } catch {
    return null;
  }
}

/** The second-pass filter: the first pass's numbers fed back so the correction is one fixed gain. */
export function loudnormFilter(measured: LoudnessMeasure): string {
  const { I, TP, LRA } = LOUDNESS_TARGET;
  return `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
}

/** Whether the level is close enough to the target that re-encoding the audio would change nothing audible. */
export function withinTarget(measured: LoudnessMeasure, toleranceLu = 1): boolean {
  return Math.abs(Number(measured.input_i) - LOUDNESS_TARGET.I) <= toleranceLu && Number(measured.input_tp) <= LOUDNESS_TARGET.TP;
}

/**
 * Normalises `file` in place, copying the video stream. A file without
 * audio, or one that is silent, is left alone. Returns what was measured.
 */
export async function normaliseLoudness(file: string, log: (line: string) => void, scope?: AttemptScope): Promise<LoudnessMeasure | null> {
  const { I, TP, LRA } = LOUDNESS_TARGET;
  let measured: LoudnessMeasure | null = null;
  try {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`, "-f", "null", "-"], { scope });
    measured = parseLoudnorm(stderr);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    // No audio stream: nothing to level.
    if (/does not contain any stream|Stream map .* matches no streams/.test(stderr)) return null;
    throw error;
  }
  if (!measured || !Number.isFinite(Number(measured.input_i))) {
    log("loudness: silent, left as rendered");
    return measured;
  }
  log(`loudness: ${measured.input_i} LUFS, peak ${measured.input_tp} dBTP`);
  if (withinTarget(measured)) return measured;
  const levelled = path.join(path.dirname(file), `levelled-${path.basename(file)}`);
  await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", loudnormFilter(measured), "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", levelled], { scope });
  await rename(levelled, file);
  log(`loudness: levelled to ${I} LUFS, ${TP} dBTP`);
  return measured;
}
