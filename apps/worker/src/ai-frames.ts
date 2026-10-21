import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

const run = promisify(execFile);
// "face" is the presenter kit's 768×768 face crop (ADR 0056).
const roles = z.enum(["first", "last", "presenter", "face"]);
const sources = z.array(z.object({
  key: z.string().min(1), kind: z.enum(["IMAGE", "VIDEO"]), atMs: z.number().int().min(0).max(86_400_000),
  // Rows from before composed keyframes (ADR 0036) have no role: they are the start frame, then the end frame.
  role: roles.optional(), compose: z.string().max(1000).optional(),
  framing: z.enum(["medium", "wide"]).optional(),
})).min(1).max(4);

export type DecodedFrame = { bytesBase64Encoded: string; mimeType: string; role?: z.infer<typeof roles>; compose?: string; framing?: "medium" | "wide" };

/** The decoded frames by what they are for. */
export function keyframes(frames: DecodedFrame[]): { image?: DecodedFrame; lastFrame?: DecodedFrame; presenter?: DecodedFrame; face?: DecodedFrame } {
  const byRole = (role: z.infer<typeof roles>) => frames.find(frame => frame.role === role);
  return {
    image: byRole("first") ?? (frames[0] && !frames[0].role ? frames[0] : undefined),
    lastFrame: byRole("last") ?? (frames[1] && !frames[1].role ? frames[1] : undefined),
    presenter: byRole("presenter"),
    face: byRole("face"),
  };
}

/**
 * How a frame is decoded. A frame Veo sees as-is stays the portrait JPEG it
 * always was. Anything the image model reads (a scene to compose into, the
 * presenter, her face) is PNG: 4:2:0 JPEG halves the colour resolution of a
 * face that may be only a few dozen pixels wide (ADR 0056). References keep
 * their own shape and are never upscaled; only scenes are cropped to 9:16.
 */
export type FrameOutput = "veo-jpeg" | "scene-png" | "reference-png";
export function frameOutput(role: z.infer<typeof roles> | undefined, composed: boolean): FrameOutput {
  if (role === "presenter" || role === "face") return "reference-png";
  return composed ? "scene-png" : "veo-jpeg";
}

export function frameArguments(url: string, atMs: number, output: FrameOutput = "veo-jpeg") {
  const filter = output === "reference-png" ? "scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1"
    : "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1";
  const encode = output === "veo-jpeg" ? ["-vcodec", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", "2"] : ["-vcodec", "png", "-pix_fmt", "rgb24"];
  return ["-v", "error", "-nostdin", "-threads", "2", "-protocol_whitelist", "https,http,tcp,tls,crypto",
    "-format_whitelist", "mov,matroska,jpeg_pipe,png_pipe",
    "-ss", (atMs / 1000).toFixed(3), "-i", url, "-frames:v", "1", "-an",
    "-vf", filter,
    "-threads", "2", "-f", "image2pipe", ...encode, "pipe:1"];
}

export const isJpeg = (bytes: Buffer) => bytes.length >= 100 && bytes[0] === 0xff && bytes[1] === 0xd8;
export const isPng = (bytes: Buffer) => bytes.length >= 100 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
/** Width and height from a PNG's header. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (!isPng(bytes)) throw new Error("Not a PNG.");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Decode one stored frame with short-lived signed URLs that are never stored. */
export async function decodeFrame(s3: S3Client, bucket: string, key: string, atMs: number, output: FrameOutput): Promise<Buffer> {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 120 });
  const { stdout } = await run("ffmpeg", frameArguments(url, atMs, output), {
    encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 60_000, windowsHide: true,
  }) as unknown as { stdout: Buffer };
  if (!(output === "veo-jpeg" ? isJpeg(stdout) : isPng(stdout))) throw new Error("Source frame could not be decoded.");
  return stdout;
}

/** Decode the real source frames of a generation. */
export async function aiFrames(s3: S3Client, bucket: string, input: unknown): Promise<DecodedFrame[]> {
  const frames: DecodedFrame[] = [];
  for (const source of sources.parse(input)) {
    const output = frameOutput(source.role, Boolean(source.compose));
    const bytes = await decodeFrame(s3, bucket, source.key, source.atMs, output);
    frames.push({ bytesBase64Encoded: bytes.toString("base64"), mimeType: output === "veo-jpeg" ? "image/jpeg" : "image/png",
      ...(source.role ? { role: source.role } : {}), ...(source.compose ? { compose: source.compose } : {}), ...(source.framing ? { framing: source.framing } : {}) });
  }
  return frames;
}
