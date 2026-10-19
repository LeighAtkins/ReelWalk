import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VertexError, vertexAuth, type AwsCredentials } from "./vertex-video";

const run = promisify(execFile);

/**
 * Composed keyframes for Veo (ADR 0036). Given one real frame of the
 * property and one frame that shows the presenter, an image model places
 * her into the scene at human scale. Veo then interpolates between a
 * composed start and a composed end, which is the only way the villa's
 * skydive and roof-burst takes passed review: an empty exterior as the
 * start frame made her rise before she fell.
 */

export const AI_IMAGE_MODEL = process.env.AI_IMAGE_MODEL || "gemini-2.5-flash-image";

export type InlineImage = { bytesBase64Encoded: string; mimeType: string };

/** The instruction to the image model for one end of the shot. */
export function composePrompt(end: "first" | "last", instruction: string): string {
  return [
    "Photoreal composite for a video keyframe. The first image is the scene: keep its camera position, lens, framing, light, colours and every surface exactly as they are.",
    "Place the person from the second image into that scene as described, keeping her face, hair, outfit, build and skin tone identical:",
    instruction.trim(),
    "She must be at true human scale against the objects named and the architecture (a door is about 2.1 m, a chair seat 0.45 m, a kitchen bench 0.9 m); never larger than a doorway. Natural shadows and contact with the ground or furniture.",
    end === "first" ? "This is the first frame of the shot: the moment just before the action starts." : "This is the last frame of the shot: the action has finished and she is settled in place.",
    "Portrait 9:16, 1080×1920. No text, logos, captions or extra people.",
  ].join(" ");
}

/** The image in a generateContent response, if the model returned one. */
export function imageFromResponse(result: unknown): InlineImage | null {
  const candidates = (result as { candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[] })?.candidates ?? [];
  for (const candidate of candidates) for (const part of candidate.content?.parts ?? []) {
    const data = part.inlineData;
    if (data?.data && data.mimeType?.startsWith("image/")) return { bytesBase64Encoded: data.data, mimeType: data.mimeType };
  }
  return null;
}

/** Any image to the portrait JPEG Veo and the frame path expect. */
export async function portraitJpeg(image: Buffer): Promise<Buffer> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-i", "pipe:0", "-frames:v", "1",
    "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
    "-f", "image2pipe", "-vcodec", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", "2", "pipe:1"],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true, input: image } as never) as unknown as { stdout: Buffer };
  if (stdout.length < 100 || stdout[0] !== 0xff || stdout[1] !== 0xd8) throw new Error("The composed frame could not be encoded.");
  return stdout;
}

export class VertexImages {
  private readonly getToken: () => Promise<string | null | undefined>;
  constructor(private readonly project = process.env.GOOGLE_CLOUD_PROJECT!, private readonly location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1", credentials?: AwsCredentials) {
    this.getToken = vertexAuth(credentials);
  }

  /** One composed frame from the scene, the presenter reference and the instruction. */
  async compose(end: "first" | "last", instruction: string, scene: InlineImage, presenter: InlineImage, model = AI_IMAGE_MODEL): Promise<InlineImage> {
    const token = await this.getToken();
    if (!token) throw new Error("Google credentials could not be refreshed.");
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${model}:generateContent`;
    const response = await fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: composePrompt(end, instruction) },
          { inlineData: { mimeType: scene.mimeType, data: scene.bytesBase64Encoded } },
          { inlineData: { mimeType: presenter.mimeType, data: presenter.bytesBase64Encoded } },
        ] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16" } },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    // Never persist provider bodies: they may contain request data or credentials.
    if (!response.ok) throw new VertexError(`Google image service returned HTTP ${response.status}.`, response.status);
    const image = imageFromResponse(await response.json());
    if (!image) throw new Error("Google did not return a composed frame.");
    const jpeg = await portraitJpeg(Buffer.from(image.bytesBase64Encoded, "base64"));
    return { bytesBase64Encoded: jpeg.toString("base64"), mimeType: "image/jpeg" };
  }
}
