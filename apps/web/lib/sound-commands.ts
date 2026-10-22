import { z } from "zod";
import { AMBIENCE_TAGS, MAX_SFX, sfxClipSchema, type Command } from "@reelwalk/core";

/**
 * The sound commands an agent sends to `POST /api/reels/:id/sound` (ADR
 * 0066), read strictly here so a bad body is refused before it reaches the
 * command layer. Pure, so it is unit tested without a server.
 */

const ambienceTag = z.enum(AMBIENCE_TAGS);

export const autoSfxOptionsSchema = z
  .object({
    ambience: z.record(z.string().min(1).max(64), ambienceTag.nullable()).optional(),
    infer: z.boolean().optional(),
    revealMs: z.number().int().min(0).nullable().optional(),
    whooshHardCuts: z.boolean().optional(),
    noReveal: z.boolean().optional(),
  })
  .strict();

export const soundCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("autoSfx"), options: autoSfxOptionsSchema.optional() }).strict(),
  z.object({ type: z.literal("setSfx"), sfx: z.array(sfxClipSchema).max(MAX_SFX) }).strict(),
  /** `dropSongMs` may be left out: the route takes the drop from the track's analysis. */
  z.object({ type: z.literal("dropOnCut"), cut: z.number().int().min(1).max(200), dropSongMs: z.number().int().min(0).optional() }).strict(),
]);
export type SoundCommand = z.infer<typeof soundCommandSchema>;

export type SoundCommandRead = { ok: true; command: SoundCommand } | { ok: false; message: string };

/** The body of a sound request (`{ command }` or the command itself), or why it could not be read. */
export function readSoundCommand(body: unknown): SoundCommandRead {
  const source = body && typeof body === "object" && "command" in body ? (body as { command: unknown }).command : body;
  const parsed = soundCommandSchema.safeParse(source);
  if (parsed.success) return { ok: true, command: parsed.data };
  const first = parsed.error.issues[0];
  return { ok: false, message: first ? `${first.path.join(".") || "command"}: ${first.message}` : "Could not read the command." };
}

export type DropContext = {
  /** The analysed drop, song ms, when the track has been analysed. */
  dropMs: number | null;
  /** Where the reel's music says the drop was placed before, song ms. */
  dropSongMsFromMusic: number | null;
  /** The reel starts this far into the song (0 for an Instagram sound). */
  sourceStartMs: number;
  reelMs: number;
};

/**
 * The timeline command for a sound request. Auto placement is told where the
 * drop falls in reel time, so the riser ends on it; a drop placement without
 * a song time takes it from the analysis, and without either there is
 * nothing to place.
 */
export function toTimelineCommand(command: SoundCommand, context: DropContext): { ok: true; command: Command } | { ok: false; message: string } {
  switch (command.type) {
    case "autoSfx": {
      const reelDrop = context.dropMs === null ? null : context.dropMs - context.sourceStartMs;
      const dropMs = reelDrop !== null && reelDrop > 0 && reelDrop < context.reelMs ? reelDrop : null;
      return { ok: true, command: { type: "autoSfx", options: { ...command.options, ...(command.options?.revealMs === undefined ? { dropMs } : {}) } } };
    }
    case "setSfx":
      return { ok: true, command: { type: "setSfx", sfx: command.sfx } };
    case "dropOnCut": {
      const dropSongMs = command.dropSongMs ?? context.dropMs ?? context.dropSongMsFromMusic ?? null;
      if (dropSongMs === null) return { ok: false, message: "The track has not been analysed yet and no dropSongMs was given. Ask GET /api/music/:audioId/analysis first." };
      return { ok: true, command: { type: "dropOnCut", cut: command.cut, dropSongMs } };
    }
  }
}
