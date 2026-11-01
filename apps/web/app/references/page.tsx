import type { Metadata } from "next";
import Link from "next/link";
import { BackIcon } from "@/components/icons";
import { StyleReferences } from "@/components/style-references";
import { listStyleReferences } from "@/lib/style-references";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Follow a reel's style · ReelWalk" };

/** Style references (ADR 0102): reels the owner downloaded and shared, read into recipes a reel can follow. */
export default async function ReferencesPage() {
  const user = await getCurrentUser();
  const references = await listStyleReferences(user.workspace.id);
  return (
    <main className="shell">
      <header className="shell-head">
        <Link href="/" className="btn btn-quiet" prefetch={false}>
          <BackIcon size={18} />
          Reels
        </Link>
        <span className="muted small">{user.workspace.name}</span>
      </header>
      <h1 style={{ marginBottom: 4 }}>Follow a reel&apos;s style</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Share a reel you like and ReelWalk reads how it is made: its cuts and pace, what is said, and every title and how it moves. Your reels can then follow the same style with your own footage and words.
      </p>
      <StyleReferences initial={references} available={user.workspace.aiGeneration !== "off"} />
    </main>
  );
}
