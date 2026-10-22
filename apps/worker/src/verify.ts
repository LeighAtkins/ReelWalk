import { checkDecodeArgs, renderChecks, seriesFromGreyFrames, type RenderChecks, type TextOverlay, type Timeline, type TitleFont } from "@reelwalk/core";
// The barrel pulls in the font CSS files, which Node cannot load; the look subpath is pure.
import { textTreatmentCss } from "@reelwalk/render/reel/look";
import type { AttemptScope } from "./lifecycle";
import { run } from "./library/tools";

/**
 * The render checks (ADR 0071) after every export: the finished file is
 * decoded once by ffmpeg to small grey frames and the pure checks in core
 * read them against the timeline that was rendered. The result is stored
 * beside the export (`checksKeyFor`) for the export screen, the Post gate
 * and `GET /api/renders/:id/checks`. A failure here never fails the render.
 */

/** The raw decode of a long reel: 72×128 grey at 30 fps is 276 KB a second; 96 MB is about six minutes. */
const DECODE_MAX_BYTES = 96 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 180_000;

/** A title's font as the renderer styles it (the same mapping the editor's critic uses). */
export function titleFontOf(text: TextOverlay): TitleFont {
  const css = textTreatmentCss(text);
  return { fontFamily: String(css.fontFamily ?? ""), fontWeight: css.fontWeight, fontSize: Number(css.fontSize) || 64, letterSpacing: text.tracking, fontStretch: css.fontStretch ? String(css.fontStretch) : undefined };
}

export async function verifyRender(videoPath: string, timeline: Timeline, log: (line: string) => void, scope?: AttemptScope): Promise<RenderChecks> {
  const started = Date.now();
  const { stdout } = await run("ffmpeg", checkDecodeArgs(videoPath), { scope, encoding: "buffer", maxBuffer: DECODE_MAX_BYTES, timeoutMs: DECODE_TIMEOUT_MS });
  const series = seriesFromGreyFrames(stdout);
  const checks = renderChecks({ timeline, series, titleFont: titleFontOf });
  const blocks = checks.checks.filter((check) => check.level === "block").length;
  log(`checks: ${series.length} frames read in ${((Date.now() - started) / 1000).toFixed(1)} s; ${checks.checks.length} finding(s), ${blocks} blocking${blocks ? `: ${checks.blockReasons[0]}` : ""}`);
  return checks;
}
