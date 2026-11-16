import { z } from "zod";

export const FURNITURE_STYLES = [
  { id: "warm-minimal", label: "Warm minimal" },
  { id: "modern-coastal", label: "Modern coastal" },
  { id: "classic-luxury", label: "Classic luxury" },
] as const;
export const furnitureStageSchema = z.object({
  version: z.literal(1),
  style: z.enum(["warm-minimal", "modern-coastal", "classic-luxury"]),
  region: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(.02).max(1), height: z.number().min(.02).max(1) }).strict()
    .refine(r => r.x + r.width <= 1 && r.y + r.height <= 1, "Keep the complete furnishing area inside the photo."),
  instructions: z.string().trim().max(300).default(""),
}).strict();
export type FurnitureStage = z.infer<typeof furnitureStageSchema>;

export function furnitureStagePixels(stage: FurnitureStage, width: number, height: number) {
  const { region: r } = furnitureStageSchema.parse(stage);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw Error("Image dimensions are invalid.");
  const left = Math.floor(r.x * width), top = Math.floor(r.y * height);
  return { left, top, width: Math.min(width, Math.ceil((r.x + r.width) * width)) - left, height: Math.min(height, Math.ceil((r.y + r.height) * height)) - top };
}

export function furnitureStagePrompt(stage: FurnitureStage): string {
  const value = furnitureStageSchema.parse(stage), r = value.region;
  const style = FURNITURE_STYLES.find(item => item.id === value.style)!.label;
  return [
    "Edit image 1, the exact portrait reference photograph, into one photorealistic virtual furnishing concept at the SAME camera position, framing and focal length. Do not move or zoom the camera.",
    `Only replace or add movable furniture and decor inside this rectangular region: left ${(r.x * 100).toFixed(2)}%, top ${(r.y * 100).toFixed(2)}%, width ${(r.width * 100).toFixed(2)}%, height ${(r.height * 100).toFixed(2)}%. Keep furniture and its shadows entirely within the region.`,
    `Furniture style: ${style}. Choose coherent, realistically sized furnishings and restrained architectural photography.`,
    "Retain every fixed architectural element, including walls, doors, windows, rooflines, flooring, tile grids, built-in cabinets, pools and exterior views. Preserve their exact positions, materials, light direction, exposure and white balance. Preserve every pixel outside the selected region; that area will be restored from the original photograph.",
    "Do not remove defects, enlarge rooms, add openings or structural features. No people, text, logo or watermark. This is a disclosed furniture concept, not a photograph of the current property.",
    value.instructions ? `Additional furniture preference (subject to the restrictions above): ${value.instructions}` : "",
  ].filter(Boolean).join(" ");
}
