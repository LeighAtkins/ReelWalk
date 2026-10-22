import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { analyseAudio, audioAnalysisKeyFor, songMapFromAnalysis, type AudioAnalysis } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { z } from "zod";
import { getConfig } from "./config";
import { decodeMono, s3 } from "./library/tools";
import { createAttemptScope, type AttemptScope } from "./lifecycle";

/**
 * The "music-analysis" step (ADR 0066): a track's beats, bars, sections,
 * energy curve and drop, decoded by ffmpeg here because the web container
 * has no decoder. The result is cached in storage beside the audio object
 * (`audioAnalysisKeyFor`), and the asset's tempo and song map are filled
 * in for the editor. The step never calls a paid provider, so an attempt
 * that fails is simply retried.
 */

export const musicAnalysisPayloadSchema = z.object({ assetId: z.string().min(1).max(64) });

export async function runMusicAnalysisStep(step: { payload: unknown; user: { workspaceId: string } }, scope?: AttemptScope): Promise<AudioAnalysis> {
  const { assetId } = musicAnalysisPayloadSchema.parse(step.payload);
  const asset = await prisma.mediaAsset.findFirst({ where: { id: assetId, workspaceId: step.user.workspaceId, kind: "AUDIO" }, select: { id: true, objectKey: true, bpm: true, songMap: true } });
  if (!asset) throw new Error("That sound is not in this workspace.");
  const config = getConfig();
  const privateScope = scope ? null : createAttemptScope();
  const attempt = scope ?? privateScope!;
  try {
    const workdir = await attempt.tempDir("reelwalk-music-");
    const file = path.join(workdir, `track${path.extname(asset.objectKey) || ".bin"}`);
    const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: asset.objectKey }), { abortSignal: attempt.signal });
    if (!object.Body) throw new Error("The sound's file is missing from storage.");
    await pipeline(object.Body as NodeJS.ReadableStream, createWriteStream(file));
    const analysis = analyseAudio(await decodeMono(file, attempt));
    const body = Buffer.from(JSON.stringify(analysis));
    await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: audioAnalysisKeyFor(asset.objectKey), Body: body, ContentLength: body.byteLength, ContentType: "application/json" }), { abortSignal: attempt.signal });
    // The editor's fields, when the browser has not filled them in already.
    const songMap = songMapFromAnalysis(analysis);
    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { ...(asset.bpm === null && analysis.bpm !== null ? { bpm: analysis.bpm, beatOffsetMs: analysis.beatOffsetMs } : {}), ...(asset.songMap === null && songMap ? { songMap } : {}) },
    });
    return analysis;
  } finally {
    await privateScope?.close();
  }
}
