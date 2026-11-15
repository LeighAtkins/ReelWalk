import { z } from "zod";

/** Creative prompt guidance, rather than calibrated camera or light settings. */
export const shotCinematographySchema = z.object({
  version: z.literal(1),
  lensMm: z.union([z.literal("source"), z.literal(24), z.literal(35), z.literal(50)]),
  whiteBalanceKelvin: z.union([z.literal("source"), z.number().int().min(2500).max(7500)]),
}).strict();

export type ShotCinematography = z.infer<typeof shotCinematographySchema>;

export const DEFAULT_SHOT_CINEMATOGRAPHY: Readonly<ShotCinematography> = Object.freeze({
  version: 1,
  lensMm: "source",
  whiteBalanceKelvin: "source",
});

/** Establish the same photographic treatment in both Nano keyframes. */
export function nanoCinematographyPrompt(look: ShotCinematography): string {
  const parsed = shotCinematographySchema.parse(look);
  return [
    "Natural architectural photography with straight verticals, deep focus and restrained contrast. Preserve the property's proportions, materials, furniture and light direction; no extra sharpening or artificial HDR.",
    parsed.lensMm === "source"
      ? "Match the source's optical perspective and field of view; do not introduce wide-angle stretching."
      : `Use a natural ${parsed.lensMm} mm-equivalent lens look as creative guidance, preserving believable architectural proportions; no fisheye distortion.`,
    parsed.whiteBalanceKelvin === "source"
      ? "Match the source's white balance and exposure. Keep the same time of day unless the requested scene change says otherwise."
      : `Use a consistent ${parsed.whiteBalanceKelvin} K camera white-balance look in both keyframes as creative guidance. Retain the source light direction and time of day unless the requested scene change says otherwise.`,
  ].join(" ");
}

/** The supplied frames establish the look; Veo should animate it, not reinterpret it. */
export function videoCinematographyPrompt(look: ShotCinematography): string {
  shotCinematographySchema.parse(look);
  return "Preserve the supplied Start and End frames' optical perspective, white balance, exposure and natural photographic finish throughout the camera move. Do not introduce a new lens, relight the scene, add sharpening, pump focus or shift exposure beyond any scene change already shown in the frames.";
}
