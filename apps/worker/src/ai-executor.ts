// The worker runs the web app's AI step module itself (ADR 0049): one copy of
// the Ask, autopilot and Director logic and prompts. `@/` resolves to
// apps/web through this package's tsconfig paths; that module tree is kept
// free of Next.js imports.
import { directorFailureMessage, runAiStep } from "@/lib/ai-steps";
import type { AiStepExecutor } from "./ai-jobs";
import { runMusicAnalysisStep } from "./music-analysis";

export const aiStepExecutor: AiStepExecutor = {
  // A track's analysis (ADR 0066) needs ffmpeg, so it runs here and never touches a paid provider.
  run: (step, gate) => ((step.kind as string) === "music-analysis" ? runMusicAnalysisStep(step) : runAiStep({ kind: step.kind, user: step.user, reelId: step.reelId, payload: step.payload }, gate)),
  describeError: (step, error) =>
    step.kind === "director-review" ? directorFailureMessage(error) : (error instanceof Error ? error.message : String(error)).slice(0, 300),
};
