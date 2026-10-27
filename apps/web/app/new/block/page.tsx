import type { Metadata } from "next";
import Link from "next/link";
import { BackIcon } from "@/components/icons";
import { WalkBlock } from "@/components/walk-block";
import { findBlockClip } from "@/lib/walk-block";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Walk the block · ReelWalk" };

/** Walk the block (ADR 0093). `?asset=<id>` starts from a drone clip already in the library. */
export default async function WalkTheBlockPage({ searchParams }: { searchParams: Promise<{ asset?: string }> }) {
  const user = await getCurrentUser();
  const { asset } = await searchParams;
  const clip = asset && /^[A-Za-z0-9_-]{1,64}$/.test(asset) ? await findBlockClip(user.workspaceId, asset) : null;

  return (
    <main className="shell walk-shell">
      <header className="shell-head">
        <Link href="/" className="btn btn-quiet" prefetch={false}>
          <BackIcon size={18} />
          Reels
        </Link>
        <span className="muted small">{user.workspace.name}</span>
      </header>
      <h1 className="walk-title">Walk the block</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        A drone pass over the land, and the home drawn on it to scale.
      </p>
      <WalkBlock initialAssetId={clip?.id ?? null} />
    </main>
  );
}
