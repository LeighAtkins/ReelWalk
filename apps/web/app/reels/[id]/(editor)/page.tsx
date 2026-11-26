import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AI_BRIEFS, planSchema, referencedAssetIds, type Plan } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { Editor } from "@/components/editor/editor";
import { isFakeInstagram, isInstagramConfigured } from "@/lib/instagram";
import { isAiAvailable } from "@/lib/openai";
import { aiEditUsage } from "@/lib/ai-edit";
import { workspaceBrandKit } from "@/lib/brand-kit";
import { instagramSoundProblem } from "@/lib/instagram-sound";
import { toLibraryAssets } from "@/lib/library";
import { readTimeline } from "@/lib/reels";
import { getCurrentUser, mediaScope } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Edit reel · ReelWalk" };

export default async function EditReelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ library?: string; auto?: string }>;
}) {
  const { id } = await params;
  const { library: openLibrary, auto } = await searchParams;
  const user = await getCurrentUser();
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId } });
  if (!reel) notFound();

  const timeline = readTimeline(reel.timeline);
  const usedIds = referencedAssetIds(timeline);
  const aiOff = user.workspace.aiGeneration === "off";
  const canUseAi = isAiAvailable() && !aiOff;
  const hasInstagramSounds = isInstagramConfigured() || isFakeInstagram();
  // Everything this reel uses, recent uploads, Instagram sound availability, saved briefs,
  // AI usage and brand kit are independent reads — fetch them in parallel.
  const [used, recent, soundProblem, ownBriefs, aiUsage, brandKit] = await Promise.all([
    usedIds.length > 0
      ? prisma.mediaAsset.findMany({ where: { ...mediaScope(user.workspaceId), id: { in: usedIds } } })
      : Promise.resolve([]),
    prisma.mediaAsset.findMany({ where: mediaScope(user.workspaceId), orderBy: { createdAt: "desc" }, take: 120 }),
    hasInstagramSounds ? instagramSoundProblem(user.workspaceId) : Promise.resolve(null),
    canUseAi
      ? prisma.reelBrief.findMany({ where: { workspaceId: user.workspaceId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, text: true } })
      : Promise.resolve([]),
    aiEditUsage(user.workspaceId),
    workspaceBrandKit(user.workspaceId),
  ]);
  const unique = new Map([...recent, ...used].map((asset) => [asset.id, asset]));
  const rawAssets = [...unique.values()];

  // Floor plans of the tours this media belongs to — fetch in parallel with URL signing.
  const tourIds = [...new Set(rawAssets.map((asset) => asset.tourId).filter((value): value is string => value !== null))];
  const [library, tourRows] = await Promise.all([
    toLibraryAssets(rawAssets),
    tourIds.length > 0
      ? prisma.tour.findMany({ where: { id: { in: tourIds }, workspaceId: user.workspaceId } })
      : Promise.resolve([]),
  ]);
  const tours: Record<string, { name: string; plan: Plan }> = {};
  for (const tour of tourRows) {
    const plan = planSchema.safeParse(tour.plan);
    if (plan.success) tours[tour.id] = { name: tour.name, plan: plan.data };
  }

  // Instagram's sounds in the Music sheet (ADR 0019): not offered at all where
  // this deployment cannot reach Instagram; otherwise offered, or explained.
  const instagramSounds = hasInstagramSounds ? { problem: soundProblem } : null;
  // Ways of cutting a whole reel: the built-in briefs, then the studio's own.
  const briefs = canUseAi
    ? [...AI_BRIEFS.map((brief) => ({ ...brief, own: false })), ...ownBriefs.map((brief) => ({ ...brief, own: true }))]
    : [];

  return (
    <Editor
      key={reel.id}
      openLibrary={openLibrary === "1"}
      reel={{ id: reel.id, title: reel.title, revision: reel.revision, caption: reel.caption }}
      timeline={timeline}
      library={library}
      tours={tours}
      instagramSounds={instagramSounds}
      askAvailable={canUseAi}
      aiOff={aiOff}
      briefs={briefs}
      autopilot={auto === "1"}
      aiUsage={aiUsage}
      brandKit={brandKit}
    />
  );
}
