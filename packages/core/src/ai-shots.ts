import { z } from "zod";
import { addClips, clipDurationMs, clipSchema, clipStartsMs, type Clip, type Timeline } from "./timeline";

export const AI_SHOT_MODES = ["custom", "continue", "bridge", "burst", "gimbal", "drone"] as const;
export type AiShotMode = typeof AI_SHOT_MODES[number];
export const AI_SHOT_LABELS: Record<AiShotMode, string> = {
  custom: "Custom shot", continue: "Continue this shot", bridge: "Connect two shots",
  burst: "Transition burst", gimbal: "Photo to gimbal move", drone: "Photo to drone reveal",
};
const frame = z.object({
  assetId: z.string().min(1).max(64), atMs: z.number().int().min(0).max(86_400_000).default(0),
});
export const aiShotSchema = z.object({
  mode: z.enum(AI_SHOT_MODES), first: frame.optional(), last: frame.optional(),
  // Snapshots prevent inserting against a boundary the user has since changed.
  anchor: clipSchema.optional(), next: clipSchema.optional(),
  draftReelId: z.string().min(1).max(64).optional(),
}).superRefine((shot, ctx) => {
  if (shot.mode !== "custom" && !shot.first) ctx.addIssue({ code: "custom", message: "Choose a source image or video." });
  if ((shot.mode === "bridge" || shot.mode === "burst") && !shot.last) ctx.addIssue({ code: "custom", message: "Choose an ending frame." });
  if (shot.last && !shot.first) ctx.addIssue({ code: "custom", message: "An ending frame needs a starting frame." });
  if ((shot.mode === "bridge" || shot.mode === "burst") && Boolean(shot.anchor) !== Boolean(shot.next)) {
    ctx.addIssue({ code: "custom", message: "Choose both adjacent reel clips, or use library references without timeline placement." });
  }
  if (shot.anchor && shot.first && JSON.stringify(aiBoundary(shot.anchor, true)) !== JSON.stringify(shot.first)) {
    ctx.addIssue({ code: "custom", message: "The source clip no longer matches its starting frame." });
  }
  if (shot.next && shot.last && JSON.stringify(aiBoundary(shot.next, false)) !== JSON.stringify(shot.last)) {
    ctx.addIssue({ code: "custom", message: "The next clip no longer matches its ending frame." });
  }
  if (["gimbal", "drone"].includes(shot.mode) && shot.anchor && clipDurationMs(shot.anchor) > 32000) {
    ctx.addIssue({ code: "custom", message: "Trim this still to 32 seconds or less before animating it." });
  }
});
export type AiShot = z.infer<typeof aiShotSchema>;

export function aiShotPrompt(mode: AiShotMode, direction: string): string {
  const moves: Record<AiShotMode, string> = {
    custom: "", continue: "Continue the camera movement naturally from the supplied first frame.",
    bridge: "Create one continuous camera move from the supplied first frame to the supplied last frame. Settle exactly into the ending composition.",
    burst: "Create an energetic camera transition between the supplied first and last frames, using a quick whip through motion blur in the middle. Start and end sharp.",
    gimbal: "Animate the supplied property photo as a slow stabilized gimbal push with subtle parallax. Keep the camera close to its original viewpoint.",
    drone: "Animate the supplied exterior photo as a gentle drone rise and pullback, revealing only the immediate surroundings. Do not invent distant landmarks or extra buildings.",
  };
  return [moves[mode], "Preserve the property's architecture, room layout, openings, furniture, materials and lighting. No text, logos or unrequested people. Photorealistic property footage.", direction].filter(Boolean).join(" ");
}

/** Use the last displayed source frame, not the end of the untrimmed file. */
export function aiBoundary(clip: Clip, end: boolean) {
  return { assetId: clip.assetId, atMs: clip.kind === "IMAGE" ? 0 : end
    ? Math.max(clip.sourceStartMs, Math.round(clip.sourceEndMs - clip.speed * 1000 / 30)) : clip.sourceStartMs };
}

export function aiShotFromClips(mode: AiShotMode, anchor: Clip, next?: Clip): AiShot {
  return { mode, first: aiBoundary(anchor, true), anchor,
    ...((mode === "bridge" || mode === "burst") && next ? { last: aiBoundary(next, false), next } : {}) };
}

/** Full bridge is accelerated, never truncated: dropping its end loses the match. */
export function insertAiShot(timeline: Timeline, generated: Clip, shot: AiShot): Timeline {
  if (timeline.clips.some(c => c.id === generated.id)) return timeline;
  const index = shot.anchor ? timeline.clips.findIndex(c => c.id === shot.anchor!.id) : -1;
  const same = (a: Clip | undefined, b: Clip) => a && JSON.stringify(clipSchema.parse(a)) === JSON.stringify(clipSchema.parse(b));
  if (shot.anchor && (index < 0 || !same(timeline.clips[index], shot.anchor))) return timeline;
  if (shot.next && !same(timeline.clips[index + 1], shot.next)) return timeline;
  const bridge = shot.mode === "bridge" || shot.mode === "burst";
  const replace = (shot.mode === "gimbal" || shot.mode === "drone") && shot.anchor?.kind === "IMAGE";
  const duration = replace ? clipDurationMs(shot.anchor!) : shot.mode === "burst" ? 2000 : shot.mode === "custom" ? 8000 : 4000;
  if (replace && duration > 32000) return timeline;
  const clip: Clip = { ...generated, volume: 0, sourceStartMs: 0, sourceEndMs: 8000,
    speed: Math.max(0.25, Math.min(4, 8000 / duration)), transitionIn: replace ? shot.anchor!.transitionIn : "cut",
    filter: shot.anchor?.filter ?? "none", zoom: replace ? 1 : shot.anchor?.zoom ?? 1 };
  if (replace) {
    // Keep the clip ID for cover/text anchors and preserve the still's duration.
    const replacement = { ...clip, id: shot.anchor!.id, room: shot.anchor!.room, spot: shot.anchor!.spot,
      sourceEndMs: Math.min(8000, Math.round(duration * clip.speed)) };
    return { ...timeline, clips: timeline.clips.map((c, i) => i === index ? replacement : c) };
  }
  const insertionIndex = index < 0 ? timeline.clips.length : index + 1;
  const atMs = clipStartsMs(timeline)[insertionIndex] ?? timeline.clips.reduce((sum, c) => sum + clipDurationMs(c), 0);
  const addedMs = clipDurationMs(clip);
  const inserted = addClips(timeline, [clip], insertionIndex);
  if (bridge && inserted.clips[insertionIndex + 1]) inserted.clips[insertionIndex + 1] = { ...inserted.clips[insertionIndex + 1], transitionIn: "cut" };
  return { ...inserted, texts: timeline.texts.map(t => ({ ...t,
    startMs: t.startMs >= atMs ? t.startMs + addedMs : t.startMs,
    endMs: t.endMs > atMs ? t.endMs + addedMs : t.endMs,
  })) };
}
