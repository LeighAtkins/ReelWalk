import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { referencedAssetIds } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { Editor } from "@/components/editor/editor";
import { toLibraryAsset } from "@/lib/library";
import { readTimeline } from "@/lib/reels";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Edit reel · ReelWalk" };

export default async function EditReelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ library?: string }>;
}) {
  const { id } = await params;
  const { library: openLibrary } = await searchParams;
  const user = await getCurrentUser();
  const reel = await prisma.reel.findFirst({ where: { id, workspaceId: user.workspaceId } });
  if (!reel) notFound();

  const timeline = readTimeline(reel.timeline);
  // Everything this reel uses, plus recent uploads to reuse.
  const [used, recent] = await Promise.all([
    prisma.mediaAsset.findMany({ where: { workspaceId: user.workspaceId, id: { in: referencedAssetIds(timeline) } } }),
    prisma.mediaAsset.findMany({ where: { workspaceId: user.workspaceId }, orderBy: { createdAt: "desc" }, take: 120 }),
  ]);
  const unique = new Map([...recent, ...used].map((asset) => [asset.id, asset]));
  const library = await Promise.all([...unique.values()].map(toLibraryAsset));

  return (
    <Editor
      key={reel.id}
      openLibrary={openLibrary === "1"}
      reel={{ id: reel.id, title: reel.title, revision: reel.revision, caption: reel.caption }}
      timeline={timeline}
      library={library}
    />
  );
}
