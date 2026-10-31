import { z } from "zod";
import { parseTimeline, timelineGeneration, type ListingInfo } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { askForChange, newAssets } from "./ai-edit";
import { makeItForMe } from "./autopilot";
import { directorInput, directReel } from "./ai-director";
import { withProviderGate, type ProviderGate } from "./provider-gate";

/**
 * The AI steps themselves (Ask, autopilot polish, one Director review), in
 * one place so the in-process path (ADR 0021) and the worker (ADR 0049) run
 * exactly the same code and prompts. This module and everything it imports
 * must stay free of Next.js: the worker imports it.
 */

/**
 * "music-analysis" (ADR 0066) decodes a track with ffmpeg; "block-solve" and "block-reveal" (ADR 0093) read a drone
 * clip in 3D and draw its reveal. They run only in the worker and never call a paid provider.
 */
export type AiStepKind = "ask" | "autopilot" | "director-review" | "music-analysis" | "block-solve" | "block-reveal" | "voiceover";

export const askPayload = z.object({
  request: z.string(),
  timeline: z.unknown(),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).max(3),
});
export const autopilotPayload = z.object({
  timeline: z.unknown(),
  styleId: z.string(),
  info: z.record(z.string(), z.string()),
});

export type StepUser = { id: string; workspaceId: string };

/** The message a failed Director review shows (the same words the in-process route used). */
export function directorFailureMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : "unknown";
  return reason === "Could not reach Claude." ? "Opus took too long to answer. Try again; nothing was changed." : `Opus could not finish: ${reason.slice(0, 200)}`;
}

/**
 * Runs one step and returns what the route used to answer. Every result that
 * proposes a timeline also carries `baselineGeneration`: the generation of
 * the timeline it was made from (ADR 0049's proposal contract).
 *
 * With a `gate`, every paid provider request the step makes (room labels,
 * the edit plan, the Opus review) first passes `gate.beforeRequest` and
 * reports `gate.answered` when a response arrives (lib/provider-gate.ts).
 */
export async function runAiStep(input: StepInput, gate?: ProviderGate): Promise<unknown> {
  return gate ? withProviderGate(gate, () => runStep(input)) : runStep(input);
}

/**
 * `identity` is the request's own, stable across replays: the durable step and
 * its generation in the worker, the job in the in-process path. A request that
 * spends the month's allowance reserves under it, so a replay is charged once.
 */
type StepInput = { kind: AiStepKind; user: StepUser; reelId: string; payload: unknown; identity?: string };

async function runStep(input: StepInput): Promise<unknown> {
  if (input.kind === "music-analysis") throw new Error("A track is analysed by the worker, not here.");
  if (input.kind === "block-solve" || input.kind === "block-reveal") throw new Error("Walk the block runs in the worker, not here.");
  if (input.kind === "voiceover") throw new Error("A voiceover is spoken and transcribed by the worker, not here.");
  const reel = await prisma.reel.findFirst({ where: { id: input.reelId, workspaceId: input.user.workspaceId }, select: { id: true, title: true } });
  if (!reel) throw new Error("This reel was deleted.");
  if (input.kind === "ask") {
    const payload = askPayload.parse(input.payload);
    const timeline = parseTimeline(payload.timeline);
    const result = await askForChange({ user: input.user, reel, timeline, request: payload.request, answers: payload.answers, reservationKey: input.identity });
    return result.ok ? { ...result, baselineGeneration: timelineGeneration(timeline), assets: await newAssets(input.user.workspaceId, timeline, result.timeline) } : result;
  }
  if (input.kind === "autopilot") {
    const payload = autopilotPayload.parse(input.payload);
    const timeline = parseTimeline(payload.timeline);
    const result = await makeItForMe({ user: input.user, reel, timeline, styleId: payload.styleId, info: payload.info as ListingInfo, reservationKey: input.identity });
    return result.ok ? { ...result, baselineGeneration: timelineGeneration(timeline), assets: await newAssets(input.user.workspaceId, timeline, result.timeline) } : result;
  }
  const payload = directorInput.parse(input.payload);
  const result = await directReel(input.user, reel, payload);
  return { ...result, baselineGeneration: timelineGeneration(result.baseline) };
}
