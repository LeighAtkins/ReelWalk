/**
 * Script mode (ADR 0060): a presenter across the whole reel. The studio types
 * two to four lines (or asks for them); each becomes a voiced presenter take
 * composed into the reel's own footage at a sensible point (open, middle,
 * close), from the workspace's presenter kit (ADR 0056), in one outfit, lit
 * like the room she stands in, and walking in from where the last take left
 * when two are back to back. Everything here is pure: the editor plans and
 * previews with it, the server rebuilds the prompts and the quote with it, and
 * the command layer places the finished takes with it.
 */
import { z } from "zod";
import { aiClipCredits, type AiClipSeconds } from "./ai";
import { aiBoundary, aiShotSchema, type AiScriptMeta, type AiShot } from "./ai-shots";
import { isGeneratedAssetId, type PresenterFraming } from "./presenter";
import { aiDirectionSchema, directionPrompt, directionStill, hasDirection, type AiDirection } from "./direction";
import { clipStartsMs, timelineDurationMs, type Clip, type Filter, type Timeline } from "./timeline";

export const SCRIPT_MAX_LINES = 4;
export const SCRIPT_LINE_MIN = 3;
export const SCRIPT_LINE_MAX = 200;
export const SCRIPT_OUTFIT_MAX = 120;
/** Without a description, the kit's full-length photo is the outfit. */
export const DEFAULT_OUTFIT = "the same clothes as in her full-length photo";
/** A line of up to this many words fits a 4-second take; longer lines get 8 seconds. */
export const SHORT_LINE_WORDS = 7;
/** About as much as she can say in an 8-second take. */
export const SCRIPT_LINE_MAX_WORDS = 20;

/**
 * A line as it is spoken: no quotation marks or line breaks (the worker puts the
 * line inside quotes in Veo's prompt), single spaces.
 */
