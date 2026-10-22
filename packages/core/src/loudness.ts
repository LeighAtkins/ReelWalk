import { EXPORT_LOUDNESS } from "./mix";

/**
 * The export's level, as ffmpeg's loudnorm sets it (ADR 0066, before it
 * ADR 0045's −14): two passes, measure then correct linearly by the
 * measurement, which keeps the mix's own dynamics. The pure parts live
 * here so the worker and the render fixture use one filter string and one
 * target; the ffmpeg calls stay in the worker.
 */

export const LOUDNESS_TARGET = { I: EXPORT_LOUDNESS.lufs, TP: EXPORT_LOUDNESS.truePeakDb, LRA: 11 } as const;

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

/** The first-pass filter: measure only, print the numbers. */
export function loudnormMeasureFilter(): string {
  const { I, TP, LRA } = LOUDNESS_TARGET;
  return `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`;
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
