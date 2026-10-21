import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { framingInstruction, type PresenterFraming } from "@reelwalk/core";
import { VertexError, vertexAuth, type AwsCredentials } from "./vertex-video";
import { FIND_FACE_PROMPT, FIND_FACE_RESPONSE_SCHEMA, IDENTITY_PROMPT, IDENTITY_RESPONSE_SCHEMA, faceBoxSchema, readIdentityVerdict, type IdentityVerdict } from "./identity";

const run = promisify(execFile);

/**
 * Composed keyframes for Veo (ADR 0036). Given one real frame of the
 * property and one frame that shows the presenter, an image model places
 * her into the scene at human scale. Veo then interpolates between a
 * composed start and a composed end, which is the only way the villa's
 * skydive and roof-burst takes passed review: an empty exterior as the
 * start frame made her rise before she fell.
 *
 * With a presenter kit (ADR 0056) the model also gets her face crop, and
 * the identity gate asks a text model whether the composite is her.
 */

export const AI_IMAGE_MODEL = process.env.AI_IMAGE_MODEL || "gemini-2.5-flash-image";
/** A text model for the identity gate and face finding (ADR 0056). */
export const AI_IDENTITY_MODEL = process.env.AI_IDENTITY_MODEL || "gemini-2.5-flash";

export type InlineImage = { bytesBase64Encoded: string; mimeType: string };

export type ComposeOptions = {
  /** The kit's face crop is the third image (ADR 0056). */
  face?: boolean;
  framing?: PresenterFraming;
  /** The second attempt after the identity gate missed. */
  stronger?: boolean;
};

