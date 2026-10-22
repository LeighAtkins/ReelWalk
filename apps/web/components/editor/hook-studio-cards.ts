import {
  HOOK_PATTERN_DESCRIPTIONS,
  HOOK_PATTERN_LABELS,
  HOOK_PATTERNS,
  hasSpeech,
  hookRules,
  planHook,
  type Command,
  type HookInputs,
  type HookIssue,
  type HookPattern,
  type HookPlan,
  type Timeline,
} from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import type { OpeningMeasure } from "./hook-motion";

/**
 * The Hook studio's cards (ADR 0068), without React: one per pattern, each
 * with its plan (or why it cannot be made), the rules it passes, and the
 * command that applies it. The sheet draws these; the plan is a pure
 * function, so what the card shows is what one tap applies.
 */

export type HookCard = {
  pattern: HookPattern;
  label: string;
  description: string;
  plan: HookPlan | null;
  /** Why the pattern cannot be made from this reel; null when it can. */
  unavailable: string | null;
  rules: HookIssue[];
  /** How many of the rules the opening passes, of those that could be judged. */
  passes: number;
  judged: number;
};

export type StudioInputs = { line: string; promise: string; headline: string | null; measure: OpeningMeasure; clipId?: string };

/** The planner's inputs from the editor's library and what the studio knows. */
export function hookInputs(library: Record<string, LibraryAsset>, inputs: StudioInputs): HookInputs {
  const assets = Object.values(library);
  return {
    titles: inputs.line.trim() ? [inputs.line.trim()] : [],
    promise: inputs.promise,
    headline: inputs.headline,
    clipId: inputs.clipId,
    motion: inputs.measure.motion,
    clipLuma: inputs.measure.clipLuma,
    speech: Object.fromEntries(assets.filter((asset) => asset.kind === "VIDEO" && hasSpeech(asset.transcript)).map((asset) => [asset.id, asset.transcript!.words])),
    sourceDurationsMs: Object.fromEntries(assets.map((asset) => [asset.id, asset.durationMs])),
  };
}

export function unavailableReason(pattern: HookPattern): string {
  switch (pattern) {
    case "voice-in": return "Needs a shot where someone speaks (a transcribed video with its sound on).";
    case "text-punch": return "Needs a hook line: write one below.";
    case "question": return "Needs a question: write one below.";
    case "pattern-interrupt": return "Needs a second shot that is not a 360 or a presenter take.";
    case "motion-in": return "Needs a shot to open on.";
  }
}

export function studioCards(timeline: Timeline, library: Record<string, LibraryAsset>, inputs: StudioInputs): HookCard[] {
  const planner = hookInputs(library, inputs);
  return HOOK_PATTERNS.map((pattern) => {
    const plan = planHook(timeline, pattern, planner);
    const rules = plan ? hookRules(plan.timeline, { speech: planner.speech, motion: planner.motion }) : [];
    const judged = rules.filter((rule) => !rule.unknown);
    return {
      pattern, label: HOOK_PATTERN_LABELS[pattern], description: HOOK_PATTERN_DESCRIPTIONS[pattern],
      plan, unavailable: plan ? null : unavailableReason(pattern), rules,
      passes: judged.filter((rule) => rule.ok).length, judged: judged.length,
    };
  });
}

/** The command one tap sends: the plan's inputs, so the editor's document applies exactly what the card showed. */
export function hookCommand(pattern: HookPattern, library: Record<string, LibraryAsset>, inputs: StudioInputs): Command {
  return { type: "hook", pattern, ...hookInputs(library, inputs) };
}

/** The pattern to open the studio on: the reel's own, else the first that can be made. */
export function initialPattern(timeline: Timeline, cards: readonly HookCard[]): HookPattern {
  return timeline.opening?.pattern ?? cards.find((card) => card.plan)?.pattern ?? "text-punch";
}
