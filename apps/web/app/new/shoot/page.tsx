import type { Metadata } from "next";
import Link from "next/link";
import { BackIcon } from "@/components/icons";
import { ShootPlanner } from "@/components/shoot-planner";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Plan my shoot · ReelWalk" };

/** The optional first step of a new reel (ADR 0063): a shot list to film from. */
export default async function PlanShootPage() {
  const user = await getCurrentUser();
  return (
    <main className="shell">
      <header className="shell-head">
        <Link href="/" className="btn btn-quiet" prefetch={false}>
          <BackIcon size={18} />
          Reels
        </Link>
        <span className="muted small">{user.workspace.name}</span>
      </header>
      <h1 style={{ marginBottom: 4 }}>Plan my shoot</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        A short shot list for your phone: what to film, in what order, and how. Tick each shot as you go.
      </p>
      <ShootPlanner />
    </main>
  );
}
