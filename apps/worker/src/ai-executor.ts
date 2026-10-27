// The worker runs the web app's AI step module itself (ADR 0049): one copy of
// the Ask, autopilot and Director logic and prompts. `@/` resolves to
// apps/web through this package's tsconfig paths; that module tree is kept
// free of Next.js imports.
import { directorFailureMessage, runAiStep } from "@/lib/ai-steps";
import type { AiStepExecutor } from "./ai-jobs";
import { runMusicAnalysisStep } from "./music-analysis";
import { runBlockRevealStep, runBlockSolveStep, scopeFor } from "./walk-block";

/** Steps that run here and never touch a paid provider, each in a scope stopped with the step's attempt. */
async function localStep<T>(signal: AbortSignal | undefined, work: (scope: ReturnType<typeof scopeFor>) => Promise<T>): Promise<T> {
  const scope = scopeFor(signal);
  try {
    return await work(scope);
  } finally {
    await scope.close();
  }
}

export const aiStepExecutor: AiStepExecutor = {
  // A track's analysis (ADR 0066) needs ffmpeg, so it runs here and never touches a paid provider.
  // Walk the block (ADR 0093): the drone clip's solve (Python, OpenCV) and the drawn reveal, both free.
  run: (step, gate) =>
    step.kind === "music-analysis"
      ? runMusicAnalysisStep(step)
      : step.kind === "block-solve"
        ? localStep(gate.signal, (scope) => runBlockSolveStep(step, scope))
        : step.kind === "block-reveal"
          ? localStep(gate.signal, (scope) => runBlockRevealStep(step, scope))
          : runAiStep({ kind: step.kind, user: step.user, reelId: step.reelId, payload: step.payload }, gate),
  describeError: (step, error) =>
    step.kind === "director-review" ? directorFailureMessage(error) : (error instanceof Error ? error.message : String(error)).slice(0, 300),
};
