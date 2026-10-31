import { randomUUID } from "node:crypto";
import { addClips, emptyTimeline, isVoiceId, parseTimeline, voiceName, type Timeline, type VoiceId } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { aiAvailabilityReason } from "./ai-edit";
import { toLibraryAssets } from "./library";
import { clipForAsset } from "./mcp/clips";
import type { ActingUser } from "./mcp/acting-user";
import { mediaScope } from "./media-scope";
import { notesAvailable, startNote } from "./reel-thread";
import { voiceoverAvailable } from "./voiceover";

/**
 * Create (ADR 0098): one idea in, up to three short reels out. Each option is
 * a new reel with the owner's uploads already on it, and a create run (a note
 * whose words are the idea, ADR 0095) makes its first version and exports it.
 * The options differ by angle, so the owner picks between three takes rather
 * than three re-cuts of one. Nothing here spends AI video credits or posts:
 * the run finds stock and library footage, and the owner posts from the
 * export screen, where further notes change the cut.
 */

export type CreateAngle = { id: string; label: string; brief: string };

export const CREATE_ANGLES: CreateAngle[] = [
  { id: "hook", label: "Fast hook", brief: "Open on the single most striking shot with a bold claim or question as the hook. Quick cuts, about 1.5 s a shot, on the beat. Energetic music." },
  { id: "story", label: "Mini story", brief: "A short story with a beginning, a middle and a payoff: set the scene, walk through it, end on the best moment. Shots about 2.5 s. Warm music." },
  { id: "list", label: "Three reasons", brief: "A list: three or four reasons, tips or features, one per shot with one short text beat each, ending on a clear call to action. Steady pace." },
];

export const IDEA_MAX = 1000;
export const MEDIA_MAX = 20;

/** What the agent is told for one option: the idea in quotes (as a note is), the angle, the words-on-screen choice and what is on the reel. */
export function createBrief(input: { idea: string; angle: CreateAngle; captions: boolean; reelId: string; title: string; revision: number; uploads: number; voice?: VoiceId | null }): string {
  return [
    `Reel "${input.title}" (id ${input.reelId}), revision ${input.revision}. It is one of several options made from the same idea; this one's angle is "${input.angle.label}".`,
    input.uploads
      ? `The owner uploaded ${input.uploads} photo(s) or video(s) for this idea; they are already on the reel. Build around them; add stock or library footage only where they leave a gap.`
      : "The owner gave no footage: find it (stock or the starter library).",
    `Angle: ${input.angle.brief}`,
    input.captions ? "Captions: on (a hook title plus short text beats that carry the message)." : "Captions: off (the hook title only).",
    input.voice
      ? `Voiceover: yes, in ${voiceName(input.voice)} (voice ${input.voice}): write the script and add it with add_voiceover${input.captions ? "" : " with captions false"}.`
      : "Voiceover: none.",
    `The owner's idea:\n"""\n${input.idea}\n"""`,
  ].join("\n\n");
}

/** A short reel title from the idea's first words. */
export function titleFor(idea: string, angle: CreateAngle): string {
  const words = idea.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  const short = words.length > 48 ? `${words.slice(0, 47)}…` : words;
  return `${short} · ${angle.label}`;
}

export type CreatedOption = { reelId: string; title: string; angle: string; noteId: string };

export type StartCreate =
  | { ok: true; options: CreatedOption[]; /** Options that could not start (the month's AI requests ran out part-way). */ skipped: number; message?: string }
  | { ok: false; status: number; message: string; upgrade?: boolean };

export async function startCreate(input: { user: ActingUser; idea: string; mediaIds: string[]; options: number; captions: boolean; origin: string; voice?: string | null }): Promise<StartCreate> {
  const { user } = input;
  const idea = input.idea.trim();
  if (idea.length < 10 || idea.length > IDEA_MAX) return { ok: false, status: 400, message: `Describe the video in a sentence or two (10 to ${IDEA_MAX} characters).` };
  if (!notesAvailable()) return { ok: false, status: 503, message: "Create needs Claude, which is not set up on this deployment." };
  const unavailable = await aiAvailabilityReason(user.workspaceId);
  if (unavailable) return { ok: false, status: 403, message: unavailable.message, upgrade: unavailable.upgrade };
  const count = Math.max(1, Math.min(CREATE_ANGLES.length, Math.round(input.options) || 1));
  if (input.voice && !isVoiceId(input.voice)) return { ok: false, status: 400, message: "That voice is not one of the voices offered." };
  // A voice is asked for only where the server can speak; elsewhere the options are made without one.
  const voice: VoiceId | null = input.voice && isVoiceId(input.voice) && voiceoverAvailable() ? input.voice : null;
  const mediaIds = [...new Set(input.mediaIds)].slice(0, MEDIA_MAX);

  let base: Timeline = emptyTimeline();
  if (mediaIds.length) {
    const rows = await prisma.mediaAsset.findMany({ where: { id: { in: mediaIds }, ...mediaScope(user.workspaceId) } });
    const assets = new Map((await toLibraryAssets(rows)).map((asset) => [asset.id, asset]));
    const placeable = mediaIds.map((id) => assets.get(id)).filter((asset) => asset && asset.kind !== "AUDIO");
    if (placeable.length !== mediaIds.length) return { ok: false, status: 400, message: "Some of those files are not in this workspace's library, or are music. Upload photos and videos." };
    base = addClips(base, placeable.map((asset) => clipForAsset(asset!)));
  }

  const options: CreatedOption[] = [];
  let refusal: { status: number; message: string; upgrade?: boolean } | null = null;
  for (const angle of CREATE_ANGLES.slice(0, count)) {
    const title = titleFor(idea, angle);
    // Each option has its own clip ids, so its edits never collide with another option's.
    const timeline: Timeline = { ...base, clips: base.clips.map((clip) => ({ ...clip, id: randomUUID() })) };
    const reel = await prisma.reel.create({ data: { workspaceId: user.workspaceId, title, timeline: parseTimeline(timeline) }, select: { id: true, revision: true } });
    const brief = createBrief({ idea, angle, captions: input.captions, reelId: reel.id, title, revision: reel.revision, uploads: base.clips.length, voice });
    const started = await startNote({ user, reelId: reel.id, note: idea, origin: input.origin, requestId: randomUUID(), create: { brief } });
    if (!started.ok) {
      // An option that cannot run is not left behind as an empty reel.
      await prisma.reel.deleteMany({ where: { id: reel.id, workspaceId: user.workspaceId } });
      refusal = { status: started.status, message: started.message, upgrade: started.upgrade };
      break;
    }
    options.push({ reelId: reel.id, title, angle: angle.label, noteId: started.noteId });
  }
  if (options.length === 0) return { ok: false, ...(refusal ?? { status: 500, message: "Nothing could be started." }) };
  const skipped = count - options.length;
  return { ok: true, options, skipped, ...(skipped && refusal ? { message: refusal.message } : {}) };
}
