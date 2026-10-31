import { createHash } from "node:crypto";
import { DEFAULT_VOICE, isVoiceId, timelineDurationMs, transcriptSchema, VOICEOVER_MAX_CHARS, type Command, type Transcript } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { applyReelCommand, loadReel } from "./reel-command";
import { startWorkerStepRun } from "./workflows";

/**
 * A spoken voiceover (ADR 0099), from the web side: the worker speaks and
 * transcribes the script (the "voiceover" step), and this sets it on the reel
 * with its captions as one saved revision. The reel is lengthened first when
 * the voiceover would run past its end, so no word is cut off.
 */

export function voiceoverAvailable(): boolean {
  return process.env.VOICE_ENABLED === "true";
}

/** Fixed per reel, script and voice: asking again for the same line resumes (or reuses) the same step. */
export const voiceoverRequestId = (reelId: string, script: string, voice: string) =>
  `voiceover:${reelId}:${createHash("sha256").update(`${voice}\n${script}`).digest("hex").slice(0, 24)}`;

/** What the reel needs to hold the voiceover: its start, its length and a breath after the last word. */
export const VOICEOVER_TAIL_MS = 600;

export type VoiceoverDeps = {
  start: typeof startWorkerStepRun;
  /** The step's state; tests replace it. */
  step: (id: string) => Promise<{ status: string; result: unknown; error: string | null } | null>;
  sleep: (ms: number) => Promise<void>;
};

const defaultDeps: VoiceoverDeps = {
  start: startWorkerStepRun,
  step: (id) => prisma.workflowStep.findUnique({ where: { id }, select: { status: true, result: true, error: true } }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type AddVoiceover =
  | {
      ok: true; revision: number; assetId: string; durationMs: number | null; captions: number; lengthenedTo: number | null;
      /** How far the voiceover still runs past the reel's end (shots are at most 5 s each when lengthened); 0 when it fits. */
      shortByMs: number;
      changes: string[];
    }
  | { ok: false; status: number; message: string };

export async function addVoiceover(
  user: { id: string; workspaceId: string },
  input: { reelId: string; script: string; voice?: string; captions?: boolean; atMs?: number; waitMs?: number },
  deps: VoiceoverDeps = defaultDeps,
): Promise<AddVoiceover> {
  if (!voiceoverAvailable()) return { ok: false, status: 503, message: "Voiceover is not set up on this server." };
  const script = input.script.trim().replace(/\s+/g, " ");
  if (script.length < 2 || script.length > VOICEOVER_MAX_CHARS) return { ok: false, status: 400, message: `A voiceover script is 2 to ${VOICEOVER_MAX_CHARS} characters: two to four short sentences.` };
  const voice = input.voice ?? DEFAULT_VOICE;
  if (!isVoiceId(voice)) return { ok: false, status: 400, message: `${voice} is not one of the voices offered.` };
  const atMs = Math.max(0, Math.round(input.atMs ?? 0));
  if (!(await loadReel(user, input.reelId))) return { ok: false, status: 404, message: "No reel with that id in this account." };

  const started = await deps.start({ user, kind: "voiceover", requestId: voiceoverRequestId(input.reelId, script, voice), payload: { script, voice } });
  if (!started.ok) return { ok: false, status: started.status, message: started.message };

  // The worker may need a cold start (a minute or two) before it speaks and transcribes the line in seconds.
  const until = Date.now() + (input.waitMs ?? 4 * 60_000);
  let state = await deps.step(started.jobId);
  while (state && state.status !== "SUCCEEDED" && state.status !== "FAILED" && state.status !== "UNRESOLVED" && Date.now() < until) {
    await deps.sleep(2000);
    state = await deps.step(started.jobId);
  }
  // No answer came back for the paid request: it may have been made. It is never sent again on its own (ADR 0099).
  if (state?.status === "UNRESOLVED") return { ok: false, status: 502, message: "No answer came back from the voice service, so this line may or may not have been made. It is not sent again automatically, so it is never paid for twice; reword the script to ask for a new line." };
  // A failure after the audio arrived keeps the audio: asking again for the same line reuses it without paying again.
  if (!state || state.status === "FAILED") return { ok: false, status: 502, message: `The voiceover could not be made: ${state?.error ?? "the step is missing"}. Asking again for the same line reuses any audio already made.` };
  if (state.status !== "SUCCEEDED") return { ok: false, status: 504, message: "The voiceover is still being made. Ask again in a minute; the same line picks up where it is." };

  const result = state.result as { assetId?: unknown; durationMs?: unknown; transcript?: unknown } | null;
  if (typeof result?.assetId !== "string") return { ok: false, status: 502, message: "The voiceover step answered without an asset." };
  const durationMs = typeof result.durationMs === "number" ? result.durationMs : null;
  const parsed = transcriptSchema.safeParse(result.transcript);
  const transcript: Transcript | null = parsed.success ? parsed.data : null;

  // Read the reel only now: whatever was saved while the voice was made is kept.
  const loaded = await loadReel(user, input.reelId);
  if (!loaded) return { ok: false, status: 404, message: "This reel was deleted." };
  const needed = durationMs ? atMs + durationMs + VOICEOVER_TAIL_MS : 0;
  const lengthen = needed > timelineDurationMs(loaded.timeline) && loaded.timeline.clips.length > 0;
  const commands = [
    ...(lengthen ? [{ type: "retimeToLength" as const, totalMs: needed }] : []),
    { type: "setVoiceover" as const, voiceover: { assetId: result.assetId, atMs, volume: 1, script, voice }, transcript, captions: input.captions !== false },
  ];
  const command: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
  const outcome = await applyReelCommand(user, loaded, command);
  if (!outcome.ok) return { ok: false, status: outcome.status, message: outcome.message };
  const captions = outcome.result.timeline.texts.filter((text) => text.id.startsWith("vo-")).length;
  return {
    ok: true,
    revision: outcome.revision,
    assetId: result.assetId,
    durationMs,
    captions,
    lengthenedTo: lengthen ? timelineDurationMs(outcome.result.timeline) : null,
    shortByMs: Math.max(0, needed - timelineDurationMs(outcome.result.timeline)),
    changes: outcome.result.changes.map((change) => ("id" in change ? `${change.kind} ${change.id}` : change.kind === "other" ? change.key : change.kind)),
  };
}
