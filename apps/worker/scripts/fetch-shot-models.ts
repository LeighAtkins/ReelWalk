// Caches the shot-analysis models (ADR 0086) into the worker image at build time (see apps/worker/Dockerfile), so a
// task never downloads them: MobileCLIP-S0's image tower (45 MB) and Depth Anything V2 small int8 (27 MB).
// With --prompts it also rewrites src/shot-iqa-prompts.json, the precomputed text embeddings of the aesthetic prompt
// pairs, which is the only use of the text tower (so the worker never loads it). Run with tsx.
import { writeFileSync } from "node:fs";
import { AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, env, pipeline } from "@huggingface/transformers";
import { AESTHETIC_MODEL, DEPTH_MODEL } from "../src/shot-analysis";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: tsx scripts/fetch-shot-models.ts <cache-dir> [--prompts]");
env.cacheDir = dir;
env.allowRemoteModels = true;
await AutoProcessor.from_pretrained(AESTHETIC_MODEL);
await CLIPVisionModelWithProjection.from_pretrained(AESTHETIC_MODEL, { dtype: "fp32" } as never);
await pipeline("depth-estimation", DEPTH_MODEL, { dtype: "q8" } as never);
console.log(`cached ${AESTHETIC_MODEL} (vision) and ${DEPTH_MODEL} in ${dir}`);

if (process.argv.includes("--prompts")) {
  // CLIP-IQA style antonym pairs (Wang et al., 2023): [good, bad] × 3, the general pair first.
  const prompts = [
    "Good photo.", "Bad photo.",
    "A beautiful, well composed photograph of a home.", "An ugly, badly composed snapshot.",
    "A sharp, well lit, professional real estate photo.", "A blurry, dark, amateur phone photo.",
  ];
  const tokenizer = await AutoTokenizer.from_pretrained(AESTHETIC_MODEL);
  const text = await CLIPTextModelWithProjection.from_pretrained(AESTHETIC_MODEL, { dtype: "fp32" } as never);
  // MobileCLIP's text tower takes exactly 77 tokens.
  const { text_embeds } = (await text(tokenizer(prompts, { padding: "max_length", max_length: 77, truncation: true } as never))) as { text_embeds: { tolist(): number[][] } };
  const embeds = text_embeds.tolist().map((v) => { const n = Math.hypot(...v); return v.map((x) => Math.round((x / n) * 1e5) / 1e5); });
  writeFileSync(new URL("../src/shot-iqa-prompts.json", import.meta.url), JSON.stringify({ model: AESTHETIC_MODEL, prompts, embeds }));
  console.log("wrote src/shot-iqa-prompts.json");
}
