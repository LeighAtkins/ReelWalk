import {
  applyCommand,
  audioAnalysisKeyFor,
  audioTrace,
  exportAudioKeyFor,
  parseAudioAnalysis,
  parseExportLoudness,
  parseTimeline,
  referencedAssetIds,
  songMapFromAnalysis,
  timelineDurationMs,
  transcriptSchema,
  type AudioAnalysis,
  type AudioTrace,
  type Command,
  type Music,
  type SfxClip,
  type Timeline,
  type Transcript,
} from "@reelwalk/core";
import { prisma, type Prisma } from "@reelwalk/db";
import { mediaScope } from "./media-scope";
import { readTimeline } from "./reels";
import { putObject, readObject } from "./storage";
import type { DropContext } from "./sound-commands";

/**
 * Sound, server side (ADR 0066): a track's cached analysis, the audio trace
 * of a reel, and the sound commands applied to a saved reel. The pure work
 * is in @reelwalk/core; this is storage and Prisma.
 */

export type SoundAsset = {
  id: string;
  objectKey: string;
  instagramAudioId: string | null;
  bpm: number | null;
  beatOffsetMs: number | null;
  songMap: Prisma.JsonValue | null;
  durationMs: number | null;
};

const soundAssetSelect = { id: true, objectKey: true, instagramAudioId: true, bpm: true, beatOffsetMs: true, songMap: true, durationMs: true } as const;

/**
 * The workspace's sound by Instagram audio id (its private copy, ADR 0019) or
 * by media asset id (an uploaded song, or the shared library's). Null when
 * neither names an audio asset the workspace may use.
 */
