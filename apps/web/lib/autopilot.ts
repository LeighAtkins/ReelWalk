import { autopilotRequest, autopilotStyle, finishAutopilot, ruleCutWithPick, usableCut, type InstagramAudioTrack, type ListingInfo, type Timeline } from "@reelwalk/core";
import { askForChange, context } from "@/lib/ai-edit";
import { isAiAvailable } from "@/lib/openai";

/**
 * "Make it for me" (ADR 0021): the studio's picked shots, a style and any
 * facts in; a finished reel out. The model cuts it when it can; anything it
 * leaves out is filled in, and when it cannot (no model, allowance spent, an
 * answer that is not a usable reel) the reel is cut by rule instead, so a
 * first-time studio always ends with music, text and a render. Nothing is
 * saved here: the editor applies the result and starts the export.
 */
export type AutopilotResult = { ok: true; timeline: Timeline; note: string; byModel: boolean; instagramPick?: InstagramAudioTrack } | { ok: false; message: string };

export async function makeItForMe(input: {
  user: { id: string; workspaceId: string };
  reel: { id: string; title: string };
  timeline: Timeline;
  styleId: string;
  info: ListingInfo;
}): Promise<AutopilotResult> {
  if (input.timeline.clips.length === 0) return { ok: false, message: "Pick some photos or videos first." };
  const style = autopilotStyle(input.styleId);
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
