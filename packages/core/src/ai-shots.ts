import { z } from "zod";
import { addClips, clipDurationMs, clipSchema, clipStartsMs, type Clip, type Filter, type Timeline } from "./timeline";
import { luxuryFinish } from "./cinematic";

export const AI_SHOT_MODES = ["custom", "continue", "bridge", "burst", "gimbal", "drone", "orbit", "fly-through", "day-night", "construction"] as const;
export type AiShotMode = typeof AI_SHOT_MODES[number];
export const AI_SHOT_LABELS: Record<AiShotMode, string> = {
  custom: "Custom shot", continue: "Continue this shot", bridge: "Connect two shots",
  burst: "Transition burst", gimbal: "Photo to gimbal move", drone: "Photo to drone reveal",
  orbit: "Drone orbit around building", "fly-through": "Sweeping FPV fly-through",
  "day-night": "Day-to-night timelapse", construction: "Construction timelapse · before + after",
};
export const AI_SHOT_STYLES = ["auto", "source", "neon", "refined", "modern"] as const;
export type AiShotStyle = typeof AI_SHOT_STYLES[number];
export const AI_SHOT_STYLE_LABELS: Record<AiShotStyle, string> = {
  auto: "Art-direct it for me", source: "Match the original", neon: "Futuristic neon", refined: "Classical refined", modern: "Sleek modern",
};
export const AI_SHOT_ATMOSPHERES = ["auto", "source", "golden-hour", "blue-hour", "sunny", "mist", "rain"] as const;
export type AiShotAtmosphere = typeof AI_SHOT_ATMOSPHERES[number];
export const AI_SHOT_ATMOSPHERE_LABELS: Record<AiShotAtmosphere, string> = {
  auto: "Choose flattering light", source: "Keep original light and weather", "golden-hour": "Golden-hour warmth",
  "blue-hour": "Blue hour + glowing windows", sunny: "Clear sky + soft sunshine", mist: "Soft cinematic mist", rain: "Rain + reflective surfaces",
};
export const aiConnectsClips = (mode: AiShotMode) => ["bridge", "burst", "construction"].includes(mode);
/** Timelapses need the full 8 seconds to progress; every other move fits a 4-second clip. */
export const aiDefaultClipSeconds = (mode?: AiShotMode): 4 | 8 => mode === "day-night" || mode === "construction" ? 8 : 4;
export const aiReplacesStill = (mode: AiShotMode) => ["gimbal", "drone", "orbit", "fly-through", "day-night"].includes(mode);
const frame = z.object({
  assetId: z.string().min(1).max(64), atMs: z.number().int().min(0).max(86_400_000).default(0),
});
/** Compose the start/end stills with the presenter before Veo sees them (ADR 0036): where she is in a supplied frame, and what each composed frame shows. */
export const aiComposeSchema = z.object({
  presenter: frame,
  first: z.string().trim().min(10).max(600).optional(),
  last: z.string().trim().min(10).max(600).optional(),
}).refine(c => c.first || c.last, "Describe at least one composed frame.");
export const aiShotSchema = z.object({
  mode: z.enum(AI_SHOT_MODES), first: frame.optional(), last: frame.optional(),
  style: z.enum(AI_SHOT_STYLES).optional(), atmosphere: z.enum(AI_SHOT_ATMOSPHERES).optional(),
  energy: z.enum(["subtle", "bold"]).optional(), harmonize: z.boolean().optional(),
  polish: z.boolean().optional(),
  compose: aiComposeSchema.optional(),
  // Snapshots prevent inserting against a boundary the user has since changed.
  anchor: clipSchema.optional(), next: clipSchema.optional(),
  draftReelId: z.string().min(1).max(64).optional(),
}).superRefine((shot, ctx) => {
  if (shot.mode !== "custom" && !shot.first) ctx.addIssue({ code: "custom", message: "Choose a source image or video." });
  if (aiConnectsClips(shot.mode) && !shot.last) ctx.addIssue({ code: "custom", message: "Choose an ending frame (the completed building for a construction timelapse)." });
  if (shot.last && !shot.first) ctx.addIssue({ code: "custom", message: "An ending frame needs a starting frame." });
  if (shot.compose?.first && !shot.first) ctx.addIssue({ code: "custom", message: "A composed starting frame needs a starting frame." });
  if (shot.compose?.last && !shot.last) ctx.addIssue({ code: "custom", message: "A composed ending frame needs an ending frame." });
  if (aiConnectsClips(shot.mode) && Boolean(shot.anchor) !== Boolean(shot.next)) {
    ctx.addIssue({ code: "custom", message: "Choose both adjacent reel clips, or use library references without timeline placement." });
  }
  if (shot.anchor && shot.first && JSON.stringify(aiBoundary(shot.anchor, true)) !== JSON.stringify(shot.first)) {
    ctx.addIssue({ code: "custom", message: "The source clip no longer matches its starting frame." });
  }
  if (shot.next && shot.last && JSON.stringify(aiBoundary(shot.next, false)) !== JSON.stringify(shot.last)) {
    ctx.addIssue({ code: "custom", message: "The next clip no longer matches its ending frame." });
  }
  if (aiReplacesStill(shot.mode) && shot.anchor?.kind === "IMAGE" && clipDurationMs(shot.anchor) > 32000) {
    ctx.addIssue({ code: "custom", message: "Trim this still to 32 seconds or less before animating it." });
  }
});
export type AiShot = z.infer<typeof aiShotSchema>;

