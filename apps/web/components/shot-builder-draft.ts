import { z } from "zod";
import { AI_SHOT_MODES, AI_SHOT_STYLES, AI_SHOT_ATMOSPHERES, MOVE_IDS } from "@reelwalk/core";

const selection = z.string().max(160).refine(value => !value || /^(asset|clip):[\w-]+$/.test(value));
/** Only editable choices are stored here; image bytes, signed URLs and approvals remain server-owned. */
export const shotBuilderDraftSchema = z.object({
  version: z.literal(1), photo: selection, last: selection, startBase: selection, endBase: selection,
  firstMs: z.number().int().min(0), lastMs: z.number().int().min(0),
  generatedStart: z.boolean(), generatedEnd: z.boolean(), useEndReference: z.boolean(),
  direction: z.enum(["shift-right", "shift-left", "push-in", "pull-back", "rise", "orbit"]).nullable(),
  distanceM: z.number().min(0.5).max(10), chosenSeconds: z.union([z.literal(4), z.literal(8)]).nullable(),
  frameNotes: z.string().max(600), prompt: z.string().max(2000), mode: z.enum(AI_SHOT_MODES),
  move: z.union([z.enum(MOVE_IDS), z.literal("")]), quality: z.enum(["draft", "final"]),
  style: z.enum(AI_SHOT_STYLES), atmosphere: z.enum(AI_SHOT_ATMOSPHERES), energy: z.enum(["subtle", "bold"]),
  harmonize: z.boolean(), polish: z.boolean(), draft: z.boolean(),
}).strict();

export function shotBuilderRecoveryKey(reelId?: string, clipId?: string): string {
  return `shot-builder:${reelId ?? "library"}:${clipId ?? "new"}`;
}
