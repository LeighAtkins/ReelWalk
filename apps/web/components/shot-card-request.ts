import { aiShotSchema } from "@reelwalk/core";
import { z } from "zod";

/** The exact card request is retained before POST, including resolved video boundaries. */
export const shotCardPayloadSchema = z.object({
  prompt: z.string().trim().min(10).max(2000),
  shot: aiShotSchema,
  durationSeconds: z.union([z.literal(4), z.literal(8)]),
  quality: z.literal("draft").optional(),
}).strict();
