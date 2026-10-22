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

/**
 * The smallest face the identity gate will judge, hairline to chin at
 * 1080×1920: below this the identity is the image model's invention, which
 * is the defect (ADR 0056). A speaking take needs more: Veo and lip sync
 * animate the eyes and mouth. Calibrated on production: cmvi3jstp's start
 * frame, whose take came back with good eyes and mouth, has her face 180 px
 * hairline to chin; the floor sits a little below it. One source of truth
 * for the worker's gate and the editor's critic (ADR 0062).
 */
export const MIN_GATE_FACE_PX = 120;
export const MIN_SPEAKING_FACE_PX = 165;
export const minFacePx = (speaking: boolean) => speaking ? MIN_SPEAKING_FACE_PX : MIN_GATE_FACE_PX;

/**
 * How close she is composed (ADR 0056, 0069). Medium keeps her face about
 * 180 px or more at 1080×1920; wide is for arrivals and stunts. Close and
 * tight (ADR 0069) are for spoken lines: the composed face must be large
 * enough for Veo to keep eyes, irises and a mouth, and the lever that
 * decides its size is the plate, not the wording. Close and tight crop the
 * plate before compose (see `plateCropRect`).
 */
export const PRESENTER_FRAMINGS = ["tight", "close", "medium", "wide"] as const;
export type PresenterFraming = typeof PRESENTER_FRAMINGS[number];
/** The face height, hairline to chin at 1080×1920, each framing aims for (0: no aim). */
export const FRAMING_FACE_PX: Record<PresenterFraming, number> = { tight: 420, close: 300, medium: 180, wide: 0 };
/** Closest first: the order escalation walks. */
const CLOSENESS: Record<PresenterFraming, number> = { tight: 3, close: 2, medium: 1, wide: 0 };

/**
 * The framing a composed still uses: what was asked for, else wide only when
 * the description says so, else close for a spoken line (ADR 0069: at medium
 * the composed face came out 150–200 px and Veo had no eyes to keep) and
 * medium for a silent one.
 */
export function defaultFraming(descriptions: (string | null | undefined)[], voiced = false): PresenterFraming {
  if (descriptions.some(text => text && /\bwide\b/i.test(text))) return "wide";
  return voiced ? "close" : "medium";
}

/** A speaking end is composed at least close, whatever was asked (a shouted wide line is decided by the caller). */
export function speakingFraming(framing: PresenterFraming): PresenterFraming {
  return CLOSENESS[framing] >= CLOSENESS.close ? framing : "close";
}

/** One step closer after a face too small to judge: wide and medium go to close, close to tight, tight stays. */
export function escalateFraming(framing: PresenterFraming): PresenterFraming {
  return framing === "tight" ? "tight" : framing === "close" ? "tight" : "close";
}

/**
 * The plate crop before compose (ADR 0069). A spoken line needs her face
 * 300 px or more in the composed 1080×1920 frame, and the image model sizes
 * her against the plate's furniture: at full frame it keeps her "at true
 * scale against the door" and her face lands at 150–200 px. Cropping the
 * plate is a digital zoom: the same camera position with a longer lens, so
 * perspective is unchanged and she can stand nearer the camera than
 * everything in it without looking pasted on. The window sits a little
 * below centre so the floor she stands on stays in the crop, which puts her
 * head in the top quarter after compose. Close is 1.6× (calibrated on
 * cmvi3jstp: a 1.6× plate gave a 300+ px face), tight 2.25×; a 1080×1920
 * plate at 1.6× keeps 675×1200 of real pixels, so the plate is never
 * upscaled more than the composite's own resampling already does.
 */
export const PLATE_CROPS: Record<PresenterFraming, { zoom: number; centreY: number }> = {
  tight: { zoom: 2.25, centreY: 0.58 }, close: { zoom: 1.6, centreY: 0.56 }, medium: { zoom: 1, centreY: 0.5 }, wide: { zoom: 1, centreY: 0.5 },
};
export function plateCropRect(framing: PresenterFraming, width = 1080, height = 1920): { x: number; y: number; width: number; height: number; zoom: number } {
  const { zoom, centreY } = PLATE_CROPS[framing];
  if (zoom <= 1) return { x: 0, y: 0, width, height, zoom: 1 };
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  const w = even(width / zoom), h = even(height / zoom);
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(value)));
  return { x: clamp((width - w) / 2, width - w), y: clamp(centreY * height - h / 2, height - h), width: w, height: h, zoom };
}

/** What the image model is told about framing, so a voiced take has a face Veo can keep. */
export function framingInstruction(framing: PresenterFraming): string {
  switch (framing) {
    case "tight":
      return "Tight shot: she stands about 1.5 m from the camera, nearer than everything in the scene, framed chest-up with the top of her head near the top edge, so her face is at least 440 px tall from hairline to chin at 1080×1920; both eyes with visible irises and whites, and her mouth, sharp and clearly drawn. The scene is a backdrop behind her at its own perspective; do not shrink her to match its furniture.";
    case "close":
      return "Close shot: she stands about 2 m from the camera, nearer than everything in the scene, framed waist-up with the top of her head about a sixth of the way down, so her face is at least 320 px tall from hairline to chin at 1080×1920; both eyes with visible irises and whites, and her mouth, sharp and clearly drawn. The scene stays behind her at its own perspective; do not shrink her to match its furniture.";
    case "medium":
      return "Frame her as a medium shot: the top of her head about a quarter of the way down the frame and her knees near the bottom edge, so her face is at least 180 px tall at 1080×1920 and clearly lit. Keep the scene's camera position; tighten only as much as that needs.";
    default:
      return "Wide framing: keep the scene's full composition; she may be small, but her face must stay sharp, front-lit and unobstructed.";
  }
}

/** Whether her feet are in the composed frame (medium and wide): the floor rule applies only then. */
export const feetInFrame = (framing: PresenterFraming) => framing === "medium" || framing === "wide";

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
