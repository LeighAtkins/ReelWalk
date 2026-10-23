/**
 * Side-by-side check of Claude direct against Claude on Google Cloud (ADR 0072).
 *
 * Sends the same three real prompts the app sends (an Ask change, the
 * draft-review text critique, hook lines) to `anthropic` and to `vertex`, and
 * prints both answers with token usage and list-price cost, so the owner can
 * see parity before switching AI_PROVIDER. Costs about six small Opus calls.
 *
 *   pnpm ai:compare                 # both providers (from the repo root)
 *   pnpm ai:compare -- --only vertex
 *   (= pnpm --filter @reelwalk/web exec tsx scripts/compare-ai-providers.mts)
 *
 * Refuses to run unless both providers are configured in the environment
 * (ANTHROPIC_API_KEY; GOOGLE_CLOUD_PROJECT plus the federation pair or
 * GOOGLE_APPLICATION_CREDENTIALS). Prints variable names only, never values.
 */
import { AI_EDIT_PLAN_JSON_SCHEMA, AI_EDIT_SYSTEM_PROMPT, describeReel, parseTimeline, type AiAsset, type AiSong } from "@reelwalk/core";
import { AiError, structuredAnswer, usageCostUsd, vertexConfig, type AiProvider } from "../lib/openai";

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const providers: AiProvider[] = only === "anthropic" || only === "vertex" ? [only] : ["anthropic", "vertex"];

const present = (name: string) => { const value = process.env[name]?.trim(); return Boolean(value) && value !== "unset"; };
const missing: string[] = [];
if (providers.includes("anthropic") && !present("ANTHROPIC_API_KEY")) missing.push("ANTHROPIC_API_KEY");
if (providers.includes("vertex") && !vertexConfig()) missing.push("GOOGLE_CLOUD_PROJECT and (GOOGLE_WORKLOAD_IDENTITY_AUDIENCE + GOOGLE_SERVICE_ACCOUNT_EMAIL, or GOOGLE_APPLICATION_CREDENTIALS)");
if (missing.length) {
  console.error(`compare-ai-providers: not configured, nothing sent. Set: ${missing.join("; ")}.`);
  process.exit(2);
}

// The reel from packages/core/tests/ai-edit.test.ts: two rooms, one title, one song.
const assets: Record<string, AiAsset> = {
  k: { id: "k", kind: "VIDEO", title: "kitchen pan", durationMs: 12000, isPano: false, bpm: null, beatOffsetMs: null },
  l: { id: "l", kind: "IMAGE", title: "lounge", durationMs: null, isPano: false, bpm: null, beatOffsetMs: null },
  s1: { id: "s1", kind: "AUDIO", title: "Carefree", durationMs: 120000, isPano: false, bpm: 96, beatOffsetMs: 120 },
};
const songs: AiSong[] = [{ id: "s1", title: "Carefree", bpm: 96, mood: "light, bouncy ukulele; cheerful" }];
const timeline = parseTimeline({
  version: 1,
  clips: [
    { id: "c1", assetId: "k", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000, room: "kitchen" },
    { id: "c2", assetId: "l", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000, motion: "zoom-in", room: "living room" },
  ],
  texts: [{ id: "t1", text: "Just listed", startMs: 0, endMs: 3000, style: "headline" }],
  music: { assetId: "s1", sourceStartMs: 0, volume: 0.8, bpm: 96, beatOffsetMs: 120 },
  plan: null,
  details: null,
});

const LINES_SCHEMA = { type: "object", additionalProperties: false, required: ["lines"], properties: { lines: { type: "array", items: { type: "string" } } } };
const TEXT_SCHEMA = { type: "object", additionalProperties: false, required: ["options"], properties: { options: { type: "array", items: { type: "string" }, description: "Exactly three" } } };

