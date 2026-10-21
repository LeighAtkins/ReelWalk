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
 * The smallest face the gate will judge, hairline to chin at 1080×1920:
 * below this the identity is the image model's invention, which is the
 * defect (ADR 0056). A speaking take needs more: Veo and lip sync animate
 * the eyes and mouth, and at 120 px they came back without either.
 */
export const MIN_GATE_FACE_PX = 120;
export const MIN_SPEAKING_FACE_PX = 220;
export const minFacePx = (speaking: boolean) => speaking ? MIN_SPEAKING_FACE_PX : MIN_GATE_FACE_PX;

export const compareVerdictSchema = z.object({
  /** Whether the first image (the crop) shows a human face at all: false means the locate step missed. */
  faceVisible: z.boolean(),
  samePerson: z.boolean(),
  confidence: z.number().min(0).max(1),
  /** Both eyes open with visible iris and whites, and a clearly formed mouth. */
  eyesAndMouthRendered: z.boolean(),
});

/** One locate attempt, kept with the verdict so a false reject can be diagnosed from the database. */
export type LocateAttempt = {
  mode: "grid" | "pixels";
  /** The box as read, on the 0–1000 grid ([ymin, xmin, ymax, xmax]); null when the model found no face. */
  box: number[] | null;
  /** Why the box was not used, if it was not. */
  rejected?: "no-face" | "implausible-box" | "face-not-in-crop";
  crop?: { x: number; y: number; size: number };
  faceHeightPx?: number;
};

export type IdentityVerdict = {
  samePerson: boolean; confidence: number; faceHeightPx: number | null;
  /** Both eyes open with visible iris/whites and a clearly rendered mouth; required to pass. */
  eyesAndMouthRendered?: boolean;
  /** Why the faces were not compared: no face, a box that never landed on a face, or a face too small to judge. */
  reason?: "no-face" | "locate-failed" | "face-too-small";
  locate?: LocateAttempt[];
};

