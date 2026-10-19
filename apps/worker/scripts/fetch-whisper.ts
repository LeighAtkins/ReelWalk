// Caches the speech-recognition model into the worker image at build time
// (see apps/worker/Dockerfile), so a render task never downloads it.
// Run with tsx, like ensure-browser.ts.
import { env, pipeline } from "@huggingface/transformers";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: node fetch-whisper.mjs <cache-dir>");
env.cacheDir = dir;
env.allowRemoteModels = true;
const model = process.env.TRANSCRIBE_MODEL || "onnx-community/whisper-small.en_timestamped";
await pipeline("automatic-speech-recognition", model, { dtype: "q8" });
console.log(`cached ${model} in ${dir}`);
