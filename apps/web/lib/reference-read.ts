import {
  EFFECT_FAMILIES, EFFECT_NOTES, isNamedEffect, parseReferenceRead, REFERENCE_READ_JSON_SCHEMA, TEXT_ANIMATIONS,
  type NamedEffect, type ReferenceAnalysis, type ReferenceRead,
} from "@reelwalk/core";
import { structuredAnswer, type AiUsage } from "./openai";

/**
 * Reading a style reference's titles (ADR 0102): the worker has measured the reel (cuts, motion, beat, speech) and
 * saved keyframes; this asks the model what titles are on them, where, and how they arrive, in the recipe's own
 * vocabulary of effects. Runs in the worker (a "reference-read" step) through the provider gate, so it is one paid
 * request per reading. Kept free of Next.js: the worker imports it.
 */

const OWN_EFFECTS = TEXT_ANIMATIONS.filter((a) => a !== "auto" && !isNamedEffect(a));

export const REFERENCE_READ_INSTRUCTIONS = [
  "You read a short vertical video's on-screen text from its keyframes and describe its style so another video can follow it.",
  "The keyframes come in time order; each is labelled with its time in milliseconds. Titles that animate are caught part-way, so compare neighbouring frames to see how each one arrives.",
  "List every distinct piece of on-screen text (captions, headlines, labels inside a demo, handles), once each, with when it is first and last visible (ms, from the keyframe times), its box as fractions of the frame (x, y from the top left; w, h), and the effect it arrives with.",
  "Ignore the platform's own interface (like counts, buttons) but include text that is part of the video, such as a watermark or handle burned into it.",
  "Effects: use one of these names when it fits; otherwise use \"other\" and describe the motion in effectNote.",
  `ReelWalk's own: ${OWN_EFFECTS.join(", ")} (pop: scales in; fade; rise: slides up; type: typed letter by letter with a cursor; none: a hard cut; fadeQuick; maskUp: rises through an edge; trackIn: letter-spacing closes; blurIn and blurQuick: out of a blur).`,
  ...Object.entries(EFFECT_FAMILIES).map(([family, members]) => `${family}: ${(members as readonly NamedEffect[]).map((m) => `${m} (${EFFECT_NOTES[m]})`).join("; ")}.`),
  "look: a few plain words about the type (weight, case, colour, any plate, outline or highlight). color: the dominant text colour as #rrggbb, or null. spoken: true when the text shows words being said aloud (the transcript is given), false for written headlines or labels, null when unsure.",
  "format: one or two sentences on the video's shape (talking head, a grid of demo tiles, a walkthrough, an outro card) and how the text is used.",
  "notes: up to five short things a video following this style should copy (a recurring layout, a colour pairing, an outro, a pacing habit). Do not invent anything the frames do not show.",
].join("\n");

export type ReferenceFrame = { atMs: number; dataUrl: string };

/** The changing part of the request: the measurements and the keyframe labels, in the order the images follow. */
export function referenceReadInput(analysis: ReferenceAnalysis, frames: readonly ReferenceFrame[]): string {
  const shots = analysis.shots.map((s, i) => `${i + 1}: ${s.startMs}-${s.endMs} ms${s.motion !== undefined ? `, motion ${s.motion}` : ""}`).join("; ");
  const speech = analysis.words.length
    ? analysis.words.map((w) => `${w.text}@${w.startMs}`).join(" ").slice(0, 6000)
    : "(no speech)";
  return [
    `Duration: ${analysis.durationMs} ms${analysis.width && analysis.height ? `, ${analysis.width}x${analysis.height}` : ""}.`,
    `Shots (measured cuts): ${shots || "one shot"}.`,
    `Beat: ${analysis.beat ? `${Math.round(analysis.beat.bpm)} BPM` : "none found"}.`,
    `Transcript (word@ms): ${speech}`,
    `Keyframes, in the order of the images: ${frames.map((f, i) => `#${i + 1} at ${f.atMs} ms`).join(", ")}.`,
  ].join("\n");
}

/**
 * Asks the model to read the keyframes. Returns the cleaned reading (parseReferenceRead) and the request's usage.
 * The request is under the workspace's AI switch (structuredAnswer checks it) and, in the worker, the provider gate.
 */
export async function readReference(input: {
  workspaceId: string;
  analysis: ReferenceAnalysis;
  frames: readonly ReferenceFrame[];
  signal?: AbortSignal;
}): Promise<{ read: ReferenceRead; usage: AiUsage; model: string }> {
  if (input.frames.length === 0) throw new Error("No keyframes to read.");
  const answer = await structuredAnswer({
    workspaceId: input.workspaceId,
    instructions: REFERENCE_READ_INSTRUCTIONS,
    input: referenceReadInput(input.analysis, input.frames),
    images: input.frames.map((f) => f.dataUrl),
    // Small labels inside a demo grid are only legible at high detail.
    imageDetail: "high",
    schemaName: "style_reference_read",
    schema: REFERENCE_READ_JSON_SCHEMA as unknown as Record<string, unknown>,
    maxOutputTokens: 8000,
    signal: input.signal,
  });
  return { read: parseReferenceRead(answer.json, input.analysis.durationMs), usage: answer.usage, model: answer.model };
}
