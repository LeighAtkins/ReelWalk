import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

const run = promisify(execFile);
const roles = z.enum(["first", "last", "presenter"]);
const sources = z.array(z.object({
  key: z.string().min(1), kind: z.enum(["IMAGE", "VIDEO"]), atMs: z.number().int().min(0).max(86_400_000),
  // Rows from before composed keyframes (ADR 0036) have no role: they are the start frame, then the end frame.
  role: roles.optional(), compose: z.string().max(1000).optional(),
})).min(1).max(3);

export type DecodedFrame = { bytesBase64Encoded: string; mimeType: string; role?: z.infer<typeof roles>; compose?: string };

/** The decoded frames by what they are for. */
export function keyframes(frames: DecodedFrame[]): { image?: DecodedFrame; lastFrame?: DecodedFrame; presenter?: DecodedFrame } {
  const byRole = (role: z.infer<typeof roles>) => frames.find(frame => frame.role === role);
  return {
    image: byRole("first") ?? (frames[0] && !frames[0].role ? frames[0] : undefined),
    lastFrame: byRole("last") ?? (frames[1] && !frames[1].role ? frames[1] : undefined),
    presenter: byRole("presenter"),
  };
}

export function frameArguments(url: string, atMs: number) {
  return ["-v", "error", "-nostdin", "-threads", "2", "-protocol_whitelist", "https,http,tcp,tls,crypto",
    "-format_whitelist", "mov,matroska,jpeg_pipe,png_pipe",
    "-ss", (atMs / 1000).toFixed(3), "-i", url, "-frames:v", "1", "-an",
    "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
    "-threads", "2", "-f", "image2pipe", "-vcodec", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", "2", "pipe:1"];
}

/** Decode one real source frame; signed URLs are short lived and never stored. */
export async function aiFrames(s3: S3Client, bucket: string, input: unknown): Promise<DecodedFrame[]> {
  const frames: DecodedFrame[] = [];
  for (const source of sources.parse(input)) {
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: source.key }), { expiresIn: 120 });
    const { stdout } = await run("ffmpeg", frameArguments(url, source.atMs), {
      encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 60_000, windowsHide: true,
    });
    if (stdout.length < 100 || stdout[0] !== 0xff || stdout[1] !== 0xd8) throw new Error("Source frame could not be decoded.");
    frames.push({ bytesBase64Encoded: stdout.toString("base64"), mimeType: "image/jpeg", ...(source.role ? { role: source.role } : {}), ...(source.compose ? { compose: source.compose } : {}) });
  }
  return frames;
}
