import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, QUALITY_MEDIUM, canEncodeVideo } from "mediabunny";

/**
 * Shrinks a phone video on the phone before it is uploaded (ADR 0024). A
 * reel is 1080x1920, so a 4K clip carries four times the pixels the render
 * can use; re-encoding it to 1080 on the short side with the browser's own
 * hardware encoder (WebCodecs) turns a 25 MB clip into about 4 MB, and the
 * upload that took most of a minute takes seconds. The audio track is copied
 * as it is. Anything the browser cannot decode or encode is uploaded as it
 * came, so nothing is lost on an older phone.
 */

/** Short side of the shrunk video: the reel's own width. */
export const SHRINK_SHORT_SIDE = 1080;
/** Clips already lighter than this (bytes per second of video) are sent as they are: shrinking would not pay. */
const SHRINK_OVER_BYTES_PER_S = 1_000_000;

export type Shrunk = { file: File; from: { width: number; height: number; bytes: number }; ms: number };

/** Whether this browser can shrink video at all. */
export function canShrink(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined" && typeof OffscreenCanvas !== "undefined";
}

/**
 * The same clip at 1080 on the short side as an MP4 (H.264 + the original
 * audio), or null when it is small enough already or cannot be converted
 * here. `onProgress` goes from 0 to 1 over the conversion.
 */
export async function shrinkVideo(file: File, onProgress: (fraction: number) => void = () => undefined): Promise<Shrunk | null> {
  if (!canShrink() || !file.type.startsWith("video/")) return null;
  const started = performance.now();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const width = track.displayWidth;
    const height = track.displayHeight;
    const seconds = await input.computeDuration().catch(() => 0);
    const shortSide = Math.min(width, height);
    const heavy = seconds > 0 && file.size / seconds > SHRINK_OVER_BYTES_PER_S;
    if (shortSide <= SHRINK_SHORT_SIDE && !heavy) return null;
    const scale = Math.min(1, SHRINK_SHORT_SIDE / shortSide);
    const size = width <= height ? { width: Math.round(width * scale / 2) * 2 } : { height: Math.round(height * scale / 2) * 2 };
    const target = { width: Math.round(width * scale / 2) * 2, height: Math.round(height * scale / 2) * 2 };
    if (!(await canEncodeVideo("avc", target))) return null;

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      // Medium quality at 1080 is about what Instagram serves; a fixed bitrate was ignored by the hardware encoder.
      video: { ...size, codec: "avc", quality: QUALITY_MEDIUM, hardwareAcceleration: "prefer-hardware" },
      // The original sound as it is; a clip without sound stays without.
      audio: { codec: "aac" },
      showWarnings: false,
    });
    if (!conversion.isValid) return null;
    conversion.onProgress = (fraction) => onProgress(fraction);
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!buffer) return null;
    const name = file.name.replace(/\.[a-z0-9]+$/i, "") + ".mp4";
    const shrunk = new File([buffer], name, { type: "video/mp4", lastModified: file.lastModified });
    // Not smaller: the original was already well compressed, so it goes up as it is.
    if (shrunk.size >= file.size * 0.9) return null;
    return { file: shrunk, from: { width, height, bytes: file.size }, ms: Math.round(performance.now() - started) };
  } catch (error) {
    console.warn("shrink: uploading the original instead", error instanceof Error ? error.message : error);
    return null;
  } finally {
    input.dispose();
  }
}