export const cleanLine = (line: string) => line.replace(/["“”\r\n]+/g, " ").replace(/\s+/g, " ").trim();
export const lineWords = (line: string) => cleanLine(line).split(" ").filter(Boolean).length;

export const SCRIPT_VOICES = ["veo", "lipsync"] as const;
export type ScriptVoice = typeof SCRIPT_VOICES[number];

/** Which side of the frame the room's key light comes from, measured on the plate in the browser. */
export const LIGHT_SIDES = ["left", "right", "behind", "even"] as const;
export type LightSide = typeof LIGHT_SIDES[number];

/** One place a take can go: before the first clip (boundary 0) or after clip `boundary - 1`. */
export type ScriptSlot = {
  boundary: number;
  /** The clip the take goes after; null for the opening. */
  afterClipId: string | null;
  /** Reel time of the boundary, and as a fraction of the reel. */
  atMs: number;
  fraction: number;
  /** The frame she is composed into: the picture on screen at that point. */
  plate: { assetId: string; atMs: number };
  plateClipId: string;
  room: string | null;
  filter: Filter;
  /** The rooms either side differ: a natural place for her to speak. */
  roomChange: boolean;
};

/**
 * Every place a take can go, with its plate. The plate is the end of the clip
 * before the boundary (so the cut into her take matches), else the start of the
 * clip after it. 360 photos and generated takes are never plates: a 360 photo
 * is not a flat picture, and a generated take may already show her.
 */
export function scriptSlots(timeline: Timeline): ScriptSlot[] {
  const clips = timeline.clips;
  const starts = clipStartsMs(timeline);
  const total = timelineDurationMs(timeline);
  const usable = (clip: Clip | undefined): clip is Clip => Boolean(clip && !clip.pano && !isGeneratedAssetId(clip.assetId));
  const slots: ScriptSlot[] = [];
  for (let boundary = 0; boundary <= clips.length; boundary++) {
    const before = clips[boundary - 1], after = clips[boundary];
    const source = usable(before) ? { clip: before, end: true } : usable(after) ? { clip: after, end: false } : null;
    if (!source) continue;
    const atMs = boundary < clips.length ? starts[boundary] : total;
    slots.push({
      boundary, afterClipId: before?.id ?? null, atMs, fraction: total > 0 ? Math.min(1, atMs / total) : 0,
      plate: aiBoundary(source.clip, source.end), plateClipId: source.clip.id,
      room: source.clip.room ?? null, filter: source.clip.filter,
      roomChange: Boolean(before && after && before.room && after.room && before.room !== after.room),
    });
  }
  return slots;
}

/**
 * Where each line goes: the first line opens the reel, the last closes it, and
 * the ones between go to the boundary nearest their even share of the reel,
 * preferring a change of room. Lines stay in order. When the reel has too few
 * places, a line shares the previous line's place: the two takes are back to
 * back, and she walks from one into the next.
 */
export function planScript(slots: ScriptSlot[], count: number): ScriptSlot[] {
  if (slots.length === 0 || count <= 0) return [];
  const first = slots[0], last = slots[slots.length - 1];
  if (count === 1) return [first];
  const plan: ScriptSlot[] = [first];
  for (let i = 1; i < count - 1; i++) {
    const target = i / (count - 1);
    const previous = plan[i - 1];
    const candidates = slots.filter(slot => slot.boundary > previous.boundary && slot.boundary < last.boundary);
    // Leave a place for each middle line still to come, so they do not all bunch at the end.
    const later = count - 2 - i;
    const roomy = candidates.length > later ? candidates.slice(0, candidates.length - later) : candidates;
    const score = (slot: ScriptSlot) => Math.abs(slot.fraction - target) + (slot.roomChange ? 0 : 0.08);
    plan.push(roomy.length ? roomy.reduce((best, slot) => score(slot) < score(best) ? slot : best) : previous);
  }
  plan.push(last);
  return plan;
}

/** A short line fits four seconds; anything longer gets eight, so she is not rushed. */
export function lineSeconds(line: string): AiClipSeconds {
  return lineWords(line) <= SHORT_LINE_WORDS ? 4 : 8;
}

/** What the script costs before anything is made: every take is voiced (ADR 0038 adds a credit per spoken take). */
export function scriptQuote(lines: string[]): { seconds: AiClipSeconds[]; credits: number[]; total: number } {
  const seconds = lines.map(lineSeconds);
  const credits = seconds.map(s => aiClipCredits(s, true));
  return { seconds, credits, total: credits.reduce((sum, c) => sum + c, 0) };
}

const frame = z.object({ assetId: z.string().min(1).max(64), atMs: z.number().int().min(0).max(86_400_000) });
export const scriptTakeSchema = z.object({
  line: z.preprocess(v => typeof v === "string" ? cleanLine(v) : v, z.string().min(SCRIPT_LINE_MIN).max(SCRIPT_LINE_MAX)
    .refine(line => lineWords(line) <= SCRIPT_LINE_MAX_WORDS, `Keep each line to ${SCRIPT_LINE_MAX_WORDS} words or fewer.`)),
  boundary: z.number().int().min(0).max(100),
  afterClipId: z.string().min(1).max(200).nullable(),
  fraction: z.number().min(0).max(1),
  // Her own footage only: a generated take may already show her, and chaining takes is how faces drifted (ADR 0056).
  plate: frame.refine(plate => !isGeneratedAssetId(plate.assetId), "Film her into your own footage, not a generated take."),
  room: z.string().trim().max(40).nullable().optional(),
  light: z.enum(LIGHT_SIDES).nullable().optional(),
});
export type ScriptTake = z.infer<typeof scriptTakeSchema>;

/** What the editor sends to make a script: the server rebuilds every prompt and the quote from it. */
export const scriptRequestSchema = z.object({
  scriptId: z.string().uuid(),
  presenterId: z.string().min(1).max(64),
  /** One voice for every take: Veo's own audio by default, the workspace's lip-synced voice when it is set up. */
  voice: z.enum(SCRIPT_VOICES).default("veo"),
  outfit: z.string().trim().max(SCRIPT_OUTFIT_MAX).optional(),
  /** How close every take is composed (ADR 0069): close by default for a spoken line. */
  framing: z.enum(["tight", "close", "medium"]).default("close"),
  /** How she plays every line (ADR 0069): tone, energy, eye line, blocking. Per script, like the outfit. */
  direction: aiDirectionSchema.optional(),
  takes: z.array(scriptTakeSchema).min(1).max(SCRIPT_MAX_LINES),
}).superRefine((script, ctx) => {
  script.takes.forEach((take, i) => {
    if (i > 0 && take.boundary < script.takes[i - 1].boundary) ctx.addIssue({ code: "custom", path: ["takes", i, "boundary"], message: "Lines must stay in the order they play." });
  });
});
export type ScriptRequest = z.infer<typeof scriptRequestSchema>;

/** How she is lit, matched to the plate's key light. */
export function lightInstruction(light: LightSide | null | undefined): string {
  switch (light) {
    case "left": return "The key light comes from the left of the frame, as in the room: her face brighter on that side, her shadow falling right like the furniture's.";
    case "right": return "The key light comes from the right of the frame, as in the room: her face brighter on that side, her shadow falling left like the furniture's.";
    case "behind": return "The room's light is behind her (a bright window): a soft rim on her hair, her face lifted by soft fill from the camera side, never a silhouette.";
    default: return "Light her like the room: the same direction, softness and colour temperature, her shadows falling the way the furniture's do.";
  }
}

/** The outfit sentence every take repeats word for word. */
export function outfitSentence(outfit: string | null | undefined): string {
  const worn = outfit?.trim() || DEFAULT_OUTFIT;
  return `She wears ${worn}: the same clothes, hair and accessories in every shot.`;
}

type Continuity = { walksIn: boolean; walksOut: boolean };

/** Back-to-back takes (the same place in the reel): she leaves the first to the right and walks into the next from the left. */
export function scriptContinuity(takes: Pick<ScriptTake, "boundary">[]): Continuity[] {
  return takes.map((take, i) => ({
    walksIn: i > 0 && takes[i - 1].boundary === take.boundary,
    walksOut: i < takes.length - 1 && takes[i + 1].boundary === take.boundary,
  }));
}

/** The shot size the still and the prompt name, by framing (the worker's framing instruction gives the numbers). */
const SHOT_SIZE: Record<PresenterFraming, string> = { tight: "Tight shot, chest-up, near the camera", close: "Close shot, waist-up, near the camera", medium: "Medium shot, knees at the bottom edge, true scale", wide: "Wide shot" };

/**
 * The composed still's description (ADR 0036): where she is, what she wears, how she is lit, and (ADR 0069) how she
 * holds her face and where she stands for the direction. Under 600 characters.
 */
export function composeInstruction(take: Pick<ScriptTake, "room" | "light">, outfit: string | null | undefined, continuity: Continuity, framing: PresenterFraming = "close", direction?: AiDirection | null): string {
  const where = take.room ? `in the ${take.room}` : "in this room";
  const blocked = hasDirection(direction) && direction.blocking && direction.blocking !== "stand";
  const position = continuity.walksIn
    ? `She steps in from the left edge of the frame ${where}, mid-stride, turning toward camera.`
    : blocked ? `She is ${where}.` : `She stands ${where} in the middle third of the frame, facing camera, about to speak.`;
  // Every part is bounded (room 40, outfit 120, direction under 200 characters), so the whole stays under the 600 the schema allows without cutting a sentence.
  const acting = hasDirection(direction) ? directionStill(direction, "first") : "";
  return [position, `${SHOT_SIZE[framing]}. Speaking: her face large, sharp and front-lit, both eyes and her mouth clearly visible.`, acting, outfitSentence(outfit), lightInstruction(take.light)].filter(Boolean).join(" ");
}

/** What Veo is asked for. The worker adds the spoken line (and, for Veo's audio, the accent) as for any voiced take. */
export function presenterPrompt(take: Pick<ScriptTake, "room" | "light">, outfit: string | null | undefined, voice: ScriptVoice, continuity: Continuity, framing: PresenterFraming = "close", direction?: AiDirection | null): string {
  const directed = hasDirection(direction);
  return [
    `Start exactly from the supplied first frame. ${SHOT_SIZE[framing]}: the camera holds still, at most a slow gentle push in.`,
    continuity.walksIn
      ? "She walks in from the left edge of the frame, continuing from the previous shot where she walked out to the right, stops in the middle third and turns to camera."
      : directed && direction.blocking && direction.blocking !== "stand" ? "" : "She is already in place.",
    directed && direction.eyeLine && direction.eyeLine !== "lens" ? "She speaks to camera." : "She looks into the lens and speaks to camera" + (directed && direction.energy ? "." : " with small, natural gestures."),
    directed ? directionPrompt(direction) : "",
    continuity.walksOut ? "As she finishes speaking she turns and walks out of the frame to the right." : "",
    outfitSentence(outfit), lightInstruction(take.light),
    voice === "veo" ? "One presenter and one voice across the reel: her same warm Australian voice in every take." : "One presenter across the reel.",
    `Keep the ${take.room ?? "room"}'s architecture, furniture, materials and light unchanged. No text, captions, logos or other people. Photorealistic, natural skin and hands.`,
  ].filter(Boolean).join(" ");
}

/** Stable identity for each take of a script, so a retried Generate never charges twice (the request-id path of ADR 0034). */
export const scriptRequestKey = (scriptId: string, index: number) => `script:${scriptId}:${index}`;

export type ScriptShot = { prompt: string; durationSeconds: AiClipSeconds; credits: number; shot: AiShot & { compose: NonNullable<AiShot["compose"]> } };

/**
 * Every take of a script as the generation path takes it: exact prompt, duration, credit quote, and the shot with its
 * composed still. Each shot is checked against `aiShotSchema` here, the schema the worker reads it back with: a shot it
 * could not read would lose its voice and be made silent although charged as voiced. Throws `ScriptShotError` instead.
 */
export class ScriptShotError extends Error {}
export function buildScriptShots(script: ScriptRequest, reelId: string): ScriptShot[] {
  const continuity = scriptContinuity(script.takes);
  const quote = scriptQuote(script.takes.map(take => take.line));
  return script.takes.map((take, index) => {
    const meta: AiScriptMeta = {
      id: script.scriptId, reelId, index, count: script.takes.length, afterClipId: take.afterClipId, fraction: take.fraction,
      ...(script.outfit?.trim() ? { outfit: script.outfit.trim() } : {}),
    };
    const direction = hasDirection(script.direction) ? script.direction : undefined;
    const shot: ScriptShot["shot"] = {
      mode: "custom", first: take.plate, line: cleanLine(take.line), voice: script.voice, script: meta,
      ...(direction ? { direction } : {}),
      compose: { presenterId: script.presenterId, framing: script.framing, first: composeInstruction(take, script.outfit, continuity[index], script.framing, direction) },
    };
    const checked = aiShotSchema.safeParse(shot);
    if (!checked.success || !checked.data.voice || !checked.data.line || !checked.data.compose) {
      throw new ScriptShotError(`Line ${index + 1} could not be made into a take${checked.success ? "" : `: ${checked.error.issues[0]?.message ?? "invalid"}`}.`);
    }
    return { prompt: presenterPrompt(take, script.outfit, script.voice, continuity[index], script.framing, direction), durationSeconds: quote.seconds[index], credits: quote.credits[index], shot };
  });
}

/**
 * Which side the key light comes from, from a small luminance picture of the
 * plate (row-major, any size). A side clearly brighter than the other is the
 * key; a bright middle with darker sides is a window behind her; otherwise
 * the light is even.
 */
export function lightFromLuma(gray: { data: ArrayLike<number>; width: number; height: number }): LightSide {
  const { data, width, height } = gray;
  if (width < 3 || height < 1 || data.length < width * height) return "even";
  const third = Math.max(1, Math.floor(width / 3));
  let left = 0, middle = 0, right = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      if (x < third) left += v; else if (x >= width - third) right += v; else middle += v;
    }
  }
  left /= third * height; right /= third * height; middle /= Math.max(1, width - 2 * third) * height;
  const mean = Math.max(1, (left + middle + right) / 3);
  const side = (left - right) / mean;
  if (side > 0.15) return "left";
  if (side < -0.15) return "right";
  if ((middle - Math.max(left, right)) / mean > 0.2) return "behind";
  return "even";
}