export function aiShotStyle(shot: AiShot): Exclude<AiShotStyle, "auto"> {
  if (shot.style !== "auto") return shot.style ?? "source";
  return /bed|living|lounge|dining/i.test(shot.anchor?.room ?? "") || ["warm", "golden", "fade"].includes(shot.anchor?.filter ?? "") ? "refined" : "modern";
}

export function aiShotGrade(shot: AiShot): Filter | undefined {
  if (!shot.harmonize) return undefined;
  const filters: Record<Exclude<AiShotStyle, "auto">, Filter | undefined> = { source: undefined, neon: "cool", refined: "warm", modern: "crisp" };
  return filters[aiShotStyle(shot)];
}

export function aiShotPrompt(mode: AiShotMode, direction: string, recipe?: AiShot): string {
  const shot = recipe ?? { mode };
  const moves: Record<AiShotMode, string> = {
    custom: "", continue: "Continue the camera movement naturally from the supplied first frame.",
    bridge: "Create one continuous camera move from the supplied first frame to the supplied last frame. Settle exactly into the ending composition.",
    burst: "Create an energetic camera transition between the supplied first and last frames, using a quick whip through motion blur in the middle. Start and end sharp.",
    gimbal: "Animate the supplied property photo as a slow stabilized gimbal push with subtle parallax. Keep the camera close to its original viewpoint.",
    drone: "Animate the supplied exterior photo as a gentle drone rise and pullback, revealing only the immediate surroundings. Do not invent distant landmarks or extra buildings.",
    orbit: "Fly a smooth cinematic drone orbit around the referenced building, with foreground parallax and a readable facade. Keep the same roofline, footprint and surroundings; use an ending reference for the landing view when supplied.",
    "fly-through": "Create a sweeping FPV camera flight through the referenced property, with a dramatic approach, flowing doorway passes and a smooth deceleration. Maintain believable scale and continuous space; use visible openings rather than flying through solid walls.",
    "day-night": "Create a locked-composition day-to-night timelapse of the referenced property. Advance sunlight and moving shadows into sunset, then blue hour and night as interior lights come on. Keep architecture and camera position stable throughout.",
    construction: "Create a cinematic accelerated construction timelapse from the supplied BEFORE frame to the supplied completed-building AFTER frame. Show coherent foundations, structure, exterior and finishing stages in chronological order, ending exactly on the completed reference. This is a conceptual construction visualization, not documentary footage.",
  };
  const styles: Record<Exclude<AiShotStyle, "auto">, string> = {
    source: "Match the reference's original colour palette and material appearance.",
    neon: "Use a futuristic neon cinematic treatment: cyan and magenta practical light, luminous edge accents, rich dark tones and restrained bloom. Keep the existing building design; change light and colour rather than adding sci-fi architecture.",
    refined: "Use a classical refined cinematic treatment: warm ivory highlights, deep soft shadows, restrained saturation, elegant natural materials and graceful pacing. Keep the existing architecture rather than adding classical columns or ornament.",
    modern: "Use a sleek modern cinematic treatment: clean whites, cool neutral shadows, controlled contrast, crisp lines, polished reflections and precise camera movement. Keep the existing materials and building design.",
  };
  const atmospheres: Record<AiShotAtmosphere, string> = {
    source: "Preserve the original lighting and weather.",
    auto: "Art-direct flattering light for this property: readable details, soft directional illumination and a cohesive sky. For interiors, keep light motivated by the existing windows and fixtures.",
    "golden-hour": "Relight at golden hour with warm low sun, long soft shadows and a flattering sky.",
    "blue-hour": "Relight at blue hour with a deep blue sky and warm glowing existing windows.",
    sunny: "Use clear pleasant weather, soft sunshine, clean air and a flattering blue sky without harsh clipped highlights.",
    mist: "Use delicate atmospheric mist and soft diffused light, keeping the property clearly visible.",
    rain: "Use cinematic light rain, wet exterior surfaces and believable reflections, keeping interior spaces dry.",
  };
  const preserveLight = (shot.atmosphere ?? "source") === "source" && aiShotStyle(shot) === "source" && !["day-night", "construction"].includes(mode);
  return [moves[mode],
    mode === "construction" ? "Preserve the completed building's design and site boundaries from the ending reference." : "Preserve the property's architecture, room layout, openings, furniture and materials.",
    preserveLight ? "Keep reference lighting unchanged." : "Lighting, weather and colour may evolve according to the chosen treatment; keep geometry and materials consistent.",
    styles[aiShotStyle(shot)],
    mode === "day-night" ? "The day-to-night lighting progression takes priority over any fixed weather or time-of-day choice." : shot.atmosphere === "source" && aiShotStyle(shot) !== "source" ? "Keep original weather; lighting may follow the selected cinematic style." : atmospheres[shot.atmosphere ?? "source"],
    shot.energy === "bold" ? ["day-night", "construction"].includes(mode) ? "Make the timelapse progression dramatic and high-impact while keeping the camera locked." : "Lean into a bold high-impact promo: strong depth, expressive motion and dramatic light, while keeping the subject readable." : "Keep motion controlled and elegant.",
    shot.last ? "Match the supplied ending frame's composition, geometry and lighting at the finish; place creative lighting changes in the middle of the move." : "",
    "No text, logos or unrequested people. Photorealistic cinematic property footage.", direction].filter(Boolean).join(" ");
}

