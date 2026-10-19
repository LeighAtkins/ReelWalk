/**
 * Live smoke check for the Opus director path (villa post-mortem item 11).
 * Sends the real system prompt and plan schema with a small made-up reel,
 * no images, and runs the answer through the same parsing the app uses.
 * Two production failures (a schema Claude rejected, an empty note the
 * parser rejected) would both have shown up here before a deploy.
 *
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=... pnpm --filter @reelwalk/web exec tsx scripts/director-smoke.mts
 *
 * Costs one small Opus call. Exits non-zero on any failure.
 */
import { AI_EDIT_SYSTEM_PROMPT, DIRECTOR_INSTRUCTIONS, DIRECTOR_PLAN_JSON_SCHEMA, applyAiEditPlan, clipSchema, describeReel, directorPlanSchema, emptyTimeline, parseTimeline, validateDirectorReferences, type AiAsset } from "@reelwalk/core";
import { structuredAnswer } from "../lib/openai";

const assets: Record<string, AiAsset> = {
  "living-pan": { id: "living-pan", kind: "VIDEO", title: "living room pan", durationMs: 5300, isPano: false, bpm: null, beatOffsetMs: null, room: "living room" },
  "bedroom": { id: "bedroom", kind: "VIDEO", title: "bedroom", durationMs: 5700, isPano: false, bpm: null, beatOffsetMs: null, room: "bedroom" },
  "ai-take": { id: "ai-take", kind: "VIDEO", title: "AI presenter walk", durationMs: 4000, isPano: false, bpm: null, beatOffsetMs: null, aiGenerated: true },
};
const timeline = parseTimeline({ ...emptyTimeline(), clips: [
  clipSchema.parse({ id: "a", assetId: "living-pan", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 5300 }),
  clipSchema.parse({ id: "b", assetId: "bedroom", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 5700 }),
] });
const available = { assets, songs: [], unused: [assets["ai-take"]] };

const started = Date.now();
const answer = await structuredAnswer({
  instructions: `${AI_EDIT_SYSTEM_PROMPT}\n\n${DIRECTOR_INSTRUCTIONS}`,
  input: `${describeReel({ title: "Smoke test", timeline, ...available })}\n\nUser brief: Tighten this to about 8 seconds and propose one 4-second AI shot of the presenter walking through the living room. No source frame sheets were supplied; say so in limitations.\n\nConfirmed AI-generated asset IDs: ["ai-take"]\nReview candidates: ["ai-take"]\nSource frame sheets in order: []`,
  schemaName: "opus_director", schema: DIRECTOR_PLAN_JSON_SCHEMA as unknown as Record<string, unknown>,
  maxOutputTokens: 12000, signal: AbortSignal.timeout(240_000),
});
const plan = directorPlanSchema.parse(answer.json);
validateDirectorReferences(plan, available.assets);
const applied = applyAiEditPlan(timeline, plan.edit, { ...available, newId: () => "smoke" });
console.log(JSON.stringify({
  ok: true, model: answer.model, seconds: Math.round((Date.now() - started) / 1000), usage: answer.usage,
  verdict: plan.verdict, ops: plan.edit.ops.length, shots: plan.shots.map(s => ({ title: s.title, seconds: s.durationSeconds, voice: s.voice, compose: Boolean(s.compose) })),
  applied: applied.applied.length, skipped: applied.skipped.length, note: plan.note.slice(0, 160),
}, null, 2));
