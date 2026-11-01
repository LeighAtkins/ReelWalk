import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackIcon } from "@/components/icons";
import { ShotPlanBoard } from "@/components/shot-plan";
import { getShotPlan, planMedia } from "@/lib/shot-plans";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shot plan · ReelWalk" };

/** One shot plan's storyboard and takes (ADR 0104). */
export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const { id } = await params;
  const plan = await getShotPlan(user.workspace.id, id);
  if (!plan) notFound();
  return (
    <main className="shell">
      <header className="shell-head">
        <Link href="/plans" className="btn btn-quiet" prefetch={false}><BackIcon size={18} />Plans</Link>
        <span className="muted small">{user.workspace.name}</span>
      </header>
      <h1 style={{ marginBottom: 4 }}>{plan.plan.title}</h1>
      <p className="muted" style={{ marginBottom: 16 }}>{plan.brief}</p>
      <ShotPlanBoard initial={plan} initialMedia={await planMedia(user.workspace.id, plan)} />
    </main>
  );
}
