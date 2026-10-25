import { clipDurationMs, clipStartsMs, placementProblem, type BatchableCommand, type Command } from "@reelwalk/core";
import type { LoadedReel } from "@/lib/reel-command";
import { surfaceDecodeAvailable } from "@/lib/surface-server";
import { placeOnSurface, searchSurfaces, type SurfaceLook, type VisionReport } from "@/lib/surface-service";
import { aiIsOff } from "@/lib/ai-gate";
import { lookForSurfaces, surfaceVisionAvailable } from "@/lib/surface-vision";

/**
 * `placeOnSurface` over HTTP (ADR 0075, on ADR 0048's command boundary). The core command is pure and cannot
 * look at a picture, so the commands route turns one that carries no `placement` into one that does: it reads
 * the frame at `atMs`, finds the surface, tracks it through the shot, and sends the pure command the result.
 * `dryRun` stops after the finding and answers with the candidates, so an agent can choose before anything is
 * changed or tracked.
 */
export type SurfaceReport = {
  textId: string; clipId: string; atMs: number;
  /** What was found in the frame: the best few, best first (corners are frame fractions; `placement` is what the title would fill). */
  candidates: unknown[]; rejected: unknown[]; horizonY: number | null;
  vision: VisionReport;
  /** Set when a surface was chosen (not on a dry run). */
  chosen?: { id: string; kind: string; label: string; tracking: "tracked" | "fixed" | "failed"; quality?: unknown; notes: string[] };
};

export type SurfaceResolution =
  | { ok: true; /** What to apply: the command with every `placeOnSurface` filled in; null on a dry run with nothing else to apply. */ command: Command | null; reports: SurfaceReport[] }
  | { ok: false; status: 400 | 404 | 503; message: string };

type Place = Extract<Command, { type: "placeOnSurface" }>;
const needsSurface = (command: Command): command is Place => command.type === "placeOnSurface" && !command.placement;

/** Whether the command, or a command in its batch, is a `placeOnSurface` that still has to be found. */
export const hasUnresolvedSurface = (command: Command): boolean => (command.type === "batch" ? command.commands.some(needsSurface) : needsSurface(command));

export async function resolveSurfaceCommands(loaded: LoadedReel, command: Command, options: { dryRun?: boolean; look?: SurfaceLook | null; decodeAvailable?: () => Promise<boolean>; /** Whose AI switch the vision look is under (ADR 0079); without one, no look is made. */ workspaceId?: string } = {}): Promise<SurfaceResolution> {
  if (!hasUnresolvedSurface(command)) return { ok: true, command, reports: [] };
  if (!(await (options.decodeAvailable ?? surfaceDecodeAvailable)())) return { ok: false, status: 503, message: "This server cannot read video frames (no ffmpeg), so it cannot find a surface. Open the reel in the editor and use Put on a surface, or send placement.corners yourself." };
  // The vision look is optional (the edge finder works without it); a workspace with AI off gets the edge finder only.
  const { workspaceId } = options;
  const visionAllowed = workspaceId !== undefined && surfaceVisionAvailable() && !(await aiIsOff(workspaceId));
  const look = options.look !== undefined ? options.look : visionAllowed ? (jpeg: Buffer) => lookForSurfaces(workspaceId, jpeg) : null;
  const reports: SurfaceReport[] = [];
  const starts = clipStartsMs(loaded.timeline);

  const resolveOne = async (item: Place): Promise<{ ok: true; command: BatchableCommand } | { ok: false; status: 400 | 404; message: string }> => {
    const text = loaded.timeline.texts.find((t) => t.id === item.textId);
    if (!text) return { ok: false, status: 400, message: `There is no text called ${item.textId} in the reel.` };
    // Without a clipId: the shot the title starts in.
    const index = item.clipId
      ? loaded.timeline.clips.findIndex((c) => c.id === item.clipId)
      : loaded.timeline.clips.findIndex((c, i) => text.startMs >= starts[i] && text.startMs < starts[i] + clipDurationMs(c));
    if (index < 0) return { ok: false, status: 400, message: item.clipId ? `There is no clip called ${item.clipId} in the reel.` : "The title does not start inside any clip: say which clip to look at with clipId." };
    const clip = loaded.timeline.clips[index], clipStartMs = starts[index];
    const atMs = typeof item.atMs === "number" && Number.isFinite(item.atMs) ? item.atMs : Math.max(clipStartMs, Math.min(text.startMs, clipStartMs + clipDurationMs(clip) - 1));
    if (atMs < clipStartMs || atMs >= clipStartMs + clipDurationMs(clip)) return { ok: false, status: 400, message: `atMs ${Math.round(atMs)} is outside clip ${clip.id}, which runs ${clipStartMs}–${clipStartMs + clipDurationMs(clip)} ms in the reel.` };
    const asset = loaded.library[clip.assetId];
    if (!asset || !asset.width || !asset.height) return { ok: false, status: 404, message: `The media of clip ${clip.id} is not in the library or has no size.` };
    const target = { source: { src: asset.url, width: asset.width, height: asset.height }, clip, clipStartMs, text, atMs };
    if (options.dryRun) {
      const found = await searchSurfaces(target, { look, top: 3 });
      reports.push({ textId: text.id, clipId: clip.id, atMs, candidates: found.search.candidates, rejected: found.search.rejected, horizonY: found.search.horizonY, vision: found.vision });
      return { ok: true, command: item };
    }
    const placed = await placeOnSurface(target, { pick: item.pick, look });
    if (!placed.ok) return { ok: false, status: 400, message: placed.message };
    reports.push({
      textId: text.id, clipId: clip.id, atMs, candidates: placed.search.candidates, rejected: placed.search.rejected, horizonY: placed.search.horizonY, vision: placed.vision,
      chosen: { id: placed.candidate.id, kind: placed.candidate.kind, label: placed.candidate.label, tracking: placed.tracking, quality: placed.quality, notes: placed.notes },
    });
    const problem = placementProblem(placed.placement);
    if (problem) return { ok: false, status: 400, message: problem };
    return { ok: true, command: { ...item, clipId: clip.id, atMs, placement: placed.placement } };
  };

  if (command.type === "batch") {
    const next: BatchableCommand[] = [];
    for (const item of command.commands) {
      if (!needsSurface(item)) { next.push(item); continue; }
      const resolved = await resolveOne(item);
      if (!resolved.ok) return resolved;
      // A dry run only finds: the batch goes on without the surface commands.
      if (!options.dryRun) next.push(resolved.command);
    }
    return { ok: true, command: next.length ? { type: "batch", commands: next } : null, reports };
  }
  const resolved = await resolveOne(command as Place);
  if (!resolved.ok) return resolved;
  return { ok: true, command: options.dryRun ? null : resolved.command, reports };
}
