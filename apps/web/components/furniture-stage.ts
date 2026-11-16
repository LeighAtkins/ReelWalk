import { cameraKeyframeGenerateSchema, furnitureStageSchema, type CameraKeyframeInput, type FurnitureStage } from "@reelwalk/core";
export const DEFAULT_FURNITURE_STAGE: FurnitureStage = { version: 1, style: "warm-minimal", region: { x: .1, y: .45, width: .8, height: .45 }, instructions: "" };
/** Fixed camera fields satisfy the shared envelope; furniture prompting never treats them as a camera move. */
export function furnitureConceptInput(assetId: string, stage: FurnitureStage): CameraKeyframeInput {
  return cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).parse({ role: "end", source: { assetId, atMs: 0 }, move: "push-in", distanceM: .5, durationSeconds: 4, furnitureStage: furnitureStageSchema.parse(stage) });
}
export function furnitureRegion(a: { x: number; y: number }, b: { x: number; y: number }): FurnitureStage["region"] | null {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const x = Math.min(clamp(a.x), clamp(b.x)), y = Math.min(clamp(a.y), clamp(b.y));
  const width = Math.max(clamp(a.x), clamp(b.x)) - x, height = Math.max(clamp(a.y), clamp(b.y)) - y;
  if (width < .02 || height < .02) return null;
  return { x, y, width, height };
}
