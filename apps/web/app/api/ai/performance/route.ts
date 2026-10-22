import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { AiError, isAiAvailable, structuredAnswer } from "@/lib/openai";
import { PERFORMANCE_MAX_MS } from "@reelwalk/core";

export const runtime = "nodejs";

/**
 * A performance reference described in words (ADR 0069): up to three frames
 * from a clip of at most three seconds (the editor cuts them through the
 * frame service), read by the same vision path as the director, answered as
 * one or two sentences the Veo prompt can carry ("a slow shrug, eyebrows up,
 * a half-smile at the end"). Nothing is stored; the editor puts the
 * description on the take's direction.
 */
const input = z.object({
  assetId: z.string().min(1).max(64),
  fromMs: z.number().int().min(0), toMs: z.number().int().min(0),
  frames: z.array(z.string().startsWith("data:image/jpeg;base64,").max(600_000)).min(1).max(3),
}).refine(ref => ref.toMs > ref.fromMs && ref.toMs - ref.fromMs <= PERFORMANCE_MAX_MS, "A performance reference is at most 3 seconds.");

const INSTRUCTIONS = [
  "You describe a short acting reference for a video generation prompt. The images are frames, in order, from up to three seconds of one person performing.",
  "Describe only what the person does with their face and body, in one or two plain sentences a director could repeat: expression, eyebrows, mouth, eye line, head movement, gesture, posture, pace of delivery.",
  "Never describe their identity, clothing, the room or anything that would change who the presenter is. Answer with JSON: { \"description\": string } of at most 300 characters.",
].join(" ");

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to describe a reference." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  if (!isAiAvailable()) return Response.json({ error: "Describing a reference is not set up on this deployment." }, { status: 409 });
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Choose up to three frames from at most three seconds." }, { status: 400 });
  try {
    const answer = await structuredAnswer({
      instructions: INSTRUCTIONS, input: `Frames from ${(parsed.data.fromMs / 1000).toFixed(1)} s to ${(parsed.data.toMs / 1000).toFixed(1)} s of the reference clip.`,
      images: parsed.data.frames, schemaName: "performance_reference",
      schema: { type: "object", additionalProperties: false, required: ["description"], properties: { description: { type: "string" } } },
      maxOutputTokens: 200,
    });
    const description = z.object({ description: z.string().trim().min(3).max(400) }).safeParse(answer.json);
    if (!description.success) return Response.json({ error: "The reference could not be described." }, { status: 502 });
    return Response.json({ description: description.data.description.slice(0, 400) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof AiError ? error.message : "The reference could not be described." }, { status: 502 });
  }
}
