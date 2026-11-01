import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  analyseAudio, assembleRecipe, checkDecodeArgs, keyframeTimes, motionSamples, parseSceneCuts, referenceAnalysisSchema, seriesFromGreyFrames,
  shotsFromCuts, transcriptSchema, withMotion, type ReferenceAnalysis, type ReferenceRead, type StyleRecipe,
} from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { z } from "zod";
import { getConfig } from "./config";
import { decodeMono, run, s3 } from "./library/tools";
import type { AttemptScope } from "./lifecycle";
import { transcribeVideo, transcriptionAvailable } from "./transcribe";

/**
 * The "reference-read" step (ADR 0102): a style reference the owner shared is measured here (the web container has no
 * decoder or speech model) and its titles are read by the model from keyframes, once, through the provider gate.
 *
 *  1. Measure (free): ffmpeg's scene cuts, motion per shot from the render checks' grey frames, the beat grid, and the
 *     words (the upload's own transcript, or transcribed now). Saved on the reference as `analysis` with status
 *     "reading", so a failure in the paid part never repeats the measuring.
 *  2. Keyframes (free): JPEGs at keyframeTimes, kept under the reference's own prefix.
 *  3. Read (paid, one request): the model names the titles and their effects; the recipe is saved with status "ready".
 *
 * Only the first MAX_REFERENCE_MS is read. The reference's footage is never rendered or placed in a reel.
 */

export const referenceReadPayloadSchema = z.object({ referenceId: z.string().min(1).max(64) });

/** References longer than this are read up to it. */
export const MAX_REFERENCE_MS = 90_000;
const KEYFRAME_WIDTH = 432;
const SCENE_THRESHOLD = "0.3";

export type ReferenceReadResult = { referenceId: string; status: "ready"; titles: number; shots: number };

/** Where a reference's keyframe at `atMs` is kept. */
export function keyframeKey(workspaceId: string, referenceId: string, atMs: number): string {
  return `workspaces/${workspaceId}/references/${referenceId}/kf-${String(atMs).padStart(6, "0")}.jpg`;
}

export async function measureReference(file: string, workdir: string, durationMs: number, transcript: unknown, scope: AttemptScope, log: (line: string) => void) {
  const limit = (MAX_REFERENCE_MS / 1000).toFixed(1);
  const scene = await run("ffmpeg", ["-v", "info", "-nostdin", "-t", limit, "-i", file, "-an", "-vf", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, "-f", "null", "-"], { scope, maxBuffer: 16 * 1024 * 1024, timeoutMs: 180_000 });
  const shots = shotsFromCuts(parseSceneCuts(scene.stderr), durationMs);
  const decoded = await run("ffmpeg", ["-t", limit, ...checkDecodeArgs(file)], { scope, encoding: "buffer", maxBuffer: 96 * 1024 * 1024, timeoutMs: 180_000 });
  const measured = withMotion(shots, motionSamples(seriesFromGreyFrames(decoded.stdout)));
  let beat: ReferenceAnalysis["beat"] = null;
  try {
    const audio = analyseAudio(await decodeMono(file, scope));
    if (audio.bpm !== null && audio.beats.length > 0) beat = { bpm: audio.bpm, beatsMs: audio.beats.filter((b) => b <= durationMs).slice(0, 2000) };
  } catch (error) {
    scope.throwIfStopped();
    log(`reference: no beat read (${error instanceof Error ? error.message : error})`);
  }
  let words = transcriptSchema.safeParse(transcript).data?.words ?? null;
  if (!words && transcriptionAvailable()) {
    try {
      words = (await transcribeVideo(file, workdir, MAX_REFERENCE_MS / 1000, scope))?.words ?? [];
    } catch (error) {
      scope.throwIfStopped();
      log(`reference: not transcribed (${error instanceof Error ? error.message : error})`);
    }
  }
  return { shots: measured, beat, words: (words ?? []).map((w) => ({ text: w.w, startMs: w.s, endMs: w.e })) };
}

/**
 * The paid reading, injected by ai-executor.ts: the web app's prompt (lib/reference-read.ts) run through the provider
 * gate, so it is one request per reading and a replay never sends it twice.
 */
export type ReferenceReader = (input: { workspaceId: string; analysis: ReferenceAnalysis; frames: { atMs: number; dataUrl: string }[]; signal?: AbortSignal }) => Promise<{ read: ReferenceRead; model: string }>;

