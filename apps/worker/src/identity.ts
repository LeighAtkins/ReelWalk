import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { FACE_CROP_PX } from "@reelwalk/core";

const run = promisify(execFile);

/**
 * Presenter identity (ADR 0056): the gate between a composed keyframe and the
 * paid Veo call, and the face crop a presenter kit is compared against.
 */

/** Below this the composite is recomposed, then refunded. */
export const IDENTITY_MIN_CONFIDENCE = 0.6;

/**
 * The smallest face the gate will judge, at 1080×1920: below this the
 * identity is the image model's invention, which is the defect (ADR 0056).
 */
export const MIN_GATE_FACE_PX = 120;

/** Gemini's box_2d: [ymin, xmin, ymax, xmax] on a 0–1000 grid. */
const box = z.array(z.number().min(0).max(1000)).length(4).nullable();
export const compareVerdictSchema = z.object({ samePerson: z.boolean(), confidence: z.number().min(0).max(1) });
export type IdentityVerdict = {
  samePerson: boolean; confidence: number; faceHeightPx: number | null;
  /** Why the faces were not compared: no usable face box, or a face too small to judge. */
  reason?: "no-face" | "face-too-small";
};

/** The face's height in pixels from a box, or null when the box is missing, empty or inverted. */
export function faceHeightFromBox(faceBox: number[] | null | undefined, imageHeight = 1920): number | null {
  if (!faceBox || faceBox.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = faceBox;
  if (!(ymax > ymin) || !(xmax > xmin)) return null;
  const height = Math.round((ymax - ymin) / 1000 * imageHeight);
  return height > 0 ? height : null;
}

/** The verdict for a composite whose face cannot be judged: never a pass. */
export function unjudgeable(faceHeightPx: number | null): IdentityVerdict | null {
  if (faceHeightPx === null) return { samePerson: false, confidence: 0, faceHeightPx: null, reason: "no-face" };
  if (faceHeightPx < MIN_GATE_FACE_PX) return { samePerson: false, confidence: 0, faceHeightPx, reason: "face-too-small" };
  return null;
}

export type IdentityDecision = "pass" | "recompose" | "reject";
/**
 * The decision table: a match at or above the threshold, on a measured face
 * at least MIN_GATE_FACE_PX tall, passes; anything else is recomposed once
 * with a stronger instruction, and a second miss is rejected (credit
 * refunded, nothing paid to Veo). A check that could not run counts as a
 * miss: the guard exists to stop paying for a wrong face.
 */
export function identityDecision(attempt: 1 | 2, verdict: IdentityVerdict | null): IdentityDecision {
  if (verdict && verdict.samePerson && verdict.confidence >= IDENTITY_MIN_CONFIDENCE
    && verdict.faceHeightPx !== null && verdict.faceHeightPx >= MIN_GATE_FACE_PX) return "pass";
  return attempt === 1 ? "recompose" : "reject";
}

/** The second call of the gate: two face crops, the composite's and the kit's. */
export const IDENTITY_PROMPT = [
  "You check identity for a video pipeline. The first image is a face cropped from a generated video keyframe. The second image is a close crop of one particular woman's face from her real reference photo.",
  "Decide whether they are the same person. Compare facial structure: eye shape and spacing, nose, mouth, jaw and chin, hairline, hair length and colour. Ignore lighting, expression, head angle, image sharpness and clothing.",
  "confidence is your probability (0 to 1) that they are the same person; a soft face that you cannot judge is low confidence, not a match.",
  "Answer with JSON only.",
].join(" ");

export const IDENTITY_RESPONSE_SCHEMA = {
  type: "OBJECT", required: ["samePerson", "confidence"],
  properties: { samePerson: { type: "BOOLEAN" }, confidence: { type: "NUMBER" } },
} as const;

export const FIND_FACE_PROMPT = "Find the face of the main person in this photo. Return JSON with faceBox [ymin, xmin, ymax, xmax] on a 0–1000 grid covering forehead to chin and ear to ear, or null if no face is clearly visible. JSON only.";
export const FIND_FACE_RESPONSE_SCHEMA = {
  type: "OBJECT", required: ["faceBox"], properties: { faceBox: { type: "ARRAY", items: { type: "NUMBER" }, nullable: true } },
} as const;
export const faceBoxSchema = z.object({ faceBox: box });

/**
 * The square cut around a detected face for the kit's face crop: the face
 * box grown to take in the hairline and hair length (identity cues the
 * compose instruction names), nudged up so the top of the hair is in, and
 * kept inside the image. Pixels of the source.
 */
export function faceCropRect(faceBox: number[], width: number, height: number): { x: number; y: number; size: number; faceHeightPx: number } {
  const [ymin, xmin, ymax, xmax] = faceBox;
  const top = ymin / 1000 * height, bottom = ymax / 1000 * height, left = xmin / 1000 * width, right = xmax / 1000 * width;
  const faceHeightPx = Math.max(1, Math.round(bottom - top));
  const size = Math.min(width, height, Math.max(16, Math.round(Math.max(bottom - top, right - left) * 2.2)));
  const centreX = (left + right) / 2, centreY = (top + bottom) / 2 - (bottom - top) * 0.15;
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(value)));
  return { x: clamp(centreX - size / 2, width - size), y: clamp(centreY - size / 2, height - size), size, faceHeightPx };
}

/** ffmpeg arguments that cut the face square from a PNG on disk and write the kit's 768×768 PNG. */
export function faceCropArguments(input: string, rect: { x: number; y: number; size: number }) {
  return ["-v", "error", "-nostdin", "-i", input, "-frames:v", "1",
    "-vf", `crop=${rect.size}:${rect.size}:${rect.x}:${rect.y},scale=${FACE_CROP_PX}:${FACE_CROP_PX}:flags=lanczos,setsar=1`,
    "-f", "image2pipe", "-vcodec", "png", "-pix_fmt", "rgb24", "pipe:1"];
}

/** Cut the face square from an image and return the 768×768 PNG (through a temp file: execFile cannot feed stdin). */
export async function cropFacePng(image: Buffer, rect: { x: number; y: number; size: number }): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "face-"));
  try {
    const input = path.join(dir, "image");
    await writeFile(input, image);
    const { stdout } = await run("ffmpeg", faceCropArguments(input, rect), { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true }) as unknown as { stdout: Buffer };
    if (stdout.length < 100 || stdout[0] !== 0x89 || stdout[1] !== 0x50) throw new Error("The face crop could not be encoded.");
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
