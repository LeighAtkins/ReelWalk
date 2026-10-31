import type { Metadata } from "next";
import Link from "next/link";
import { CreateStudio } from "@/components/create-studio";
import { BackIcon } from "@/components/icons";
import { notesAvailable } from "@/lib/reel-thread";
import { voiceoverAvailable } from "@/lib/voiceover";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Describe a video · ReelWalk" };

/** Create (ADR 0098): an idea, optional footage, and up to three finished options. */
export default async function CreatePage() {
  const user = await getCurrentUser();
  const available = notesAvailable() && user.workspace.aiGeneration !== "off";
  return (
    <main className="shell">
      <header className="shell-head">
        <Link href="/" className="btn btn-quiet" prefetch={false}>
          <BackIcon size={18} />
          Reels
        </Link>
        <span className="muted small">{user.workspace.name}</span>
      </header>
      <h1 style={{ marginBottom: 4 }}>Describe a video</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Say what you want in a sentence or two. Add your own photos or videos, or none at all. You get short options with music, captions and a voiceover if you want one, ready to post or schedule.
      </p>
      <CreateStudio available={available} voices={voiceoverAvailable()} />
    </main>
  );
}
