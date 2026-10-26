import { describeShotAnalysis, parseShotAnalysis, type Command, type ShotAnalysis } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { mediaScope } from "@/lib/media-scope";

/**
 * The stored shot analyses (ADR 0086) of the workspace's videos `assetIds`, by asset id. An asset without one (not
 * analysed yet, or analysed by an older version) is simply absent. Loaded on demand, never with the library: each is
 * about 1.3 kB a second of footage, which the editor does not need.
 */
export async function loadShotAnalyses(workspaceId: string, assetIds: readonly string[]): Promise<Record<string, ShotAnalysis>> {
  const ids = [...new Set(assetIds)];
  if (!ids.length) return {};
  const rows = await prisma.mediaAsset.findMany({ where: { id: { in: ids }, kind: "VIDEO", ...mediaScope(workspaceId) }, select: { id: true, shotAnalysis: true } });
  const out: Record<string, ShotAnalysis> = {};
  for (const row of rows) {
    const analysis = parseShotAnalysis(row.shotAnalysis);
    if (analysis) out[row.id] = analysis;
  }
  return out;
}

/** One line per analysed video, for a model's text (describeReel). */
export async function shotLines(workspaceId: string, assetIds: readonly string[]): Promise<Record<string, string>> {
  const analyses = await loadShotAnalyses(workspaceId, assetIds);
  return Object.fromEntries(Object.entries(analyses).map(([id, analysis]) => [id, describeShotAnalysis(analysis)]));
}

/** A `setReframe` "auto" sent without an analysis (alone or in a batch) gets its clip's from the library. */
export async function withShotAnalyses(workspaceId: string, command: Command, clipAsset: (clipId: string) => string | undefined): Promise<Command> {
  const wants = (c: Command) => c.type === "setReframe" && c.reframe === "auto" && c.analysis === undefined;
  const items = command.type === "batch" ? command.commands : [command];
  const ids = items.filter(wants).map((c) => clipAsset((c as Extract<Command, { type: "setReframe" }>).clipId)).filter((id): id is string => Boolean(id));
  if (!ids.length) return command;
  const analyses = await loadShotAnalyses(workspaceId, ids);
  const fill = <T extends Command>(c: T): T => {
    if (!wants(c)) return c;
    const assetId = clipAsset((c as Extract<Command, { type: "setReframe" }>).clipId);
    return { ...c, analysis: (assetId && analyses[assetId]) || null };
  };
  return command.type === "batch" ? { ...command, commands: command.commands.map(fill) } : fill(command);
}
