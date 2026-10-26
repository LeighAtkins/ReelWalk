import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { FACE_CROP_PX, MIN_GATE_FACE_PX, MIN_SPEAKING_FACE_PX, minFacePx } from "@reelwalk/core";

const run = promisify(execFile);

/**
 * Presenter identity (ADR 0056): the gate between a composed keyframe and the
 * paid Veo call, and the face crop a presenter kit is compared against.
 */

/** Below this the composite is recomposed, then refunded. */
export const IDENTITY_MIN_CONFIDENCE = 0.6;

/** The gate's face floors live in core (presenter.ts) so the editor's critic reads the same numbers (ADR 0062). */
export { MIN_GATE_FACE_PX, MIN_SPEAKING_FACE_PX, minFacePx };

/**
 * Whether an end of a voiced take is held to the speaking floor and composed
 * closer. A shouted Veo line over a described wide or action shot is not
 * lip-synced to a held face, so it keeps the asked framing and the silent floor.
 */
export function speakingEnd(voice: "lipsync" | "veo" | null | undefined, instruction: string): boolean {
  if (!voice) return false;
  return !(voice === "veo" && /\b(wide|action)\b/i.test(instruction));
}

/** The refund message for a take the gate refused, by the last reason: honest about what went wrong. */
export function identityRejectionMessage(end: "first" | "last", verdict: IdentityVerdict | null, minimum: number, speaking: boolean): string {
  const frame = end === "first" ? "start" : "end";
  const tail = "so the shot was not made. Your credit was returned.";
  if (!verdict) return `We couldn't check her face in the ${frame} frame, ${tail}`;
  if (verdict.reason === "no-face" || verdict.reason === "locate-failed") return `We couldn't find her face clearly in the ${frame} frame, ${tail}`;
  if (verdict.reason === "face-too-small") {
    return `Her face was too small to ${speaking ? "speak on camera" : "recognise"} (${verdict.faceHeightPx ?? "?"} px; needs ${minimum}), ${tail}`;
  }
  if (verdict.samePerson && verdict.confidence >= IDENTITY_MIN_CONFIDENCE && verdict.eyesAndMouthRendered !== true) return `Her eyes or mouth weren't clearly drawn in the ${frame} frame, ${tail}`;
  return `It didn't look like her (score ${verdict.confidence.toFixed(2)}), ${tail}`;
}

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
  rejected?: "no-face" | "implausible-box" | "face-not-in-crop" | "face-too-small" | "unparseable";
  crop?: { x: number; y: number; size: number };
  faceHeightPx?: number;
  /**
   * The box found again inside a square cut around this one (`refineCropRect`), read back onto the composite's grid
   * (ADR 0089 round 3). On a wide 1080×1920 composite with a small face the first box can sit well above her head and be
   * nearly twice her face; the second look, on a picture where the face is large, lands on it. Used for placing type,
   * never for the gate's own decision.
   */
  refined?: number[];
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

const finite = z.number().finite();
const point = z.array(finite).length(2);
const locateSchema = z.object({
  box_2d: z.array(finite).length(4).nullable().optional(),
  faceBox: z.array(finite).length(4).nullable().optional(),
  box_px: z.array(finite).length(4).nullable().optional(),
  left_eye: point.nullable().optional(), right_eye: point.nullable().optional(), mouth: point.nullable().optional(),
}).passthrough();
export type Located = { box: number[] | null; landmarks: { leftEye?: number[]; rightEye?: number[]; mouth?: number[] } };

/**
 * Read a locate answer onto the 0–1000 grid. Gemini sometimes answers with
 * a list (one entry per face); the largest plausible face is hers. Throws on
 * an answer that is not a box at all, which the caller records as
 * "unparseable" before trying the next mode.
 */
export function readLocate(raw: unknown, image: { width: number; height: number }): Located {
  const entries = Array.isArray(raw) ? raw : [raw];
  const candidates = entries.map(entry => {
    const parsed = locateSchema.parse(entry);
    const landmarks = { ...(parsed.left_eye ? { leftEye: parsed.left_eye } : {}), ...(parsed.right_eye ? { rightEye: parsed.right_eye } : {}), ...(parsed.mouth ? { mouth: parsed.mouth } : {}) };
    if (parsed.box_px) {
      const [top, left, bottom, right] = parsed.box_px;
      return { box: [top / image.height * 1000, left / image.width * 1000, bottom / image.height * 1000, right / image.width * 1000], landmarks };
    }
    return { box: parsed.box_2d ?? parsed.faceBox ?? null, landmarks };
  });
  if (!candidates.length) return { box: null, landmarks: {} };
  const area = (c: Located) => c.box ? (c.box[2] - c.box[0]) * (c.box[3] - c.box[1]) : -1;
  const plausible = candidates.filter(c => plausibleFace(c, image)).sort((a, b) => area(b) - area(a));
  return plausible[0] ?? candidates.find(c => c.box) ?? candidates[0];
}

/**
 * Whether a located box can be a face: inside the grid, non-empty, about
 * face-shaped in pixels (an x/y swap on a portrait frame makes it a tall
 * sliver), and with any landmarks inside it, eyes above the mouth.
 */
export function plausibleFace(located: Located, image: { width: number; height: number }): boolean {
  const { box, landmarks } = located;
  if (!box || box.length !== 4 || box.some(v => !Number.isFinite(v) || v < 0 || v > 1000)) return false;
  // A box normalised to 0–1 instead of 0–1000 would be read as a dot in the corner.
  if (box.every(v => v <= 1)) return false;
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

/**
 * The square the face is looked for again in (ADR 0089 round 3): three times the first box's larger side, centred on
 * it, inside the image. Wide enough that a first box off by its own height still has the face in it. Pixels of the source.
 */
export function refineCropRect(faceBox: number[], width: number, height: number): { x: number; y: number; size: number } {
  const [ymin, xmin, ymax, xmax] = faceBox;
  const top = ymin / 1000 * height, bottom = ymax / 1000 * height, left = xmin / 1000 * width, right = xmax / 1000 * width;
  const size = Math.min(width, height, Math.max(64, Math.round(3 * Math.max(bottom - top, right - left))));
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(value)));
  return { x: clamp((left + right) / 2 - size / 2, width - size), y: clamp((top + bottom) / 2 - size / 2, height - size), size };
}

/** A box found on the 0–1000 grid of a square cut (`rect`, pixels of a `width`×`height` image) read back onto that image's grid. */
export function boxFromCrop(cropBox: number[], rect: { x: number; y: number; size: number }, width: number, height: number): number[] {
  const [ymin, xmin, ymax, xmax] = cropBox;
  const toY = (v: number) => Math.round(((rect.y + (v / 1000) * rect.size) / height) * 10000) / 10;
  const toX = (v: number) => Math.round(((rect.x + (v / 1000) * rect.size) / width) * 10000) / 10;
  return [toY(ymin), toX(xmin), toY(ymax), toX(xmax)];
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
