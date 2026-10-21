"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exportVariantSet, makeVariantSet } from "@/lib/variants";
import { getCurrentUser } from "@/lib/workspace";

const safeId = (value: string) => /^[\w-]+$/.test(value);

/** "Make variants" (ADR 0063): the set is made and its page opens. */
export async function makeVariants(formData: FormData): Promise<void> {
  const reelId = String(formData.get("reelId") ?? "");
  if (!safeId(reelId)) redirect("/");
  const user = await getCurrentUser();
  const result = await makeVariantSet(user, reelId);
  if (!result.ok) redirect(`/reels/${reelId}/variants?error=${encodeURIComponent(result.message)}`);
  revalidatePath("/");
  const skipped = result.skipped.map((skip) => `${skip.hook}-${skip.lengthS}: ${skip.reason}`).join("\n");
  redirect(`/reels/${reelId}/variants?made=${result.made}${skipped ? `&skipped=${encodeURIComponent(skipped)}` : ""}`);
}

/**
 * "Export all", after the studio confirmed how many exports it uses: at
 * most that many start, under a per-workspace lock (`exportVariantSet`).
 */
export async function exportAllVariants(formData: FormData): Promise<void> {
  const groupId = String(formData.get("groupId") ?? "");
  const back = String(formData.get("back") ?? "");
  const confirmed = Math.max(0, Math.min(6, Math.floor(Number(formData.get("confirmed") ?? 0)) || 0));
  const page = safeId(back) ? `/reels/${back}/variants` : "/";
  const user = await getCurrentUser();
  const result = await exportVariantSet(user, groupId, confirmed);
  if (!result) redirect(`${page}?error=${encodeURIComponent("This set of variants was deleted.")}`);
  revalidatePath("/exports");
  redirect(`${page}?exported=${result.queued}${result.refused ? `&error=${encodeURIComponent(result.refused)}` : ""}`);
}
