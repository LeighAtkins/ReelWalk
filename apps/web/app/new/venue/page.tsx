import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@reelwalk/db";
import { BackIcon } from "@/components/icons";
import { VenueBuilder } from "@/components/venue-builder";
import { toLibraryAsset } from "@/lib/library";
import { isStockConfigured } from "@/lib/stock";
import { getCurrentUser, mediaScope } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Restaurant reel · ReelWalk" };

export default async function NewVenueReelPage() {
  const user = await getCurrentUser();
  const rows = await prisma.mediaAsset.findMany({
    where: { ...mediaScope(user.workspaceId), kind: { in: ["VIDEO", "IMAGE"] } },
    orderBy: [{ shared: "asc" }, { createdAt: "desc" }],
    take: 160,
  });
  const library = await Promise.all(rows.map(toLibraryAsset));

  return (
    <main className="shell">
      <header className="shell-head">
        <Link href="/" className="btn btn-quiet" prefetch={false}>
          <BackIcon size={18} />
          Reels
        </Link>
        <span className="muted small">{user.workspace.name}</span>
      </header>
      <h1 style={{ marginBottom: 4 }}>Restaurant or café reel</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Your dishes, your prices, cut to the beat. Thirty seconds from menu to reel.
      </p>
      <VenueBuilder library={library} stockConfigured={isStockConfigured()} />
    </main>
  );
}
