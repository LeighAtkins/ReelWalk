import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { framingInstruction, type PresenterFraming } from "@reelwalk/core";
import { VertexError, vertexAuth, type AwsCredentials } from "./vertex-video";
import { FIND_FACE_PROMPT, IDENTITY_PROMPT, IDENTITY_RESPONSE_SCHEMA, MIN_GATE_FACE_PX, compareVerdictSchema, cropFacePng, faceCropRect, findFacePixelsPrompt, plausibleFace, readLocate, type IdentityVerdict, type LocateAttempt, type Located } from "./identity";

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
  /** Compose closer: 1 for a speaking end, 2 after a face too small to judge (see closerLevel). */
  closer?: 0 | 1 | 2;
};

/** The instruction to the image model for one end of the shot. */
export function composePrompt(end: "first" | "last", instruction: string, options: ComposeOptions = {}): string {
  return [
    "Photoreal composite for a video keyframe. The first image is the scene: keep its camera position, lens, framing, light, colours and every surface exactly as they are.",
    options.face
      ? "The second image is the presenter's full-length reference: copy her outfit, build, skin tone and proportions. The third image is a close-up of her face: match the face in the third image exactly (eyes, nose, mouth, hairline, hair length and colour). Place her into the scene as described:"
      : "Place the person from the second image into that scene as described, keeping her face, hair, outfit, build and skin tone identical:",
    instruction.trim(),
    // The closer wording replaces the framing text rather than contradicting it (medium asks only 180 px).
    options.closer === 2 ? "Come in closer than before: waist-up, her head in the top fifth of the frame, her face at least 260 px tall from hairline to chin. The last attempt made her face too small to recognise."
      : options.closer === 1 ? "Frame her closer, for a speaking shot: knees-up or tighter, the top of her head about a quarter of the way down, her face at least 220 px tall from hairline to chin, both eyes and her mouth sharp and clearly drawn."
      : options.framing ? framingInstruction(options.framing) : "",
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

  /**
   * The identity gate's question (ADR 0056): is the face in the 1080×1920 composite the reference's person?
   * Locate her face (Gemini's own box_2d format, then in stated pixels if that box is implausible or the
   * crop shows no face), crop it with the hair, and compare the crop, not the frame, with the kit's face.
   * A face shorter than `minFacePx` is not judged. Every locate attempt is returned for the record.
   */
  async checkIdentity(composite: InlineImage, reference: InlineImage, options: { minFacePx?: number } = {}, model = AI_IDENTITY_MODEL): Promise<IdentityVerdict> {
    const size = { width: 1080, height: 1920 }, minimum = options.minFacePx ?? MIN_GATE_FACE_PX;
    const bytes = Buffer.from(composite.bytesBase64Encoded, "base64");
    const locate: LocateAttempt[] = [];
    for (const mode of ["grid", "pixels"] as const) {
      let located: Located;
      try { located = await this.locateFace(composite, size, mode, model); } catch (error) {
        // A malformed answer is this mode's failure, not the whole check's; a transport error still ends the check.
        if (error instanceof VertexError) throw error;
        locate.push({ mode, box: null, rejected: "unparseable" });
        continue;
      }
      const attempt: LocateAttempt = { mode, box: located.box?.map(v => Math.round(v * 10) / 10) ?? null };
      locate.push(attempt);
      if (!located.box) { attempt.rejected = "no-face"; continue; }
      if (!plausibleFace(located, size)) { attempt.rejected = "implausible-box"; continue; }
      const rect = faceCropRect(located.box, size.width, size.height);
      attempt.crop = { x: rect.x, y: rect.y, size: rect.size }; attempt.faceHeightPx = rect.faceHeightPx;
      // Too small on the grid may be a misread box: ask in pixels before calling it small.
      if (rect.faceHeightPx < minimum) { attempt.rejected = "face-too-small"; continue; }
      const crop = await cropFacePng(bytes, rect);
      const result = await this.generate(model, [{ text: IDENTITY_PROMPT }, inlinePart({ bytesBase64Encoded: crop.toString("base64"), mimeType: "image/png" }), inlinePart(reference)],
        { responseMimeType: "application/json", responseSchema: IDENTITY_RESPONSE_SCHEMA, temperature: 0 });
      const verdict = compareVerdictSchema.parse(jsonFromResponse(result));
      // A crop with no face means the box missed her, not that she is someone else: never score it as identity.
      if (!verdict.faceVisible) { attempt.rejected = "face-not-in-crop"; continue; }
      return { samePerson: verdict.samePerson, confidence: verdict.confidence, eyesAndMouthRendered: verdict.eyesAndMouthRendered, faceHeightPx: rect.faceHeightPx, locate };
    }
    const small = locate.filter(attempt => attempt.rejected === "face-too-small").map(attempt => attempt.faceHeightPx!);
    if (small.length) return { samePerson: false, confidence: 0, faceHeightPx: Math.max(...small), reason: "face-too-small", locate };
    return { samePerson: false, confidence: 0, faceHeightPx: null, reason: locate.some(attempt => attempt.box) ? "locate-failed" : "no-face", locate };
  }

  /** One locate call: on the 0–1000 grid, or in pixels of the stated size (read back onto the grid). */
  async locateFace(image: InlineImage, size: { width: number; height: number }, mode: "grid" | "pixels", model = AI_IDENTITY_MODEL): Promise<Located> {
    const result = await this.generate(model, [{ text: mode === "grid" ? FIND_FACE_PROMPT : findFacePixelsPrompt(size.width, size.height) }, inlinePart(image)],
      { responseMimeType: "application/json", temperature: 0 });
    return readLocate(jsonFromResponse(result), size);
  }

  /** Where the face is in a portrait, for the kit's face crop: a plausible box from either locate mode, or null. */
  async findFace(image: InlineImage, size: { width: number; height: number }, model = AI_IDENTITY_MODEL): Promise<{ box: number[] | null; locate: LocateAttempt[] }> {
    const locate: LocateAttempt[] = [];
    for (const mode of ["grid", "pixels"] as const) {
      let located: Located;
      try { located = await this.locateFace(image, size, mode, model); } catch (error) {
        if (error instanceof VertexError) throw error;
        locate.push({ mode, box: null, rejected: "unparseable" });
        continue;
      }
      const ok = located.box !== null && plausibleFace(located, size);
      locate.push({ mode, box: located.box, ...(ok ? {} : { rejected: located.box ? "implausible-box" as const : "no-face" as const }) });
      if (ok) return { box: located.box, locate };
    }
    return { box: null, locate };
  }
}
