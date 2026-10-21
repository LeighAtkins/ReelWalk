import { readFile } from "node:fs/promises";
import path from "node:path";
import { transcriptSchema, type Transcript } from "@reelwalk/core";
import { run } from "./library/tools";
import type { AttemptScope } from "./lifecycle";

/**
 * Speech recognition for uploaded videos, on the CPU, in process. Whisper
 * (small, English, exported with the attention outputs that word timings
 * need) runs through onnxruntime; the model is baked into the worker image
 * at TRANSCRIBE_MODEL_DIR by scripts/fetch-whisper.mjs, so nothing is
 * downloaded at run time.
 */

const MODEL = process.env.TRANSCRIBE_MODEL || "onnx-community/whisper-small.en_timestamped";
const SAMPLE_RATE = 16000;

export function transcriptionAvailable(): boolean {
  return process.env.TRANSCRIBE_ENABLED !== "false" && Boolean(process.env.TRANSCRIBE_MODEL_DIR);
}

type Recogniser = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text?: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;
let recogniser: Promise<Recogniser> | null = null;

async function loadRecogniser(): Promise<Recogniser> {
  recogniser ??= (async () => {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = process.env.TRANSCRIBE_MODEL_DIR!;
    // A missing model is a build mistake, not a reason to reach the internet from a render task.
    env.allowRemoteModels = process.env.TRANSCRIBE_ALLOW_DOWNLOAD === "true";
    return (await pipeline("automatic-speech-recognition", MODEL, { dtype: "q8" })) as unknown as Recogniser;
  })();
  return recogniser;
}

/**
 * Words with timings for the speech in a video, or null when it has no audio
 * track or nothing recognisable. Only the first `maxSeconds` are read.
 */
export async function transcribeVideo(input: string, workdir: string, maxSeconds = 180, scope?: AttemptScope): Promise<Transcript | null> {
  const pcm = path.join(workdir, "speech.pcm");
  try {
    await run("ffmpeg", ["-v", "error", "-y", "-i", input, "-map", "0:a:0", "-t", String(maxSeconds), "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", pcm], { scope });
  } catch (error) {
    // A video with no audio track is common (silent AI shots, muted phone clips): nothing to transcribe.
    if (/matches no streams|does not contain any stream/i.test(String((error as { stderr?: string }).stderr ?? error))) return null;
    throw error;
  }
  scope?.throwIfStopped();
  const bytes = await readFile(pcm);
  if (bytes.length < SAMPLE_RATE) return null; // under half a second of audio
  const samples = new Int16Array(Uint8Array.from(bytes).buffer, 0, bytes.length >> 1);
  const audio = Float32Array.from(samples, (value) => value / 32768);
  const result = await (await loadRecogniser())(audio, { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 });
  const words = (result.chunks ?? [])
    .map((chunk) => ({
      w: chunk.text.trim(),
      s: Math.round((chunk.timestamp[0] ?? 0) * 1000),
      e: Math.round((chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0) * 1000),
    }))
    .filter((word) => word.w.length > 0 && word.e >= word.s);
  const text = (result.text ?? "").trim();
  if (!words.length || !/[a-z0-9]/i.test(text)) return null;
  return transcriptSchema.parse({ text, words, language: "en", model: MODEL });
}
