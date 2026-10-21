import { z } from "zod";
import { FACE_CROP_PX } from "@reelwalk/core";

/**
 * Presenter identity (ADR 0056): the gate between a composed keyframe and the
 * paid Veo call, and the face crop a presenter kit is compared against.
 */

/** Below this the composite is recomposed, then refunded. */
export const IDENTITY_MIN_CONFIDENCE = 0.6;

/** Gemini's box_2d: [ymin, xmin, ymax, xmax] on a 0–1000 grid. */
const box = z.array(z.number().min(0).max(1000)).length(4).nullable();
export const identityVerdictSchema = z.object({
  samePerson: z.boolean(),
  confidence: z.number().min(0).max(1),
  faceHeightPx: z.number().min(0).nullable().optional(),
  faceBox: box.optional(),
});
export type IdentityVerdict = { samePerson: boolean; confidence: number; faceHeightPx: number | null };

/**
 * The verdict as checked: confidence clamped, and the face height measured
 * from the box (the model's own pixel count is a fallback, not the measure).
 */
export function readIdentityVerdict(raw: unknown, imageHeight = 1920): IdentityVerdict {
  const verdict = identityVerdictSchema.parse(raw);
  const [ymin, , ymax] = verdict.faceBox ?? [];
  const fromBox = verdict.faceBox && ymax! > ymin! ? Math.round((ymax! - ymin!) / 1000 * imageHeight) : null;
  return { samePerson: verdict.samePerson, confidence: verdict.confidence, faceHeightPx: fromBox ?? (verdict.faceHeightPx != null ? Math.round(verdict.faceHeightPx) : null) };
}

export type IdentityDecision = "pass" | "recompose" | "reject";
/**
 * The decision table: a match at or above the threshold passes; anything
 * else is recomposed once with a stronger instruction, and a second miss
 * is rejected (credit refunded, nothing paid to Veo). A check that could not
 * run counts as a miss: the guard exists to stop paying for a wrong face.
 */
export function identityDecision(attempt: 1 | 2, verdict: IdentityVerdict | null): IdentityDecision {
  if (verdict && verdict.samePerson && verdict.confidence >= IDENTITY_MIN_CONFIDENCE) return "pass";
  return attempt === 1 ? "recompose" : "reject";
}

export const IDENTITY_PROMPT = [
  "You check identity for a video pipeline. The first image is a 1080×1920 video keyframe that should show one particular woman. The second image is a close crop of that woman's face from her real reference photo.",
  "Find the most prominent person's face in the first image and return its box as faceBox [ymin, xmin, ymax, xmax] on a 0–1000 grid (null if there is no face).",
  "Then decide whether that face is the same person as the second image. Compare facial structure: eye shape and spacing, nose, mouth, jaw and chin, hairline, hair length and colour. Ignore lighting, expression, head angle, image sharpness and clothing.",
  "confidence is your probability (0 to 1) that they are the same person; a soft or tiny face that you cannot judge is low confidence, not a match. faceHeightPx is the face's height in the first image's pixels.",
  "Answer with JSON only.",
].join(" ");

export const IDENTITY_RESPONSE_SCHEMA = {
  type: "OBJECT", required: ["samePerson", "confidence", "faceHeightPx", "faceBox"],
  properties: {
    samePerson: { type: "BOOLEAN" }, confidence: { type: "NUMBER" }, faceHeightPx: { type: "NUMBER", nullable: true },
    faceBox: { type: "ARRAY", items: { type: "NUMBER" }, nullable: true },
  },
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
