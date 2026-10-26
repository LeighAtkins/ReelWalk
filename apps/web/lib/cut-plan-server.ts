import { cutGrammarReport, describeCutPlan, planCutOnTimeline, type Command, type PlannerAnalysis, type Timeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";

/**
 * The cut planner's server side (ADR 0087): the clips' shot analyses (ADR 0086) read from the media library, so an
 * agent's `planCut` and the first cut need not send them, and the plan as readable lines for a dry run.
 *
 * The analysis is stored on `MediaAsset.shotAnalysis` by the shot-analysis work (ADR 0086). It is read with a raw query
 * so this file works on a database from before that migration as well (no column: no analyses, and the callers fall
 * back to the rule cut or refuse `planCut` with the planner's reason).
 */

/** A stored analysis the planner can read: the contract's version 1 with the arrays it walks. */
export function isPlannerAnalysis(value: unknown): value is PlannerAnalysis {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.width === "number" && typeof v.height === "number" && typeof v.durationMs === "number"
    && ["samples", "windows", "motion", "flowPeaks", "depth", "occluders"].every((key) => Array.isArray(v[key])) && typeof v.scene === "object" && v.scene !== null;
}

export async function loadShotAnalyses(workspaceId: string, assetIds: readonly string[]): Promise<Record<string, PlannerAnalysis>> {
  if (!assetIds.length) return {};
  try {
    const rows = await prisma.$queryRaw<{ id: string; shotAnalysis: unknown }[]>`
      SELECT id, "shotAnalysis" FROM "MediaAsset"
      WHERE id = ANY(${[...assetIds]}::text[]) AND ("workspaceId" = ${workspaceId} OR shared = true)`;
    return Object.fromEntries(rows.filter((row) => isPlannerAnalysis(row.shotAnalysis)).map((row) => [row.id, row.shotAnalysis as PlannerAnalysis]));
  } catch (error) {
    // Before the shot-analysis migration the column does not exist: no analyses yet.
    console.warn("cut planner: shot analyses not readable:", error instanceof Error ? error.message.split("\n")[0] : error);
    return {};
  }
}

function planCutsIn(command: Command): Extract<Command, { type: "planCut" }>[] {
  if (command.type === "planCut") return [command];
  if (command.type === "batch") return command.commands.filter((c): c is Extract<Command, { type: "planCut" }> => c.type === "planCut");
  return [];
}

/** The command with every `planCut` that left out its analyses given the library's. */
export async function resolvePlanCut(command: Command, timeline: Timeline, workspaceId: string): Promise<Command> {
  const plans = planCutsIn(command);
  if (!plans.some((plan) => !plan.analyses)) return command;
  const analyses = await loadShotAnalyses(workspaceId, [...new Set(timeline.clips.map((clip) => clip.assetId))]);
  const fill = (c: Command): Command => (c.type === "planCut" && !c.analyses ? { ...c, analyses } : c);
  return command.type === "batch" ? { ...command, commands: command.commands.map((c) => fill(c) as typeof c) } : fill(command);
}

/** For the answer: the plan of the first `planCut` in the command, line by line with its reasons, and the gate on the result. */
export function planSummary(command: Command, before: Timeline, after: Timeline, sourceDurationsMs: Record<string, number | null | undefined>) {
  const first = planCutsIn(command)[0];
  if (!first) return null;
  try {
    const { plan } = planCutOnTimeline(before, { brief: first.brief, targetMs: first.targetMs, analyses: first.analyses ?? {}, sourceDurationsMs, audioAssetIds: first.audioAssetIds });
    const report = cutGrammarReport(after);
    return {
      mode: plan.mode, feel: plan.feel, totalMs: plan.totalMs, lines: describeCutPlan(plan), reveal: plan.reveal, loopSeam: plan.loopSeam, notes: plan.notes,
      gate: { pass: report.pass, failures: report.failures, warnings: report.warnings, nakedCuts: report.nakedCuts, longestNoSurpriseMs: report.longestNoSurpriseMs, longestStaticMs: report.longestStaticMs },
    };
  } catch {
    return null;
  }
}