export async function findSoundAsset(workspaceId: string, audioId: string): Promise<SoundAsset | null> {
  const byInstagram = await prisma.mediaAsset.findUnique({ where: { workspaceId_instagramAudioId: { workspaceId, instagramAudioId: audioId } }, select: soundAssetSelect });
  if (byInstagram) return byInstagram;
  return prisma.mediaAsset.findFirst({ where: { id: audioId, kind: "AUDIO", ...mediaScope(workspaceId) }, select: soundAssetSelect });
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

/** The cached analysis beside a sound's file, or null when it has not been made (or is from another version). */
export async function readStoredAnalysis(objectKey: string): Promise<AudioAnalysis | null> {
  const object = await readObject(audioAnalysisKeyFor(objectKey), 2 * 1024 * 1024);
  return object ? parseAudioAnalysis(parseJson(object.bytes)) : null;
}

/**
 * Caches an analysis beside the sound and fills in the asset's tempo, song
 * map and length when the browser had not already (the editor's own
 * detection runs the same code on the same samples, so the two agree).
 */
export async function storeAnalysis(asset: SoundAsset, analysis: AudioAnalysis): Promise<void> {
  await putObject(audioAnalysisKeyFor(asset.objectKey), Buffer.from(JSON.stringify(analysis)), "application/json");
  const songMap = songMapFromAnalysis(analysis);
  const data = {
    ...(asset.bpm === null && analysis.bpm !== null ? { bpm: analysis.bpm, beatOffsetMs: analysis.beatOffsetMs } : {}),
    ...(asset.songMap === null && songMap ? { songMap } : {}),
    ...(asset.durationMs === null && analysis.durationMs > 0 ? { durationMs: analysis.durationMs } : {}),
  };
  if (Object.keys(data).length > 0) await prisma.mediaAsset.update({ where: { id: asset.id }, data });
}

type ReelRow = { id: string; revision: number; timeline: Prisma.JsonValue };

function loadReel(workspaceId: string, reelId: string): Promise<ReelRow | null> {
  return prisma.reel.findFirst({ where: { id: reelId, workspaceId }, select: { id: true, revision: true, timeline: true } });
}

/** The analysis of the reel's song, when it has one that has been analysed. */
async function reelAnalysis(workspaceId: string, timeline: Timeline): Promise<AudioAnalysis | null> {
  const music = timeline.music;
  if (!music) return null;
  const asset = await findSoundAsset(workspaceId, music.instagramAudioId ?? music.assetId);
  return asset ? readStoredAnalysis(asset.objectKey) : null;
}

async function reelAssets(workspaceId: string, timeline: Timeline) {
  const rows = await prisma.mediaAsset.findMany({ where: { id: { in: referencedAssetIds(timeline) }, ...mediaScope(workspaceId) }, select: { id: true, durationMs: true, transcript: true } });
  const transcripts: Record<string, Transcript | null> = {};
  for (const row of rows) transcripts[row.id] = row.transcript ? (transcriptSchema.safeParse(row.transcript).data ?? null) : null;
  const sourceDurationsMs: Record<string, number | null> = Object.fromEntries(rows.map((row) => [row.id, row.durationMs]));
  return { transcripts, sourceDurationsMs };
}

export type ReelAudioTrace = AudioTrace & { reelId: string; revision: number; exportJobId: string | null };

/**
 * What an agent reads instead of listening: beats, cuts, speech, sounds,
 * the finished export's loudness (when one has been rendered) and the
 * problems. Null when the reel is not this workspace's.
 */
export async function reelAudioTrace(workspaceId: string, reelId: string): Promise<ReelAudioTrace | null> {
  const reel = await loadReel(workspaceId, reelId);
  if (!reel) return null;
  const timeline = readTimeline(reel.timeline);
  const [analysis, { transcripts }, job] = await Promise.all([
    reelAnalysis(workspaceId, timeline),
    reelAssets(workspaceId, timeline),
    prisma.renderJob.findFirst({
      where: { reelId: reel.id, workspaceId, kind: "REEL", status: "SUCCEEDED", output: { isNot: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true, output: { select: { objectKey: true } } },
    }),
  ]);
  const sidecar = job?.output ? await readObject(exportAudioKeyFor(job.output.objectKey), 2 * 1024 * 1024) : null;
  const loudness = sidecar ? parseExportLoudness(parseJson(sidecar.bytes)) : null;
  return { ...audioTrace({ timeline, analysis, transcripts, loudness }), reelId: reel.id, revision: reel.revision, exportJobId: job?.id ?? null };
}

export type SoundCommandResult = { ok: true; revision: number; changed: boolean; sfx: SfxClip[]; music: Music | null } | { ok: false; status: number; message: string };

/**
 * Applies one sound command to the saved reel and saves the result as a new
 * revision. An editor left open on the reel sees the conflict on its next
 * autosave and reloads, as it does for any other tab's save.
 */
export async function applySoundCommand(
  workspaceId: string,
  reelId: string,
  make: (context: DropContext) => { ok: true; command: Command } | { ok: false; message: string },
): Promise<SoundCommandResult> {
  const reel = await loadReel(workspaceId, reelId);
  if (!reel) return { ok: false, status: 404, message: "That reel was not found." };
  let timeline: Timeline;
  try {
    timeline = parseTimeline(reel.timeline);
  } catch {
    return { ok: false, status: 409, message: "The saved reel is not a valid timeline." };
  }
  const [analysis, { sourceDurationsMs }] = await Promise.all([reelAnalysis(workspaceId, timeline), reelAssets(workspaceId, timeline)]);
  const made = make({
    dropMs: analysis?.drop?.atMs ?? null,
    dropSongMsFromMusic: timeline.music?.drop?.songMs ?? null,
    sourceStartMs: timeline.music?.sourceStartMs ?? 0,
    reelMs: timelineDurationMs(timeline),
  });
  if (!made.ok) return { ok: false, status: 422, message: made.message };
  // The generation only matters to applyProposal; sound commands never carry one.
  const result = applyCommand(timeline, made.command, { generation: 0, sourceDurationsMs });
  if (result.rejected) return { ok: false, status: 422, message: result.rejected };
  if (result.changes.length === 0) return { ok: true, revision: reel.revision, changed: false, sfx: timeline.sfx ?? [], music: timeline.music };
  const updated = await prisma.reel.updateMany({ where: { id: reel.id, workspaceId, revision: reel.revision }, data: { timeline: result.timeline, revision: { increment: 1 } } });
  if (updated.count === 0) return { ok: false, status: 409, message: "The reel changed while the sound was being placed. Try again." };
  return { ok: true, revision: reel.revision + 1, changed: true, sfx: result.timeline.sfx ?? [], music: result.timeline.music };
}
