import { z } from "zod";
import { AI_SHOT_MODES, AI_SHOT_STYLES, AI_SHOT_ATMOSPHERES, MOVE_IDS } from "@reelwalk/core";
import { CAMERA_KEYFRAME_MAX_DISTANCE_M, shotCinematographySchema, furnitureStageSchema } from "@reelwalk/core";

import { cameraSketchSchema } from "./camera-sketch";

const selection = z.string().max(160).refine(value => !value || /^(asset|clip):[\w-]+$/.test(value));
/** Only editable choices are stored here; image bytes, signed URLs and approvals remain server-owned. */
export const shotBuilderDraftSchema = z.object({
  version: z.literal(1), photo: selection, last: selection, startBase: selection, endBase: selection,
  firstMs: z.number().int().min(0), lastMs: z.number().int().min(0),
  generatedStart: z.boolean(), generatedEnd: z.boolean(), useEndReference: z.boolean(),
  direction: z.enum(["shift-right", "shift-left", "push-in", "pull-back", "rise", "orbit"]).nullable(),
  distanceM: z.number().min(0.5).max(CAMERA_KEYFRAME_MAX_DISTANCE_M), chosenSeconds: z.union([z.literal(4), z.literal(8)]).nullable(),
  frameNotes: z.string().max(600), prompt: z.string().max(2000), mode: z.enum(AI_SHOT_MODES),
  move: z.union([z.enum(MOVE_IDS), z.literal("")]), quality: z.enum(["draft", "final"]),
  style: z.enum(AI_SHOT_STYLES), atmosphere: z.enum(AI_SHOT_ATMOSPHERES), energy: z.enum(["subtle", "bold"]),
  harmonize: z.boolean(), polish: z.boolean(), draft: z.boolean(),
  workflow: z.enum(["guided", "manual"]).optional(),
  furnitureStage: furnitureStageSchema.optional(),
  furnitureSource: selection.optional(),
  furnitureSelection: z.object({ sourceAssetId: z.string().min(1).max(128), assetId: z.string().min(1).max(128), inputKey: z.string().max(6000) }).strict().optional(),
  cameraSketch: cameraSketchSchema.optional(),
  startOnly: z.boolean().optional(),
  reviewedStart: z.string().max(6000).optional(),
  cinematography: shotCinematographySchema.optional(),
  reviewedPair: z.object({ pairId: z.string().uuid(), inputKey: z.string().max(6000), startAssetId: z.string().max(128), endAssetId: z.string().max(128) }).strict().optional(),
}).strict();

export function shotBuilderRecoveryKey(reelId?: string, clipId?: string): string {
  return `shot-builder:${reelId ?? "library"}:${clipId ?? "new"}`;
}
