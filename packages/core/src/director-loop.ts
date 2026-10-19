import { aiClipCredits } from "./ai";
import type { DirectorPlan } from "./ai-director";

/**
 * "Make it for me": the director reviews, the app applies the edit and
 * makes the first proposed shot that fits the remaining credits, waits for
 * it, has Opus review the result, and repeats until Opus is happy, the
 * budget is spent or the round limit is reached. The decisions are here so
 * they are tested without a browser; the sheet runs them.
 */

export const DIRECTOR_LOOP_MAX_ROUNDS = 4;

export type DirectorLoopState = { round: number; maxRounds: number; budgetCredits: number; spentCredits: number };
export type DirectorLoopStep = { kind: "done"; reason: string } | { kind: "generate"; index: number; credits: number };

const plural = (n: number) => `${n} ${n === 1 ? "credit" : "credits"}`;

/** What to do after a review in a run. */
export function directorLoopStep(plan: { verdict: DirectorPlan["verdict"]; shots: { durationSeconds: 4 | 8; voice?: "lipsync" | "veo" | null }[] }, state: DirectorLoopState): DirectorLoopStep {
  if (plan.verdict === "ready") return { kind: "done", reason: "Opus is happy with the reel. The run is finished." };
  if (!plan.shots.length) return { kind: "done", reason: "Opus made its changes and has no new shot to suggest. The run is finished." };
  if (state.round >= state.maxRounds) return { kind: "done", reason: `Stopped after ${state.maxRounds} rounds with ${plural(state.spentCredits)} used. Opus still suggests a shot; ask again to continue.` };
  const remaining = state.budgetCredits - state.spentCredits;
  const index = plan.shots.findIndex(shot => aiClipCredits(shot.durationSeconds, Boolean(shot.voice)) <= remaining);
  if (index < 0) {
    const cheapest = Math.min(...plan.shots.map(shot => aiClipCredits(shot.durationSeconds, Boolean(shot.voice))));
    return { kind: "done", reason: `The next shot needs ${plural(cheapest)} and ${plural(Math.max(0, remaining))} of the budget ${remaining === state.budgetCredits ? "is" : "are"} left, so the run stopped. Raise the budget to continue.` };
  }
  return { kind: "generate", index, credits: aiClipCredits(plan.shots[index].durationSeconds, Boolean(plan.shots[index].voice)) };
}

/** The brief for a follow-up round: the original ask plus the take to check. */
export function directorLoopBrief(original: string, round: number, take: { title: string; fileName: string } | null): string {
  const check = take
    ? ` The new take "${take.title}" (${take.fileName}) is ready and is a review candidate: check it against the brief with the frames and measured motion. If it passes, use it in the edit now; if it fails, say what went wrong and propose one retry that fixes it.`
    : "";
  return `${original.trim()}\n\nRound ${round + 1} of a run you are directing without the studio in the loop.${check} Apply every change that does not need a new take. Do not propose shots unrelated to this brief.`;
}