type Prompt = Parameters<typeof structuredAnswer>[0] & { label: string };
const prompts: Prompt[] = [
  {
    label: "ask: a change to the reel (reel_edit_plan)",
    instructions: AI_EDIT_SYSTEM_PROMPT,
    input: `${describeReel({ title: "Maple Street listing", timeline, assets, songs })}\n\nThe user asks: Slow the kitchen shot down a little and move the title onto the living room.`,
    schemaName: "reel_edit_plan", schema: AI_EDIT_PLAN_JSON_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 8000,
  },
  {
    // Copied from apps/web/app/api/reels/[id]/ideas/route.ts (kind "text"): the draft review's critique of one line.
    label: "text critique: three alternatives for one line (text_options)",
    instructions: "You write the short on-screen text for vertical real-estate listing reels. Given one line from a reel, offer exactly three alternatives: same meaning, the same length or shorter, plain words a buyer would stop for, no hashtags, no emoji. Keep any facts (prices, addresses, times) exactly as given. If the line has a line break, the alternatives may use one too.",
    input: `The reel is "Maple Street listing". The line: Just listed`,
    schemaName: "text_options", schema: TEXT_SCHEMA, maxOutputTokens: 300,
  },
  {
    // Copied from the same route (kind "hooks", ADR 0068).
    label: "hook lines: five openings (hook_lines)",
    instructions: `You write the opening line of vertical real-estate reels: the words on screen in the first second that stop a thumb. Write exactly 5 different hook lines for this reel. Each is 3 to 8 words, plain and specific, one of: a question the viewer answers for themselves, a promise of what they will see if they stay, a surprising fact from the facts given, or a pattern interrupt ("Nobody shows you this room"). No hashtags, no emoji, no exclamation marks, no clickbait that the reel cannot pay off, no prices, addresses or sizes unless they appear in the facts. Use only rooms and facts given.`,
    input: `Reel "Maple Street listing". Rooms shown: kitchen, living room. Text on the reel: "Just listed". Facts: none given.`,
    schemaName: "hook_lines", schema: LINES_SCHEMA, maxOutputTokens: 400,
  },
];

type Row = { label: string; provider: AiProvider; model: string; seconds: number; usage: unknown; costUsd: number; error?: string };
const rows: Row[] = [];
const previous = process.env.AI_PROVIDER;
for (const prompt of prompts) {
  for (const provider of providers) {
    process.env.AI_PROVIDER = provider;
    const { label, ...options } = prompt;
    const started = Date.now();
    console.log(`\n=== ${label} — ${provider} ===`);
    try {
      const answer = await structuredAnswer({ ...options, signal: AbortSignal.timeout(180_000) });
      const seconds = Math.round((Date.now() - started) / 10) / 100;
      const costUsd = usageCostUsd(answer.model, answer.usage, { provider, vertexRegion: provider === "vertex" ? vertexConfig()?.region : undefined });
      rows.push({ label, provider, model: answer.model, seconds, usage: answer.usage, costUsd });
      console.log(JSON.stringify({ model: answer.model, seconds, usage: answer.usage, costUsd: Number(costUsd.toFixed(5)) }));
      console.log(JSON.stringify(answer.json, null, 2));
    } catch (error) {
      // AiError messages carry status codes, never provider bodies; anything else is reported by name only.
      const message = error instanceof AiError ? `${error.message} (${error.transient ? "transient" : "not transient"})` : error instanceof Error ? error.name : String(error);
      rows.push({ label, provider, model: "-", seconds: Math.round((Date.now() - started) / 10) / 100, usage: null, costUsd: 0, error: message });
      console.log(`failed: ${message}`);
    }
  }
}
process.env.AI_PROVIDER = previous;

console.log("\n=== summary ===");
console.table(rows.map((row) => ({ prompt: row.label.split(":")[0], provider: row.provider, model: row.model, seconds: row.seconds, costUsd: Number(row.costUsd.toFixed(5)), error: row.error ?? "" })));
process.exit(rows.some((row) => row.error) ? 1 : 0);
