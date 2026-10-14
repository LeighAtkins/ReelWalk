import { autopilotRequest, autopilotStyle, finishAutopilot, ruleCutWithPick, usableCut, type InstagramAudioTrack, type ListingInfo, type Timeline } from "@reelwalk/core";
import { askForChange, context } from "@/lib/ai-edit";
import { isAiAvailable, isFakeAi } from "@/lib/openai";
import { labelRooms } from "@/lib/room-labels";

/**
 * "Make it for me" (ADR 0021): the studio's picked shots, a style and any
 * facts in; a finished reel out. The model cuts it when it can; anything it
 * leaves out is filled in, and when it cannot (no model, allowance spent, an
 * answer that is not a usable reel) the reel is cut by rule instead, so a
 * first-time studio always ends with music, text and a render. Nothing is
 * saved here: the editor applies the result and starts the export.
 */
export type AutopilotResult = { ok: true; timeline: Timeline; note: string; byModel: boolean; instagramPick?: InstagramAudioTrack } | { ok: false; message: string };

/**
 * The first cut, at once (ADR 0024): the rule cut with an Instagram sound,
 * from the rooms already named while the shots uploaded. No model call, so
 * it comes back in a second or two; the model's cut follows as a polish.
 */
export async function quickDraft(input: {
  user: { id: string; workspaceId: string };
  timeline: Timeline;
  styleId: string;
  info: ListingInfo;
}): Promise<AutopilotResult> {
  if (input.timeline.clips.length === 0) return { ok: false, message: "Pick some photos or videos first." };
  const style = autopilotStyle(input.styleId);
  const { assets, songs } = await context(input.user.workspaceId, input.timeline);
  const { timeline, instagramPick } = ruleCutWithPick(input.timeline, { assets, songs, info: input.info, style, newId: () => crypto.randomUUID() });
  return { ok: true, timeline, note: "Here is a first cut. ReelWalk is polishing it.", byModel: false, instagramPick };
}

export async function makeItForMe(input: {
  user: { id: string; workspaceId: string };
  reel: { id: string; title: string };
  timeline: Timeline;
  styleId: string;
  info: ListingInfo;
}): Promise<AutopilotResult> {
  if (input.timeline.clips.length === 0) return { ok: false, message: "Pick some photos or videos first." };
  const style = autopilotStyle(input.styleId);
  // Name the shots' rooms by looking at them first, so even a cut by rule can order the walk and label rooms.
  const named = isFakeAi() ? {} : await labelRooms(input.user.workspaceId, [...new Set(input.timeline.clips.filter((clip) => !clip.room).map((clip) => clip.assetId))]);
  if (Object.keys(named).length > 0) {
    input = { ...input, timeline: { ...input.timeline, clips: input.timeline.clips.map((clip) => (clip.room || !named[clip.assetId] ? clip : { ...clip, room: named[clip.assetId] })) } };
  }
  const { assets, songs } = await context(input.user.workspaceId, input.timeline);
  const local = { assets, songs, info: input.info, style, newId: () => crypto.randomUUID() };

  if (isAiAvailable()) {
    const asked = await askForChange({ user: input.user, reel: input.reel, timeline: input.timeline, request: autopilotRequest(style.id, input.info), maxLength: 2000 });
    if (asked.ok && asked.applied.length > 0 && usableCut(asked.timeline)) {
      const { timeline, added, instagramPick } = finishAutopilot(asked.timeline, { ...local, instagramPick: asked.instagramPick });
      return { ok: true, timeline, note: added.length ? `${asked.note} Added: ${added.join(", ")}.` : asked.note, byModel: true, instagramPick };
    }
    if (!asked.ok) console.warn("autopilot: model not used:", asked.message);
    else console.warn("autopilot: model's cut not usable, cutting by rule", asked.applied.length, asked.questions);
  }
  const { timeline, instagramPick } = ruleCutWithPick(input.timeline, local);
  return { ok: true, timeline, note: "Your reel is cut to the beat with music, a title and your details.", byModel: false, instagramPick };
}
