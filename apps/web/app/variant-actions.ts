"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@reelwalk/db";
import { queueReelExport } from "@/lib/export-reel";
import { makeVariantSet } from "@/lib/variants";
import { getCurrentUser } from "@/lib/workspace";

/** "Make variants" (ADR 0063): the set is made and its page opens. */
export async function makeVariants(formData: FormData): Promise<void> {
  const reelId = String(formData.get("reelId") ?? "");
  if (!/^[\w-]+$/.test(reelId)) redirect("/");
  const user = await getCurrentUser();
  const result = await makeVariantSet(user, reelId);
  if (!result.ok) redirect(`/reels/${reelId}/variants?error=${encodeURIComponent(result.message)}`);
  revalidatePath("/");
  const skipped = result.skipped.map((skip) => `${skip.hook}-${skip.lengthS}: ${skip.reason}`).join("\n");
  redirect(`/reels/${reelId}/variants?made=${result.made}${skipped ? `&skipped=${encodeURIComponent(skipped)}` : ""}`);
}

/**
 * "Export all": queues an export of every variant in the set that has none
 * running and none newer than its last edit. The plan's export limits apply
 * to each one; the first refusal is reported.
 */
export async function exportAllVariants(formData: FormData): Promise<void> {
  const groupId = String(formData.get("groupId") ?? "");
  const back = String(formData.get("back") ?? "");
  const user = await getCurrentUser();
  const group = await prisma.variantGroup.findFirst({
    where: { id: groupId, workspaceId: user.workspaceId },
    include: { variants: { include: { reel: { select: { id: true, updatedAt: true, renderJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, createdAt: true } } } } } } },
  });
  const page = /^[\w-]+$/.test(back) ? `/reels/${back}/variants` : "/";
  if (!group) redirect(`${page}?error=${encodeURIComponent("This set of variants was deleted.")}`);
  let queued = 0;
  let refused: string | null = null;
  for (const variant of group.variants) {
    const last = variant.reel.renderJobs[0];
    if (last && last.status !== "FAILED" && last.createdAt >= variant.reel.updatedAt) continue;
    const result = await queueReelExport(user, variant.reel.id);
    if (result.ok) queued++;
    else {
      refused = result.message || result.issues.map((issue) => issue.message).join(" ") || "An export could not start.";
      break;
    }
  }
  revalidatePath("/exports");
  redirect(`${page}?exported=${queued}${refused ? `&error=${encodeURIComponent(refused)}` : ""}`);
}