export async function runReferenceReadStep(
  step: { payload: unknown; user: { workspaceId: string } },
  scope: AttemptScope,
  reader: ReferenceReader,
  log: (line: string) => void = (line) => console.log(line),
): Promise<ReferenceReadResult> {
  const { referenceId } = referenceReadPayloadSchema.parse(step.payload);
  const workspaceId = step.user.workspaceId;
  const reference = await prisma.styleReference.findFirst({
    where: { id: referenceId, workspaceId },
    select: { id: true, analysis: true, mediaAsset: { select: { objectKey: true, kind: true, durationMs: true, width: true, height: true, transcript: true } } },
  });
  if (!reference) throw new Error("That reference is not in this workspace.");
  if (reference.mediaAsset.kind !== "VIDEO") throw new Error("A style reference has to be a video.");
  const fail = async (error: unknown) => {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    await prisma.styleReference.updateMany({ where: { id: referenceId, workspaceId }, data: { status: "failed", error: message } });
  };
  try {
    const config = getConfig();
    const workdir = await scope.tempDir("reelwalk-reference-");
    // Measured already (an earlier attempt failed in the reading): read again from what was saved.
    let analysis = referenceAnalysisSchema.safeParse(reference.analysis).data ?? null;
    if (!analysis) {
      const file = path.join(workdir, `reference${path.extname(reference.mediaAsset.objectKey) || ".mp4"}`);
      const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: reference.mediaAsset.objectKey }), { abortSignal: scope.signal });
      if (!object.Body) throw new Error("The reference's file is missing from storage.");
      await pipeline(object.Body as NodeJS.ReadableStream, createWriteStream(file));
      const durationMs = Math.min(MAX_REFERENCE_MS, reference.mediaAsset.durationMs ?? MAX_REFERENCE_MS);
      const { shots, beat, words } = await measureReference(file, workdir, durationMs, reference.mediaAsset.transcript, scope, log);
      const keyframes: ReferenceAnalysis["keyframes"] = [];
      for (const atMs of keyframeTimes(shots, durationMs)) {
        const out = path.join(workdir, `kf-${atMs}.jpg`);
        await run("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", (atMs / 1000).toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${KEYFRAME_WIDTH}:-2`, "-q:v", "4", out], { scope, timeoutMs: 60_000 });
        const key = keyframeKey(workspaceId, referenceId, atMs);
        const body = await readFile(out);
        await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: body, ContentLength: body.byteLength, ContentType: "image/jpeg" }), { abortSignal: scope.signal });
        keyframes.push({ atMs, key });
      }
      analysis = referenceAnalysisSchema.parse({
        version: 1, durationMs,
        ...(reference.mediaAsset.width ? { width: reference.mediaAsset.width } : {}),
        ...(reference.mediaAsset.height ? { height: reference.mediaAsset.height } : {}),
        shots, beat, words: words.slice(0, 3000), keyframes,
      });
      await prisma.styleReference.updateMany({ where: { id: referenceId, workspaceId }, data: { status: "reading", analysis: analysis as never, error: null } });
      log(`reference ${referenceId}: ${shots.length} shot(s), ${words.length} word(s), beat ${beat ? Math.round(beat.bpm) : "none"}, ${keyframes.length} keyframe(s)`);
    }
    const frames: { atMs: number; dataUrl: string }[] = [];
    for (const keyframe of analysis.keyframes) {
      const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: keyframe.key }), { abortSignal: scope.signal });
      const bytes = await (object.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      frames.push({ atMs: keyframe.atMs, dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` });
    }
    const current = analysis;
    const { read, model } = await reader({ workspaceId, analysis: current, frames, signal: scope.signal });
    const recipe: StyleRecipe = assembleRecipe(current, read);
    await prisma.styleReference.updateMany({ where: { id: referenceId, workspaceId }, data: { status: "ready", recipe: recipe as never, error: null } });
    log(`reference ${referenceId}: read by ${model}: ${recipe.titles.length} title(s)`);
    return { referenceId, status: "ready", titles: recipe.titles.length, shots: recipe.shots.length };
  } catch (error) {
    scope.throwIfStopped();
    await fail(error);
    throw error;
  }
}