/** The face's height in pixels from a box, or null when the box is missing, empty or inverted. */
export function faceHeightFromBox(faceBox: number[] | null | undefined, imageHeight = 1920): number | null {
  if (!faceBox || faceBox.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = faceBox;
  if (!(ymax > ymin) || !(xmax > xmin)) return null;
  const height = Math.round((ymax - ymin) / 1000 * imageHeight);
  return height > 0 ? height : null;
}

/** The verdict for a composite whose face is too small to judge: never a pass. */
export function unjudgeable(faceHeightPx: number | null, minimum = MIN_GATE_FACE_PX): IdentityVerdict | null {
  if (faceHeightPx === null) return { samePerson: false, confidence: 0, faceHeightPx: null, reason: "no-face" };
  if (faceHeightPx < minimum) return { samePerson: false, confidence: 0, faceHeightPx, reason: "face-too-small" };
  return null;
}

export type IdentityDecision = "pass" | "recompose" | "reject";
/**
 * The decision table: the same person at or above the threshold, on a
 * measured face at least `minimum` px tall, with both eyes and the mouth
 * rendered, passes; anything else is recomposed once with a stronger
 * instruction, and a second miss is rejected (credit refunded, nothing paid
 * to Veo). A check that could not run counts as a miss.
 */
export function identityDecision(attempt: 1 | 2, verdict: IdentityVerdict | null, minimum = MIN_GATE_FACE_PX): IdentityDecision {
  if (verdict && verdict.samePerson && verdict.confidence >= IDENTITY_MIN_CONFIDENCE && verdict.eyesAndMouthRendered === true
    && verdict.faceHeightPx !== null && verdict.faceHeightPx >= minimum) return "pass";
  return attempt === 1 ? "recompose" : "reject";
}

/** The compare call: the composite's face crop and the kit's. */
export const IDENTITY_PROMPT = [
  "You check identity for a video pipeline. The first image is a square crop, cut around a face from a generated video keyframe. The second image is a close crop of one particular woman's face from her real reference photo.",
  "faceVisible: does the first image show a human face (not only clothing, hands, background or the top of a head)?",
  "samePerson and confidence: if it does, is it the same person as the second image? Compare facial structure: eye shape and spacing, nose, mouth, jaw and chin, hairline, hair length and colour. Ignore lighting, expression, head angle, image sharpness and clothing. confidence is your probability (0 to 1) that they are the same person; a soft face that you cannot judge is low confidence, not a match. If there is no face, samePerson is false and confidence 0.",
  "eyesAndMouthRendered: in the first image, are both eyes open with visible iris and whites, and is the mouth clearly formed (not smeared, missing or merged)?",
  "Answer with JSON only.",
].join(" ");

export const IDENTITY_RESPONSE_SCHEMA = {
  type: "OBJECT", required: ["faceVisible", "samePerson", "confidence", "eyesAndMouthRendered"],
  properties: { faceVisible: { type: "BOOLEAN" }, samePerson: { type: "BOOLEAN" }, confidence: { type: "NUMBER" }, eyesAndMouthRendered: { type: "BOOLEAN" } },
} as const;

/**
 * The locate call, in Gemini's own detection format (`box_2d`, y first,
 * normalised to 0–1000), with the eyes and mouth as checkable landmarks. The
 * first version named the field `faceBox` and forced it through a response
 * schema; on cmvi32byk its box could not have been her face (see ADR 0056).
 */
export const FIND_FACE_PROMPT = [
  "Detect the face of the main person in this image.",
  "Return JSON: {\"box_2d\": [ymin, xmin, ymax, xmax], \"left_eye\": [y, x], \"right_eye\": [y, x], \"mouth\": [y, x]}.",
  "All coordinates are normalised to 0–1000 over the whole image (0,0 is the top-left corner, 1000,1000 the bottom-right), y before x.",
  "The box covers the face from the hairline to the chin and ear to ear.",
  "If no face is clearly visible, return {\"box_2d\": null}.",
].join(" ");

/** The fallback locate: the same question in pixels of the stated size, for a model that answers in pixels anyway. */
export function findFacePixelsPrompt(width: number, height: number) {
  return [
    `This image is ${width} pixels wide and ${height} pixels tall. Detect the face of the main person.`,
    `Return JSON: {"box_px": [top, left, bottom, right]} in pixels of this ${width}×${height} image, from the hairline to the chin and ear to ear,`,
    "or {\"box_px\": null} if no face is clearly visible.",
  ].join(" ");
}

const point = z.array(z.number()).length(2);
const locateSchema = z.object({
  box_2d: z.array(z.number()).length(4).nullable().optional(),
  faceBox: z.array(z.number()).length(4).nullable().optional(),
  box_px: z.array(z.number()).length(4).nullable().optional(),
  left_eye: point.nullable().optional(), right_eye: point.nullable().optional(), mouth: point.nullable().optional(),
}).passthrough();
export type Located = { box: number[] | null; landmarks: { leftEye?: number[]; rightEye?: number[]; mouth?: number[] } };

/** Read a locate answer onto the 0–1000 grid. Gemini sometimes wraps it in a one-element list. */
export function readLocate(raw: unknown, image: { width: number; height: number }): Located {
  const parsed = locateSchema.parse(Array.isArray(raw) ? raw[0] ?? {} : raw);
  const landmarks = { ...(parsed.left_eye ? { leftEye: parsed.left_eye } : {}), ...(parsed.right_eye ? { rightEye: parsed.right_eye } : {}), ...(parsed.mouth ? { mouth: parsed.mouth } : {}) };
  if (parsed.box_px) {
    const [top, left, bottom, right] = parsed.box_px;
    return { box: [top / image.height * 1000, left / image.width * 1000, bottom / image.height * 1000, right / image.width * 1000], landmarks };
  }
  return { box: parsed.box_2d ?? parsed.faceBox ?? null, landmarks };
}

/**
 * Whether a located box can be a face: inside the grid, non-empty, about
 * face-shaped in pixels (an x/y swap on a portrait frame makes it a tall
 * sliver), and with any landmarks inside it, eyes above the mouth.
 */
export function plausibleFace(located: Located, image: { width: number; height: number }): boolean {
  const { box, landmarks } = located;
  if (!box || box.some(v => !Number.isFinite(v) || v < 0 || v > 1000)) return false;
  const [ymin, xmin, ymax, xmax] = box;
  if (!(ymax > ymin) || !(xmax > xmin)) return false;
  const heightPx = (ymax - ymin) / 1000 * image.height, widthPx = (xmax - xmin) / 1000 * image.width;
  const aspect = heightPx / widthPx;
  if (aspect < 0.7 || aspect > 2.2) return false;
  const slackY = (ymax - ymin) * 0.15, slackX = (xmax - xmin) * 0.15;
  const inside = (p: number[]) => p[0] >= ymin - slackY && p[0] <= ymax + slackY && p[1] >= xmin - slackX && p[1] <= xmax + slackX;
  const points = [landmarks.leftEye, landmarks.rightEye, landmarks.mouth].filter((p): p is number[] => Boolean(p));
  if (!points.every(inside)) return false;
  if (landmarks.mouth && [landmarks.leftEye, landmarks.rightEye].some(eye => eye && eye[0] >= landmarks.mouth![0])) return false;
  return true;
}

/**
 * The square cut around a detected face: the face box grown to take in the
 * hairline and hair length (identity cues the compose instruction names),
 * nudged up so the top of the hair is in, and kept inside the image. Pixels
 * of the source.
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

/** ffmpeg arguments that cut the face square from an image on disk and write a 768×768 PNG. */
export function faceCropArguments(input: string, rect: { x: number; y: number; size: number }) {
  return ["-v", "error", "-nostdin", "-i", input, "-frames:v", "1",
    "-vf", `crop=${rect.size}:${rect.size}:${rect.x}:${rect.y},scale=${FACE_CROP_PX}:${FACE_CROP_PX}:flags=lanczos,setsar=1`,
    "-f", "image2pipe", "-vcodec", "png", "-pix_fmt", "rgb24", "pipe:1"];
}

/** Cut the face square from an image and return the 768×768 PNG (through a temp file: execFile cannot feed stdin). */
export async function cropFacePng(image: Buffer, rect: { x: number; y: number; size: number }): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "face-"));
  try {
    // Named by type: an ffmpeg without the jpeg_pipe/png_pipe probes cannot open an extensionless image.
    const input = path.join(dir, image[0] === 0x89 ? "image.png" : "image.jpg");
    await writeFile(input, image);
    const { stdout } = await run("ffmpeg", faceCropArguments(input, rect), { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true }) as unknown as { stdout: Buffer };
    if (stdout.length < 100 || stdout[0] !== 0x89 || stdout[1] !== 0x50) throw new Error("The face crop could not be encoded.");
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
