// The worker runs the web app's AI step module itself (ADR 0049): one copy of
// the Ask, autopilot and Director logic and prompts. `@/` resolves to
// apps/web through this package's tsconfig paths; that module tree is kept
// free of Next.js imports.
import { directorFailureMessage, runAiStep } from "@/lib/ai-steps";
import { withProviderGate } from "@/lib/provider-gate";
import { readReference } from "@/lib/reference-read";
import type { AiStepExecutor } from "./ai-jobs";
import { runMusicAnalysisStep } from "./music-analysis";
import { runReferenceReadStep } from "./reference-read";
import { runVoiceoverStep } from "./voiceover";
import { runBlockRevealStep, runBlockSolveStep, runInStepScope } from "./walk-block";

export const aiStepExecutor: AiStepExecutor = {
  // A track's analysis (ADR 0066) needs ffmpeg, so it runs here and never touches a paid provider.
  // Walk the block (ADR 0093): the drone clip's solve (Python, OpenCV) and the drawn reveal, both free.
  // A voiceover (ADR 0099) is spoken by Workers AI and transcribed here, where the speech model is.
  run: (step, gate) =>
    step.kind === "music-analysis"
      ? runMusicAnalysisStep(step)
      : step.kind === "block-solve"
        ? runInStepScope(gate.signal, (scope) => runBlockSolveStep(step, scope))
        : step.kind === "block-reveal"
          ? runInStepScope(gate.signal, (scope) => runBlockRevealStep(step, scope))
          : step.kind === "voiceover"
            ? runInStepScope(gate.signal, (scope) => runVoiceoverStep(step, scope, gate))
            // A style reference (ADR 0102): measured here, then read by the model once through the gate.
            : step.kind === "reference-read"
              ? runInStepScope(gate.signal, (scope) => runReferenceReadStep(step, scope, (input) => withProviderGate(gate, () => readReference(input))))
              : runAiStep({ kind: step.kind, user: step.user, reelId: step.reelId, payload: step.payload, identity: `step:${step.id}:g${step.generation}` }, gate),
  describeError: (step, error) =>
    step.kind === "director-review" ? directorFailureMessage(error) : (error instanceof Error ? error.message : String(error)).slice(0, 300),
};
