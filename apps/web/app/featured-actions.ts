"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { normalizeHandle } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { getCurrentUser } from "@/lib/workspace";

/** Only same-site paths may be the place to return to. */
function safeBack(value: unknown, fallback: string): string {
  const path = typeof value === "string" ? value : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : fallback;
}

/**
 * "Feature my reel" (ADR 0016): the owner lets ReelWalk repost the export
 * on @reelwalking and the site, with a handle to credit. Ticking stores the
 * moment of consent; unticking clears it. Both from the same checkbox.
 */
export async function setFeatureConsent(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const reelId = String(formData.get("reelId") ?? "");
  const consent = formData.get("consent") === "yes";
  const typed = String(formData.get("handle") ?? "").trim();
  const handle = normalizeHandle(typed);
  // Something was typed but it is not a handle: keep whatever was stored and say so.
  const badHandle = typed !== "" && handle === null;
  const back = safeBack(formData.get("back"), `/reels/${reelId}/export`);

  const reel = await prisma.reel.findFirst({ where: { id: reelId, workspaceId: user.workspaceId }, select: { id: true, featureConsent: true } });
  if (!reel) redirect(back);
  await prisma.reel.update({
    where: { id: reel.id },
    data: {
      featureConsent: consent,
      featureHandle: badHandle ? undefined : handle,
      featureConsentAt: consent ? (reel.featureConsent ? undefined : new Date()) : null,
    },
  });
  revalidatePath(`/reels/${reel.id}/export`);
  const url = new URL(back, "http://x");
  url.searchParams.set("featured", badHandle ? "badhandle" : consent ? "on" : "off");
  redirect(`${url.pathname}${url.search}${url.hash}`);
}