/** Use the last displayed source frame, not the end of the untrimmed file. */
export function aiBoundary(clip: Clip, end: boolean) {
  return { assetId: clip.assetId, atMs: clip.kind === "IMAGE" ? 0 : end
    ? Math.max(clip.sourceStartMs, Math.round(clip.sourceEndMs - clip.speed * 1000 / 30)) : clip.sourceStartMs };
}

export function aiShotFromClips(mode: AiShotMode, anchor: Clip, next?: Clip): AiShot {
  return { mode, first: aiBoundary(anchor, true), anchor,
    ...(aiConnectsClips(mode) && next ? { last: aiBoundary(next, false), next } : {}) };
}

/** Full bridge is accelerated, never truncated: dropping its end loses the match. */
export function insertAiShot(timeline: Timeline, generated: Clip, shot: AiShot): Timeline {
  if (timeline.clips.some(c => c.id === generated.id)) return timeline;
  const index = shot.anchor ? timeline.clips.findIndex(c => c.id === shot.anchor!.id) : -1;
  const same = (a: Clip | undefined, b: Clip) => a && JSON.stringify(clipSchema.parse(a)) === JSON.stringify(clipSchema.parse(b));
  if (shot.anchor && (index < 0 || !same(timeline.clips[index], shot.anchor))) return timeline;
  if (shot.next && !same(timeline.clips[index + 1], shot.next)) return timeline;
  const bridge = aiConnectsClips(shot.mode);
  const replace = aiReplacesStill(shot.mode) && shot.anchor?.kind === "IMAGE";
  // Generated clips are 4 or 8 seconds; full-length modes play at 1x, moves fit 4 s, bursts 2 s.
  const sourceMs = generated.sourceEndMs - generated.sourceStartMs;
  const duration = replace ? clipDurationMs(shot.anchor!) : shot.mode === "burst" ? Math.min(2000, sourceMs)
    : ["custom", "day-night", "construction"].includes(shot.mode) ? sourceMs : Math.min(4000, sourceMs);
  if (replace && duration > 32000) return timeline;
  const clip: Clip = { ...generated, volume: 0, sourceStartMs: 0, sourceEndMs: sourceMs,
    speed: Math.max(0.25, Math.min(4, sourceMs / duration)), transitionIn: replace ? shot.anchor!.transitionIn : "cut",
    filter: shot.anchor?.filter ?? "none", zoom: replace ? 1 : shot.anchor?.zoom ?? 1 };
  const grade = aiShotGrade(shot);
  const finish = (edit: Timeline): Timeline => {
    const polished = shot.polish ? luxuryFinish(edit, aiShotStyle(shot) === "refined" ? "refined" : "modern", false) : edit;
    return grade ? { ...polished, clips: polished.clips.map(c => ({ ...c, filter: grade })) } : polished;
  };
  if (replace) {
    // Keep the clip ID for cover/text anchors and preserve the still's duration.
    const replacement = { ...clip, id: shot.anchor!.id, room: shot.anchor!.room, spot: shot.anchor!.spot,
      sourceEndMs: Math.min(sourceMs, Math.round(duration * clip.speed)) };
    return finish({ ...timeline, clips: timeline.clips.map((c, i) => i === index ? replacement : c) });
  }
  const insertionIndex = index < 0 ? timeline.clips.length : index + 1;
  const atMs = clipStartsMs(timeline)[insertionIndex] ?? timeline.clips.reduce((sum, c) => sum + clipDurationMs(c), 0);
  const addedMs = clipDurationMs(clip);
  const inserted = addClips(timeline, [clip], insertionIndex);
  if (bridge && inserted.clips[insertionIndex + 1]) inserted.clips[insertionIndex + 1] = { ...inserted.clips[insertionIndex + 1], transitionIn: "cut" };
  return finish({ ...inserted, texts: timeline.texts.map(t => ({ ...t,
    startMs: t.startMs >= atMs ? t.startMs + addedMs : t.startMs,
    endMs: t.endMs > atMs ? t.endMs + addedMs : t.endMs,
  })) });
}
