import type { Metadata } from "next";
import Link from "next/link";
import { BackIcon } from "@/components/icons";
import { NewShotPlan } from "@/components/shot-plan";
import { listPresenters } from "@/lib/presenters";
import { listShotPlans } from "@/lib/shot-plans";
import { aiOmniConfigured } from "@/lib/ai-video";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shot plans · ReelWalk" };

/** Shot plans (ADR 0104): AI sequences planned shot by shot, storyboarded, then made one take at a time. */
export default async function PlansPage() {
  const user = await getCurrentUser();
  const [plans, presenters] = await Promise.all([listShotPlans(user.workspace.id), listPresenters(user.workspace.id)]);
  return (
    <main className="shell">
      <header className="shell-head">
        <Link href="/" className="btn btn-quiet" prefetch={false}><BackIcon size={18} />Reels</Link>
        <span className="muted small">{user.workspace.name}</span>
      </header>
      <h1 style={{ marginBottom: 4 }}>Plan an AI sequence</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Describe the video and ReelWalk plans it shot by shot: where each shot starts and ends, how the camera moves and how it joins the next. You see a still of every start and end first; then each shot is made and checked before the next, so one bad take never costs the rest.
      </p>
      {user.workspace.aiGeneration !== "off" ? <NewShotPlan presenters={presenters.map((p) => ({ id: p.id, name: p.name }))} omni={aiOmniConfigured()} /> : <p className="muted">AI is off for this workspace.</p>}
      {plans.length ? (
        <ul className="stack" style={{ gap: 8, marginTop: 20, listStyle: "none", padding: 0 }}>
          {plans.map((plan) => (
            <li key={plan.id} className="card" style={{ padding: 12 }}>
              <Link href={`/plans/${plan.id}`} prefetch={false}><strong>{plan.plan.title}</strong></Link>
              <p className="muted small">{plan.plan.shots.length} shots · {plan.status}{plan.waitingFor ? ` (${plan.waitingFor})` : ""} · {plan.credits.spent}/{plan.budgetCredits} credits</p>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
