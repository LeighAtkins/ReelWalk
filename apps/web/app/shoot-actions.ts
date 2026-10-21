"use server";

import { shootRequestSchema } from "@reelwalk/core";
import { planShoot, type ShotListResult } from "@/lib/shoot";
import { getCurrentUser } from "@/lib/workspace";

/** "Plan my shoot" (ADR 0063): the shot list for a property, from the model or the standard one. */
export async function makeShotList(input: unknown): Promise<{ ok: true; list: ShotListResult } | { ok: false; message: string }> {
  const parsed = shootRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Pick the rooms you will film." };
  const user = await getCurrentUser();
  return { ok: true, list: await planShoot(user, parsed.data) };
}
