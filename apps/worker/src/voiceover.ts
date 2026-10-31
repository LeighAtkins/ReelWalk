import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { isVoiceId, VOICEOVER_MAX_CHARS, type Transcript } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { z } from "zod";
import type { ProviderGate } from "./ai-jobs";
import { getConfig } from "./config";
import { run, s3 } from "./library/tools";
import type { AttemptScope } from "./lifecycle";
import { transcribeVideo } from "./transcribe";
import { presenterVoice, synthesiseLine, voiceConfigured, VoiceServiceAnswered } from "./voice";

/**
 * The "voiceover" step (ADR 0099): a script spoken in the chosen voice by our
 * voice Worker (Workers AI), transcribed here with word timings (the web
 * container has no speech model), and kept as an AUDIO library asset. The
 * reel's voiceover and its captions are then set from the asset by the web app.
 *
 * Speaking the line is the paid part, so it happens at most once per line:
 *  - the audio is kept under its content identity (the model, the voice and
 *    the script), with its SHA-256, the moment it arrives, before anything
 *    that can fail after it (transcription, probing, the asset row);
 *  - every attempt (a retry, a later "ask again", another reel with the same
 *    line) looks for that audio first and reuses it without a request;
 *  - the request itself goes through the provider gate: the step is recorded
 *    as submitted before it is sent, so the worker never re-runs it on its
 *    own. A failure after the audio arrived is FAILED (asking again reuses the
 *    saved audio); no answer at all (a timeout, a dropped connection) is
 *    UNRESOLVED, because the line may have been made and paid for.
 */

export const voiceoverPayloadSchema = z.object({
  script: z.string().trim().min(1).max(VOICEOVER_MAX_CHARS),
  voice: z.string().refine(isVoiceId, "That voice is not one of the voices offered."),
});

export type VoiceoverResult = { assetId: string; durationMs: number | null; transcript: Transcript | null };

/** Part of the audio's identity: a different model (infra/cloudflare/voice) makes different audio for the same words. */
export const VOICEOVER_MODEL = "workers-ai/deepgram-aura-2-en";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Where a line's audio is kept: by what it is, so every attempt and every step for the same line finds it. */
export function voiceoverKey(workspaceId: string, voice: string, script: string): string {
  return `workspaces/${workspaceId}/voiceover/${sha256(`${VOICEOVER_MODEL}\n${voice}\n${script}`).slice(0, 40)}.mp3`;
}

/** The saved audio for `key`, when it is there and matches the checksum it was saved with; null when there is none. */
async function savedAudio(key: string, scope: AttemptScope, log: (line: string) => void): Promise<Buffer | null> {
  let object;
  try {
    object = await s3.send(new GetObjectCommand({ Bucket: getConfig().s3Bucket, Key: key }), { abortSignal: scope.signal });
  } catch (error) {
    const missing = (error as { name?: string; $metadata?: { httpStatusCode?: number } } | null);
    if (missing?.name === "NoSuchKey" || missing?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
  const body = object.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) return null;
  const audio = Buffer.from(await body.transformToByteArray());
  // Written whole or not at all, so a mismatch means something else changed it: speak the line again rather than trust it.
  if (!object.Metadata?.sha256 || sha256(audio) !== object.Metadata.sha256) {
    log(`voiceover: saved audio at ${key} does not match its checksum; speaking the line again`);
    return null;
  }
  return audio;
}

/** Keeps the audio the moment it arrives; tried a few times, since losing it would mean paying for the line again. */
async function saveAudio(key: string, audio: Buffer, voice: string, scope: AttemptScope): Promise<void> {
  const digest = sha256(audio);
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: getConfig().s3Bucket, Key: key, Body: audio, ContentLength: audio.byteLength, ContentType: "audio/mpeg",
          ContentMD5: createHash("md5").update(audio).digest("base64"), Metadata: { sha256: digest, voice, model: VOICEOVER_MODEL },
        }),
        { abortSignal: scope.signal },
      );
      return;
    } catch (error) {
      last = error;
      if (scope.signal.aborted) break;
    }
  }
  throw last;
}

export async function runVoiceoverStep(
  step: { id: string; payload: unknown; user: { workspaceId: string } },
  scope: AttemptScope,
  gate: ProviderGate,
  log: (line: string) => void = (line) => console.log(line),
): Promise<VoiceoverResult> {
  const { script, voice } = voiceoverPayloadSchema.parse(step.payload);
  if (!voiceConfigured()) throw new Error("Voiceover is not set up on this server (VOICE_ENABLED, VOICE_TTS_URL, VOICE_TTS_KEY).");
  const workspaceId = step.user.workspaceId;
  const objectKey = voiceoverKey(workspaceId, voice, script);

  let audio = await savedAudio(objectKey, scope, log);
  if (audio) log(`voiceover: reusing the saved audio for step ${step.id}; nothing sent to the voice service`);
  else {
    await gate.beforeRequest();
    try {
      audio = await synthesiseLine(script, presenterVoice(voice), scope.signal);
    } catch (error) {
      // An error answer is a definite outcome; no answer is not, and stays in flight (the step is then UNRESOLVED).
      if (error instanceof VoiceServiceAnswered) gate.answered();
      throw error;
    }
    gate.answered();
    await saveAudio(objectKey, audio, voice, scope);
  }

  const workdir = await scope.tempDir("reelwalk-voiceover-");
  const file = path.join(workdir, "voiceover.mp3");
  await writeFile(file, audio);
  const [transcript, probed] = await Promise.all([
    transcribeVideo(file, workdir, 60, scope),
    run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { scope }),
  ]);
  const durationMs = Math.round(Number(probed.stdout) * 1000) || null;
  const fields = { durationMs, transcript: transcript ?? undefined, sizeBytes: BigInt(audio.byteLength) };
  const asset = await prisma.mediaAsset.upsert({
    where: { objectKey },
    create: {
      workspaceId,
      kind: "AUDIO",
      objectKey,
      contentType: "audio/mpeg",
      fileName: `Voiceover: ${script.slice(0, 60)}${script.length > 60 ? "…" : ""}.mp3`,
      // An AI voice, said so wherever the asset's credit is shown.
      attribution: `AI voice (${voice.replace("aura-2:", "Deepgram Aura-2 ")})`,
      ...fields,
    },
    update: fields,
    select: { id: true },
  });
  return { assetId: asset.id, durationMs, transcript };
}