/** The instruction to the image model for one end of the shot. */
export function composePrompt(end: "first" | "last", instruction: string, options: ComposeOptions = {}): string {
  return [
    "Photoreal composite for a video keyframe. The first image is the scene: keep its camera position, lens, framing, light, colours and every surface exactly as they are.",
    options.face
      ? "The second image is the presenter's full-length reference: copy her outfit, build, skin tone and proportions. The third image is a close-up of her face: match the face in the third image exactly (eyes, nose, mouth, hairline, hair length and colour). Place her into the scene as described:"
      : "Place the person from the second image into that scene as described, keeping her face, hair, outfit, build and skin tone identical:",
    instruction.trim(),
    options.framing ? framingInstruction(options.framing) : "",
    "She must be at true human scale against the objects named and the architecture (a door is about 2.1 m, a chair seat 0.45 m, a kitchen bench 0.9 m); never larger than a doorway.",
    // The first reel's presenter stood on a coffee table: the model placed her by scale alone, not by the floor.
    "Her feet stand on visible, clear floor (never on or inside furniture, rugs' edges aside), below the horizon line; anything nearer the camera than that floor spot (a sofa back, a table, a counter) passes in front of her and hides the part of her it covers. She casts a soft contact shadow on the floor that matches the scene's light direction, and the scene's light falls on her the same way.",
    options.stronger
      ? "Identity is the priority: the last attempt changed her face. Reproduce the reference face feature for feature (eye shape and spacing, nose, lips, jaw, hairline, hair length, parting and colour); do not beautify, age, restyle or reinterpret her. Keep her face turned toward the camera and evenly lit."
      : "",
    end === "first" ? "This is the first frame of the shot: the moment just before the action starts." : "This is the last frame of the shot: the action has finished and she is settled in place.",
    "Portrait 9:16, 1080×1920. No text, logos, captions or extra people.",
  ].filter(Boolean).join(" ");
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

/** The JSON answer in a generateContent text response. */
export function jsonFromResponse(result: unknown): unknown {
  const candidates = (result as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates ?? [];
  const text = candidates.flatMap(candidate => candidate.content?.parts ?? []).map(part => part.text ?? "").join("").trim();
  if (!text) throw new Error("Google returned no answer.");
  return JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
}

const inlinePart = (image: InlineImage) => ({ inlineData: { mimeType: image.mimeType, data: image.bytesBase64Encoded } });

/** The request parts for one composed frame: instruction, scene, full-length reference, then her face when the kit has one. */
export function composeParts(end: "first" | "last", instruction: string, scene: InlineImage, presenter: InlineImage, face?: InlineImage, options: Omit<ComposeOptions, "face"> = {}) {
  return [
    { text: composePrompt(end, instruction, { ...options, face: Boolean(face) }) },
    inlinePart(scene), inlinePart(presenter), ...(face ? [inlinePart(face)] : []),
  ];
}

/**
 * Any image to the portrait JPEG Veo and the frame path expect. The image
 * goes through a temp file: execFile cannot feed stdin, and an ffmpeg
 * reading pipe:0 with nothing attached waits forever (it hung the worker).
 */
export async function portraitJpeg(image: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compose-"));
  const input = path.join(dir, "frame.img");
  try {
    await writeFile(input, image);
    const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-i", input, "-frames:v", "1",
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
      "-f", "image2pipe", "-vcodec", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", "2", "pipe:1"],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true }) as unknown as { stdout: Buffer };
    if (stdout.length < 100 || stdout[0] !== 0xff || stdout[1] !== 0xd8) throw new Error("The composed frame could not be encoded.");
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class VertexImages {
  private readonly getToken: () => Promise<string | null | undefined>;
  constructor(private readonly project = process.env.GOOGLE_CLOUD_PROJECT!, private readonly location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1", credentials?: AwsCredentials) {
    this.getToken = vertexAuth(credentials);
  }

  private async generate(model: string, parts: unknown[], generationConfig: unknown): Promise<unknown> {
    const token = await this.getToken();
    if (!token) throw new Error("Google credentials could not be refreshed.");
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${model}:generateContent`;
    const response = await fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
      signal: AbortSignal.timeout(120_000),
    });
    // Never persist provider bodies: they may contain request data or credentials.
    if (!response.ok) throw new VertexError(`Google image service returned HTTP ${response.status}.`, response.status);
    return response.json();
  }

  /**
   * One composed frame from the scene, the presenter reference and (with a kit) her face crop.
   * References go in as PNG; only the composite becomes the JPEG Veo needs.
   */
  async compose(end: "first" | "last", instruction: string, scene: InlineImage, presenter: InlineImage, face?: InlineImage, options: Omit<ComposeOptions, "face"> = {}, model = AI_IMAGE_MODEL): Promise<InlineImage> {
    const result = await this.generate(model, composeParts(end, instruction, scene, presenter, face, options),
      { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16" } });
    const image = imageFromResponse(result);
    if (!image) throw new Error("Google did not return a composed frame.");
    const jpeg = await portraitJpeg(Buffer.from(image.bytesBase64Encoded, "base64"));
    return { bytesBase64Encoded: jpeg.toString("base64"), mimeType: "image/jpeg" };
  }

  /** The identity gate's question (ADR 0056): is the face in the composite the reference's person? */
  async checkIdentity(composite: InlineImage, reference: InlineImage, model = AI_IDENTITY_MODEL): Promise<IdentityVerdict> {
    const result = await this.generate(model, [{ text: IDENTITY_PROMPT }, inlinePart(composite), inlinePart(reference)],
      { responseMimeType: "application/json", responseSchema: IDENTITY_RESPONSE_SCHEMA, temperature: 0 });
    return readIdentityVerdict(jsonFromResponse(result));
  }

  /** Where the face is in a portrait, for the kit's face crop; null when there is no clear face. */
  async findFace(image: InlineImage, model = AI_IDENTITY_MODEL): Promise<number[] | null> {
    const result = await this.generate(model, [{ text: FIND_FACE_PROMPT }, inlinePart(image)],
      { responseMimeType: "application/json", responseSchema: FIND_FACE_RESPONSE_SCHEMA, temperature: 0 });
    return faceBoxSchema.parse(jsonFromResponse(result)).faceBox;
  }
}
