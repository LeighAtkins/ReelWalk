import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { clipMomentAtSource, clipPicture, compositionToSource, presentGray, type Clip, type Gray } from "@reelwalk/core";
import { ffmpegAvailable, ffmpegBin } from "@/lib/stock-check";

const run = promisify(execFile);

/**
 * Reading pictures for the surface finder without a browser (ADR 0075): single frames and an evenly
 * sampled run through a shot, decoded by ffmpeg from a file or a URL, and shown as the composition
 * shows them (fit, zoom, camera move: `presentGray` in core, the analysis picture of ADR 0047). Used by
 * `POST /api/reels/:id/commands` for `placeOnSurface`, which has no <video> to seek.
 */
export type SurfaceSource = {
  /** A local path or an http(s) URL ffmpeg can read (the library's preview rendition is enough: tracking works at 360×640). */
  src: string;
  /** The video's display size, px (as stored on the media). */
  width: number;
  height: number;
};

/** The decoded height: the tracker's own, so a 9:16 source is read at exactly the tracker's size. */
const DECODE_HEIGHT = 640;
const evenWidth = (source: SurfaceSource, height: number) => Math.max(2, Math.round(((source.width / source.height) * height) / 2) * 2);

export async function surfaceDecodeAvailable(): Promise<boolean> {
  return ffmpegAvailable();
}

const seconds = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

/** One frame of the source at `ms`, luminance, `DECODE_HEIGHT` px tall at the source's own shape. */
export async function readSourceFrame(source: SurfaceSource, ms: number): Promise<Gray> {
  const width = evenWidth(source, DECODE_HEIGHT);
  const { stdout } = await run(ffmpegBin(), ["-v", "error", "-ss", seconds(ms), "-i", source.src, "-frames:v", "1", "-vf", `scale=${width}:${DECODE_HEIGHT}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (stdout.length < width * DECODE_HEIGHT) throw new Error("The video has no frame there.");
  return { data: Float32Array.from(stdout.subarray(0, width * DECODE_HEIGHT)), width, height: DECODE_HEIGHT };
}

/**
 * `count` frames spread evenly from `fromMs` to `toMs` of the source (one decoding pass), as the
 * tracker's composition frames: each is presented through `clip`. Returns the frames and the source
 * time of each, which can differ from the asked-for times by a frame (the pass picks frames by rate).
 */
export async function readTrackingFrames(source: SurfaceSource, clip: Clip, fromMs: number, toMs: number, count: number): Promise<{ frames: Gray[]; times: number[] }> {
  const width = evenWidth(source, DECODE_HEIGHT), size = width * DECODE_HEIGHT;
  const span = Math.max(1, toMs - fromMs);
  const fps = ((count - 1) / span) * 1000;
  const { stdout } = await run(ffmpegBin(), ["-v", "error", "-ss", seconds(fromMs), "-i", source.src, "-t", seconds(span + 1000 / fps / 2), "-vf", `fps=${fps.toFixed(5)},scale=${width}:${DECODE_HEIGHT}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
  const got = Math.min(count, Math.floor(stdout.length / size));
  if (got < 2) throw new Error("The video could not be read through the shot.");
  const times = Array.from({ length: got }, (_, i) => fromMs + (span * i) / (count - 1));
  const frames: Gray[] = [];
  for (let i = 0; i < got; i++) frames.push(presentGray({ data: Float32Array.from(stdout.subarray(i * size, (i + 1) * size)), width, height: DECODE_HEIGHT }, clip, times[i]));
  return { frames, times };
}

/**
 * The composition frame at source time `ms` in colour, as a JPEG the model can look at (`width`×`height`,
 * flat grey where the picture does not reach): the clip's fit, zoom and camera move applied with the
 * same mapping as `presentGray`. A still image is read as it is.
 */
export async function presentedJpeg(source: SurfaceSource, clip: Clip, ms: number, width = 576, height = 1024): Promise<Buffer> {
  const rows = 960;
  const { stdout } = await run(ffmpegBin(), ["-v", "error", "-ss", seconds(ms), "-i", source.src, "-frames:v", "1", "-vf", `scale=-2:${rows}`, "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  const meta = await sharp(stdout).metadata();
  const sw = meta.width ?? 0, sh = meta.height ?? 0;
  if (!sw || !sh) throw new Error("The video has no frame there.");
  const picture = clipPicture(clip, { width: sw, height: sh }, clipMomentAtSource(clip, ms));
  // The composition's own rectangle, in source px; the part of it the picture covers is cut out and set in a grey frame.
  const [x0, y0] = compositionToSource(picture, 0, 0), [x1, y1] = compositionToSource(picture, 1, 1);
  const vx0 = Math.max(0, x0), vy0 = Math.max(0, y0), vx1 = Math.min(sw, x1), vy1 = Math.min(sh, y1);
  if (vx1 - vx0 < 2 || vy1 - vy0 < 2) throw new Error("The picture is not on screen there.");
  const place = { left: Math.round(((vx0 - x0) / (x1 - x0)) * width), top: Math.round(((vy0 - y0) / (y1 - y0)) * height) };
  const size = { width: Math.max(1, Math.min(width - place.left, Math.round(((vx1 - vx0) / (x1 - x0)) * width))), height: Math.max(1, Math.min(height - place.top, Math.round(((vy1 - vy0) / (y1 - y0)) * height))) };
  const piece = await sharp(stdout).extract({ left: Math.floor(vx0), top: Math.floor(vy0), width: Math.max(1, Math.floor(vx1 - vx0)), height: Math.max(1, Math.floor(vy1 - vy0)) }).resize(size.width, size.height, { fit: "fill" }).toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } }).composite([{ input: piece, left: place.left, top: place.top }]).jpeg({ quality: 82 }).toBuffer();
}