/** A finished take to place: its asset, its length, where its script put it, and (ADR 0069) the window that holds its line. */
export type PresenterTakeInsert = { assetId: string; durationMs: number; afterClipId: string | null; fraction: number; index: number; trim?: { startMs: number; endMs: number } | null };

/** The clip id a take gets, so placing the same take twice is a no-op. */
export const presenterTakeClipId = (assetId: string) => `script-${assetId}`;

/**
 * The finished takes placed in the reel in one change. Each goes after the clip
 * its script chose (before the first clip for the opening); if that clip has
 * since been removed it goes to the cut nearest where it was. Back-to-back
 * takes keep their order. A take plays whole, at its own sound, graded like
 * the clip it was composed into. Texts are not moved here: the command
 * retimes them like any other cut change (ADR 0048).
 */
export function insertPresenterTakes(timeline: Timeline, takes: PresenterTakeInsert[]): Timeline {
  const present = new Set(timeline.clips.map(clip => clip.id));
  const fresh = takes.filter(take => !present.has(presenterTakeClipId(take.assetId)) && take.durationMs > 0);
  if (fresh.length === 0) return timeline;
  const clips = timeline.clips;
  const starts = clipStartsMs(timeline);
  const total = timelineDurationMs(timeline);
  const boundaryOf = (take: PresenterTakeInsert) => {
    if (take.afterClipId === null) return 0;
    const at = clips.findIndex(clip => clip.id === take.afterClipId);
    if (at >= 0) return at + 1;
    const target = take.fraction * total;
    let best = 0;
    for (let b = 0; b <= clips.length; b++) {
      const ms = b < clips.length ? starts[b] : total;
      const bestMs = best < clips.length ? starts[best] : total;
      if (Math.abs(ms - target) < Math.abs(bestMs - target)) best = b;
    }
    return best;
  };
  const placed = fresh.map(take => ({ take, boundary: boundaryOf(take) })).sort((a, b) => a.boundary - b.boundary || a.take.index - b.take.index);
  const next: Clip[] = [];
  for (let b = 0; b <= clips.length; b++) {
    for (const { take } of placed.filter(p => p.boundary === b)) {
      const plate = clips[b - 1] ?? clips[b];
      // The auto-trim (ADR 0069): the line with a short lead and tail, never the garbled words Veo adds after it.
      const trim = take.trim && take.trim.endMs > take.trim.startMs ? { sourceStartMs: Math.max(0, Math.round(take.trim.startMs)), sourceEndMs: Math.min(Math.round(take.durationMs), Math.round(take.trim.endMs)) } : null;
      const window = trim && trim.sourceEndMs - trim.sourceStartMs >= 500 ? trim : { sourceStartMs: 0, sourceEndMs: Math.round(take.durationMs) };
      next.push({
        id: presenterTakeClipId(take.assetId), assetId: take.assetId, kind: "VIDEO",
        ...window, speed: 1, volume: 1, fit: "cover",
        filter: plate?.filter ?? "none", motion: "none", pano: null, spot: null, room: plate?.room ?? null,
        transitionIn: "cut", zoom: 1,
      });
    }
    if (clips[b]) next.push(clips[b]);
  }
  return { ...timeline, clips: next };
}

/** A draft script when the studio asks for one and no model is set up: a greeting, the rooms, a call to action. */
export function draftScriptLines(rooms: string[], title: string, count: number): string[] {
  const n = Math.max(1, Math.min(SCRIPT_MAX_LINES, count));
  const named = rooms.map(room => room.trim().toLowerCase()).filter(Boolean);
  const place = title.trim() || "this home";
  const middle = [
    named[0] ? `Wait until you see the ${named[0]}.` : "Wait until you see inside.",
    named[1] ? `And the ${named[1]} is made for long weekends.` : "Every room here gets beautiful light.",
  ];
  const lines = [`Come with me, let me show you ${place}.`, ...middle.slice(0, Math.max(0, n - 2)), "Message me today for a private tour."];
  return lines.slice(0, n);
}
