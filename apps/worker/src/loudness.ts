import { rename } from "node:fs/promises";
import path from "node:path";
import { loudnormFilter, loudnormMeasureFilter, LOUDNESS_TARGET, measureLoudness, parseLoudnorm, resampleLoudness, TRACE_STEP_MS, truePeakDb, withinTarget, type ExportLoudness, type LoudnessMeasure } from "@reelwalk/core";
import { decodeStereo48k, run } from "./library/tools";
import type { AttemptScope } from "./lifecycle";

/**
 * Exports come out at a streaming level (−16 LUFS integrated, −1 dBTP, ADR
 * 0066; ADR 0045 chose −14 before the library sound Instagram mixes on top
 * was taken into account) so a reel with a quiet presenter and a loud score
 * does not clip or sit under the posts around it. Two ffmpeg passes:
 * measure, then correct linearly by the measurement, which keeps the mix's
 * own dynamics. The filter strings and the target live in @reelwalk/core,
 * shared with the render fixture.
 */

export { LOUDNESS_TARGET, loudnormFilter, parseLoudnorm, withinTarget, type LoudnessMeasure };

/**
 * Normalises `file` in place, copying the video stream. A file without
 * audio, or one that is silent, is left alone. Returns what was measured.
 */
export async function normaliseLoudness(file: string, log: (line: string) => void, scope?: AttemptScope): Promise<LoudnessMeasure | null> {
  const { I, TP } = LOUDNESS_TARGET;
  let measured: LoudnessMeasure | null = null;
  try {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", loudnormMeasureFilter(), "-f", "null", "-"], { scope });
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

/**
 * What the finished export's own track holds (ADR 0066): integrated
 * loudness, true peak and momentary loudness every 250 ms, measured with
 * the pure BS.1770 code in @reelwalk/core on ffmpeg's decode. Null for a
 * file with no audio stream.
 */
export async function measureExportAudio(file: string, scope?: AttemptScope): Promise<ExportLoudness | null> {
  let channels: { left: Float32Array; right: Float32Array };
  try {
    channels = await decodeStereo48k(file, 180, scope);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (/does not contain any stream|Stream map .* matches no streams|Output file #0 does not contain any stream/.test(stderr)) return null;
    throw error;
  }
  if (channels.left.length === 0) return null;
  const { integrated, blocks } = measureLoudness([channels.left, channels.right], 48_000, 50);
  const peak = truePeakDb([channels.left, channels.right]);
  return {
    stepMs: TRACE_STEP_MS,
    lufs: resampleLoudness(blocks, TRACE_STEP_MS),
    integratedLufs: Number.isFinite(integrated) ? Math.round(integrated * 10) / 10 : null,
    truePeakDb: Number.isFinite(peak) && peak > -120 ? Math.round(peak * 10) / 10 : null,
  };
}
