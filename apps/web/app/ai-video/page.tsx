import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@reelwalk/db";
import { AiVideoPanel } from "@/components/ai-video-panel";
import { TabBar } from "@/components/tab-bar";
import { getCurrentUser, mediaScope } from "@/lib/workspace";
import { toLibraryAssets } from "@/lib/library";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI video · ReelWalk" };

export default async function AiVideoPage() {
  const user = await getCurrentUser();
  if (user.workspace.aiGeneration === "off") {
    return <><main className="shell">
      <p className="small muted"><Link href="/account">Back to Account</Link></p>
      <h1>AI video</h1>
      <p className="muted" data-testid="ai-off-note">AI generation is turned off for {user.workspace.name}. An owner can turn it on under Account, Workspaces.</p>
    </main><TabBar /></>;
  }
  const photos = await prisma.mediaAsset.findMany({ where: { ...mediaScope(user.workspaceId), kind: "IMAGE", contentType: { in: ["image/jpeg", "image/png"] } }, orderBy: { createdAt: "desc" }, take: 100 });
  return <><main className="shell">
    <p className="small muted"><Link href="/account">Back to Account</Link></p>
    <h1>AI video</h1>
    <AiVideoPanel photos={await toLibraryAssets(photos)} />
  </main><TabBar /></>;
}
