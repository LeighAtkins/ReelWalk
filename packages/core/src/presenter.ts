import { z } from "zod";

/**
 * Presenter identity kit (ADR 0056). Every composed AI take is made from a
 * workspace's real presenter stills, never from another generated take:
 * each generated hop re-synthesises the face, and three hops deep the
 * villa reel's presenter had become a different woman.
 */

/** Generated takes are stored as media assets whose id is `ai-<generation id>`. */
export const isGeneratedAssetId = (assetId: string) => assetId.startsWith("ai-");

export const CHAINED_REFERENCE_MESSAGE = "Pick the presenter kit, not a generated take — faces drift when takes are chained.";

/** Medium keeps her face large enough to hold identity (about 180 px or more at 1080×1920); wide is for arrivals and stunts. */
export const PRESENTER_FRAMINGS = ["medium", "wide"] as const;
export type PresenterFraming = typeof PRESENTER_FRAMINGS[number];

/** The framing a composed still uses: what was asked for, else wide only when the description says so. */
export function defaultFraming(descriptions: (string | null | undefined)[]): PresenterFraming {
  return descriptions.some(text => text && /\bwide\b/i.test(text)) ? "wide" : "medium";
}

/** What the image model is told about framing, so a voiced take has a face Veo can keep. */
export function framingInstruction(framing: PresenterFraming): string {
  return framing === "medium"
    ? "Frame her as a medium shot: the top of her head about a quarter of the way down the frame and her knees near the bottom edge, so her face is at least 180 px tall at 1080×1920 and clearly lit. Keep the scene's camera position; tighten only as much as that needs."
    : "Wide framing: keep the scene's full composition; she may be small, but her face must stay sharp, front-lit and unobstructed.";
}

/** The face crop is a square PNG this many pixels a side. */
export const FACE_CROP_PX = 768;
/** A portrait whose face is shorter than this still works, but the crop is upscaled and soft. */
export const PORTRAIT_FACE_MIN_PX = 400;

const assetId = z.string().trim().min(1).max(64);
export const presenterInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  portraitAssetId: assetId,
  fullBodyAssetId: assetId,
  voice: z.string().trim().min(1).max(100).nullable().optional(),
  isDefault: z.boolean().optional(),
});
export const presenterUpdateSchema = presenterInputSchema.partial().extend({
  /** Try the face crop again after it gave up. */
  retry: z.literal(true).optional(),
}).refine(update => Object.keys(update).length > 0, "Change at least one thing.");

/** Face-crop attempts before a kit gives up and says so. */
export const PRESENTER_CROP_MAX_TRIES = 3;
export const PRESENTER_CROP_GAVE_UP = "Her face reference could not be made. Tap Retry, or choose another portrait.";
export type PresenterInput = z.infer<typeof presenterInputSchema>;

/** Where a kit stands, for the picker; retry is offered once it has failed. */
export function presenterStatus(kit: { faceCropKey: string | null; faceCropError: string | null; faceHeightPx: number | null; faceCropTries?: number; leaseUntil?: Date | null }, now = new Date()): { ready: boolean; label: string; canRetry?: boolean } {
  if (kit.faceCropKey) {
    return kit.faceHeightPx !== null && kit.faceHeightPx < PORTRAIT_FACE_MIN_PX
      ? { ready: true, label: `Ready · the portrait's face is ${kit.faceHeightPx} px tall; a closer head-and-shoulders photo (face ${PORTRAIT_FACE_MIN_PX} px or more) holds her likeness better` }
      : { ready: true, label: "Ready" };
  }
  if (kit.faceCropError) return { ready: false, label: kit.faceCropError, canRetry: true };
  // Tries used up and no live claim: the worker died on the last one. It will be settled; say so now.
  if ((kit.faceCropTries ?? 0) >= PRESENTER_CROP_MAX_TRIES && (!kit.leaseUntil || kit.leaseUntil < now)) return { ready: false, label: PRESENTER_CROP_GAVE_UP, canRetry: true };
  return { ready: false, label: "Preparing her face reference…" };
}

/**
 * How many generated hops a reference is from a real one (ADR 0056): 0 for
 * the kit or real footage, the source take's depth + 1 for a generated take.
 * A take made before depths were recorded counts as one hop.
 */
export function referenceDepthOf(reference: { kit: true } | { assetId: string; sourceDepth: number | null | undefined }): number {
  if ("kit" in reference) return 0;
  return isGeneratedAssetId(reference.assetId) ? (reference.sourceDepth ?? 0) + 1 : 0;
}
