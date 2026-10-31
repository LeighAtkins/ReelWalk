import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { isVoiceId, VOICEOVER_MAX_CHARS, type Transcript } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { z } from "zod";
import { getConfig } from "./config";
import { run, s3 } from "./library/tools";
import type { AttemptScope } from "./lifecycle";
import { transcribeVideo } from "./transcribe";
import { presenterVoice, synthesiseLine, voiceConfigured } from "./voice";

/**
 * The "voiceover" step (ADR 0099): a script spoken in the chosen voice by our
 * voice Worker (Workers AI), transcribed here with word timings (the web
 * container has no speech model), and kept as an AUDIO library asset. The
 * reel's voiceover and its captions are then set from the asset by the web
 * app. Speech is cheap (Workers AI) and the result is keyed by the step, so
 * a retried attempt writes the same object and the same row.
 */

export const voiceoverPayloadSchema = z.object({
  script: z.string().trim().min(1).max(VOICEOVER_MAX_CHARS),
  voice: z.string().refine(isVoiceId, "That voice is not one of the voices offered."),
});

export type VoiceoverResult = { assetId: string; durationMs: number | null; transcript: Transcript | null };

/** Where a step's voiceover is stored. */
export const voiceoverKey = (workspaceId: string, stepId: string) => `workspaces/${workspaceId}/voiceover/${stepId}.mp3`;

export async function runVoiceoverStep(step: { id: string; payload: unknown; user: { workspaceId: string } }, scope: AttemptScope): Promise<VoiceoverResult> {
  const { script, voice } = voiceoverPayloadSchema.parse(step.payload);
  if (!voiceConfigured()) throw new Error("Voiceover is not set up on this server (VOICE_ENABLED, VOICE_TTS_URL, VOICE_TTS_KEY).");
  const audio = await synthesiseLine(script, presenterVoice(voice));
  const workdir = await scope.tempDir("reelwalk-voiceover-");
  const file = path.join(workdir, "voiceover.mp3");
  await writeFile(file, audio);
  const [transcript, probed] = await Promise.all([
    transcribeVideo(file, workdir, 60, scope),
    run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { scope }),
  ]);
  const durationMs = Math.round(Number(probed.stdout) * 1000) || null;
  const workspaceId = step.user.workspaceId;
  const objectKey = voiceoverKey(workspaceId, step.id);
  await s3.send(new PutObjectCommand({ Bucket: getConfig().s3Bucket, Key: objectKey, Body: audio, ContentLength: audio.byteLength, ContentType: "audio/mpeg" }), { abortSignal: scope.signal });
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
