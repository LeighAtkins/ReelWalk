import { z } from "zod";
import { nanoCinematographyPrompt, shotCinematographySchema, videoCinematographyPrompt } from "./shot-cinematography";
import { furnitureStagePrompt, furnitureStageSchema } from "./furniture-stage";

export const CAMERA_KEYFRAME_MODEL = "gemini-3-pro-image";
export const CAMERA_KEYFRAME_HOLD_CENTS = 100;
export const CAMERA_KEYFRAME_CREDITS = 1;
/** Bounded creative camera guidance, not surveyed or reconstructed travel. */
export const CAMERA_KEYFRAME_MAX_DISTANCE_M = 100;
export const CAMERA_KEYFRAME_MOVES = [
  { id: "shift-right", label: "Move right" }, { id: "shift-left", label: "Move left" },
  { id: "push-in", label: "Move forward" }, { id: "pull-back", label: "Move backward" },
  { id: "rise", label: "Drone rise" }, { id: "orbit", label: "Gentle orbit" },
] as const;
export type CameraKeyframeMove = (typeof CAMERA_KEYFRAME_MOVES)[number]["id"];
const frame = z.object({ assetId: z.string().min(1).max(128), atMs: z.literal(0) }).strict();
export const cameraKeyframeGenerateSchema = z.object({
  action: z.literal("generate"), requestId: z.string().uuid(), role: z.enum(["start", "end"]), source: frame,
  continuity: frame.optional(), move: z.enum(["shift-right", "shift-left", "push-in", "pull-back", "rise", "orbit"]),
  distanceM: z.number().min(0.5).max(CAMERA_KEYFRAME_MAX_DISTANCE_M), durationSeconds: z.union([z.literal(4), z.literal(8)]),
  prompt: z.string().trim().max(600).optional(),
  cinematography: shotCinematographySchema.optional(),
  furnitureStage: furnitureStageSchema.optional(),
  guidedPair: z.object({ version: z.literal(1), id: z.string().uuid(), endRequestId: z.string().uuid() }).strict().optional(),
}).strict();
export type CameraKeyframeGenerateInput = z.infer<typeof cameraKeyframeGenerateSchema>;
export type CameraKeyframeInput = Omit<CameraKeyframeGenerateInput, "action" | "requestId">;
/** Cross-field checks stay separate so legacy callers can still omit/strip the object schema. */
export function guidedKeyframeError(input: CameraKeyframeInput, requestId: string): string | null {
  if (input.furnitureStage && (input.guidedPair || input.continuity || input.role !== "end")) return "A furniture concept uses one original photo and one image request, without a camera pair.";
  if (!input.guidedPair) return null;
  if (input.role !== "start") return "A guided pair must begin with a Start image.";
  if (input.guidedPair.endRequestId === requestId) return "Start and End must use distinct saved request identifiers.";
  if (!input.cinematography) return "A guided pair needs its frozen cinematography recipe.";
  return null;
}
export function guidedPairEndInput(start: CameraKeyframeInput, startAssetId: string): CameraKeyframeInput {
  const input = cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).strip().parse(start);
  delete input.guidedPair;
  return { ...input, role: "end", source: { ...start.source }, continuity: { assetId: startAssetId, atMs: 0 } };
}
export type CameraKeyframeStatus = "QUEUED" | "SUBMITTING" | "UNKNOWN" | "CANDIDATE" | "USED" | "FAILED";
export type CameraKeyframeJob<Asset = unknown> = {
  id: string; requestId: string; status: CameraKeyframeStatus; requestHash: string; input: CameraKeyframeInput;
  sourceUrl: string | null; continuityUrl: string | null; candidateUrl: string | null; asset: Asset | null;
  error: string | null; credits: 1; creditRefunded?: boolean; heldCostCents: number; model: typeof CAMERA_KEYFRAME_MODEL; createdAt: string;
  submittedAt?: string | null; sourceFraming?: "full-reference" | "portrait-crop"; continuationError?: string | null;
};
const direction: Record<CameraKeyframeMove, string> = {
    "shift-right": "translate to the camera's right, keeping a level lens and the property in view",
    "shift-left": "translate to the camera's left, keeping a level lens and the property in view",
    "push-in": "move forward gently toward the visible property", "pull-back": "move backward gently from the visible property",
    rise: "rise vertically like a slow drone, tilting only enough to retain the property", orbit: "make a gentle arc around the visible property",
};
export function cameraKeyframeVideoPrompt(input: CameraKeyframeInput, hasEnd = true): string {
  const legacy = `One continuous smooth camera move from the supplied Start frame${hasEnd ? " to the supplied End frame" : ""}: ${direction[input.move]}, approximately ${input.distanceM} metres over ${input.durationSeconds} seconds. Distance is approximate creative intent, not surveyed geometry. Preserve the source property's architecture, proportions, materials and objects. Preserve lighting unless explicitly requested otherwise below. Natural photographic finish; no extra edge enhancement. No morphing, teleporting, cuts or invented buildings. ${input.prompt ?? ""}`.trim();
  return input.cinematography ? `${legacy} ${videoCinematographyPrompt(input.cinematography, hasEnd)}` : legacy;
}
export function cameraKeyframePrompt(input: CameraKeyframeInput): string {
  if (input.furnitureStage) return furnitureStagePrompt(input.furnitureStage);
  return [
    input.cinematography ? "Create one photorealistic portrait 9:16 architectural video keyframe from image 1, the full reference photograph. Compose the portrait view from its visible architecture rather than assuming the reference was already cropped." : "Create one photorealistic portrait 9:16 architectural video keyframe from image 1, the source view.",
    input.role === "start" ? input.cinematography ? "This is the starting view: retain the source camera position and property identity. Prepare a coherent portrait composition for the planned camera move below." : "This is the starting view: retain the source camera position and framing. Prepare the image for the planned camera move below." : "This is the ending view after the planned camera move below.",
    `Camera intent: ${direction[input.move]}, approximately ${input.distanceM} metres over ${input.durationSeconds} seconds. These are approximate creative directions, not surveyed or reconstructed geometry.`,
    input.continuity ? `${input.cinematography ? "Image 2 is the prepared Start" : "Image 2 is the accepted Start"} and the origin of the camera move. Image 1 is another source view of the same property, supplying visible details for this endpoint. Move approximately from Image 2 toward the requested End; do not apply a second camera move to Image 1. Keep one coherent property, architecture, materials, furniture and landscaping.` : "Keep the source property's architecture, materials, furniture and landscaping consistent.",
    "Preserve the source lighting unless the user's additional instruction explicitly requests a time-of-day or lighting change.",
    "Preserve tile grids, rooflines, openings, proportions and visible objects. Natural photographic finish; no extra edge enhancement. Do not add buildings or invented landmarks. Reveal only plausible immediate surroundings. No text, people, logos or watermarks.",
    input.prompt ?? "",
    input.cinematography ? nanoCinematographyPrompt(input.cinematography) : "",
  ].filter(Boolean).join(" ");
}
