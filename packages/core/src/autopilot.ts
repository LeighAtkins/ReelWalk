/**
 * "Make it for me" (ADR 0021): one button from a pile of shots to a finished
 * reel. The model cuts it from a style and whatever facts the studio gave
 * (ai-edit.ts); this module makes sure the result is always complete (music
 * cut to the beat, a hook over the first shot, the details card when there
 * are facts) and, when the model is not there, over its allowance or wrong,
 * cuts the reel by rule instead, so the first reel anyone makes is finished.
 */
import { AI_BRIEFS, type AiAsset, type AiBrief, type AiSong } from "./ai-edit";
import type { InstagramAudioTrack } from "./instagram-audio";
import { snapCutsToBeats } from "./beats";
import { carryOpeningTitle, planCutOnTimeline, planReport, type CutBrief, type CutPlan } from "./cut-planner";
import type { PlannerAnalysis } from "./shot-facts";
import {
  MIN_CLIP_MS,
  addRoomLabels,
  addText,
  clipDurationMs,
  hasDetails,
  keepTextsClearOfCard,
  listingDetailsSchema,
  setDetails,
  setMusic,
  timelineDurationMs,
  type Clip,
  type ListingDetails,
  type TextStyle,
  type Timeline,
} from "./timeline";

/** What the studio may type before it presses the button. Every field is optional. */
export type ListingInfo = {
  address?: string;
  price?: string;
  beds?: string;
  baths?: string;
  area?: string;
  /** "Saturday 1–3 pm". */
  openHouse?: string;
  contact?: string;
};

export type AutopilotStyle = {
  id: string;
  /** Seconds a shot plays when cut by rule. */
  shotMs: number;
  /** Longest reel the rule cut makes. */
  maxMs: number;
  /** Words that pick a song from the library's moods. */
  mood: RegExp;
  filter: Clip["filter"];
  hook(info: ListingInfo): { text: string; style: TextStyle; size: number };
  roomLabels: boolean;
  detailsCard: boolean;
};

export const AUTOPILOT_STYLES: Record<string, AutopilotStyle> = {
  "just-listed": {
    id: "just-listed",
    shotMs: 2000,
    maxMs: 26000,
    mood: /popular|nu disco|upbeat house|cheerful|upbeat|sunny|bouncy/,
    filter: "none",
    hook: () => ({ text: "Just listed", style: "headline", size: 1.2 }),
    roomLabels: false,
    detailsCard: true,
  },
  privacy: {
    id: "privacy",
    shotMs: 3500,
    maxMs: 24000,
    mood: /piano|luxury|soft house|calm|soft|smooth|classy/,
    filter: "none",
    hook: () => ({ text: "the privacy I want", style: "elegant", size: 1.1 }),
    roomLabels: false,
    detailsCard: false,
  },
  "open-house": {
    id: "open-house",
    shotMs: 2000,
    maxMs: 24000,
    mood: /popular|real estate|soft house|cheerful|upbeat|sunny|bouncy/,
    filter: "none",
    hook: (info) => ({ text: info.openHouse ? `Open home\n${info.openHouse}` : "Open home", style: "box", size: 1.1 }),
    roomLabels: false,
    detailsCard: true,
  },
  walkthrough: {
    id: "walkthrough",
    shotMs: 2600,
    maxMs: 36000,
    mood: /real estate|soft house|lo-fi|warm|relaxed|easy|gentle|hopeful/,
    filter: "warm",
    hook: (info) => ({ text: info.address?.trim() || "Take a look inside", style: "plain", size: 1 }),
    roomLabels: false,
    detailsCard: true,
  },
};

export function autopilotStyle(id: string | null | undefined): AutopilotStyle {
  return AUTOPILOT_STYLES[id ?? ""] ?? AUTOPILOT_STYLES["just-listed"];
}

const clean = (value: string | undefined) => (value ?? "").trim();

function infoLines(info: ListingInfo): string[] {
  return [
    clean(info.address) && `address: ${clean(info.address)}`,
    clean(info.price) && `price: ${clean(info.price)}`,
    clean(info.beds) && `beds: ${clean(info.beds)}`,
    clean(info.baths) && `baths: ${clean(info.baths)}`,
    clean(info.area) && `area: ${clean(info.area)}`,
    clean(info.openHouse) && `open home: ${clean(info.openHouse)}`,
    clean(info.contact) && `contact: ${clean(info.contact)}`,
  ].filter(Boolean) as string[];
}

/** The request the model gets: the style's brief, the facts given, and no questions. */
export function autopilotRequest(styleId: string, info: ListingInfo): string {
  const brief: AiBrief = AI_BRIEFS.find((entry) => entry.id === styleId) ?? AI_BRIEFS[0];
  const facts = infoLines(info);
  return [
    brief.text.replace(/ Ask me for[^.]*\./, ""),
    facts.length ? `The facts for the details card and text: ${facts.join("; ")}.` : "No listing facts were given: leave the details card empty.",
    "Do everything in one go: order and cut my shots on the beat, pick the song if the reel has none (keep the one it has otherwise), write the hook. The room order above is only a guide: make the best reel from the shots I have, whatever they show, and always return a cut. Never show a photo twice or the same part of a video twice: with only a few shots, make a shorter reel (12 to 15 seconds is fine) rather than repeat one. Do not ask me anything; where a fact is missing, leave it out. Every clip must be on screen at least 1.5 seconds.",
  ].join(" ");
}

/**
 * The listing facts as a details card, or null when there are none. A style
 * without a card keeps the facts on the reel unseen (placement "none"), so a
 * later request ("add the details card", "write the caption") has them.
 */
export function detailsFromInfo(info: ListingInfo, style: AutopilotStyle): ListingDetails | null {
  const contact = clean(info.contact) || (clean(info.openHouse) && style.id === "open-house" ? `Open home ${clean(info.openHouse)}` : "");
  const details = listingDetailsSchema.parse({
    price: clean(info.price).slice(0, 24),
    beds: clean(info.beds).slice(0, 6),
    baths: clean(info.baths).slice(0, 6),
    area: clean(info.area).slice(0, 16),
    address: clean(info.address).slice(0, 80),
    contact: contact.slice(0, 60),
    placement: style.detailsCard ? "end" : "none",
  });
  return hasDetails(details) ? details : null;
}

/** The song that fits the style best: an Instagram sound by its mood first, then a library song whose tempo is known. */
export function pickSong(songs: AiSong[], style: AutopilotStyle): AiSong | null {
  const instagram = songs.filter((song) => song.instagram);
  if (instagram.length) return instagram.find((song) => style.mood.test(song.mood ?? "")) ?? instagram[0];
  const withBeat = songs.filter((song) => song.bpm);
  return withBeat.find((song) => style.mood.test(song.mood ?? "")) ?? withBeat[0] ?? songs[0] ?? null;
}

type Context = { assets: Record<string, AiAsset | undefined>; songs: AiSong[]; info: ListingInfo; style: AutopilotStyle; newId: () => string };

const OUTSIDE_FIRST = /exterior|facade|façade|front|drone|aerial|street|outside|arrival/i;
const VIEW_LAST = /view|pool|balcony|terrace|deck|garden|sunset|dusk|lagoon|sea|ocean|lake|yard/i;

function nameOf(clip: Clip, assets: Context["assets"]): string {
  return `${clip.room ?? ""} ${assets[clip.assetId]?.title ?? ""}`;
}

function durations(assets: Context["assets"]): Record<string, number | null> {
  return Object.fromEntries(Object.values(assets).filter(Boolean).map((asset) => [asset!.id, asset!.durationMs]));
}

/**
 * Makes sure a cut is a finished reel: music cut to the beat, a hook over
 * the first shot, the facts on the details card, room labels when the
 * style wants them. Leaves alone whatever the model already did.
 */
export function finishAutopilot(
  timeline: Timeline,
  context: Context & { instagramPick?: InstagramAudioTrack },
): { timeline: Timeline; added: string[]; instagramPick?: InstagramAudioTrack } {
  const { songs, style, info, newId } = context;
  const added: string[] = [];
  let current = timeline;
  let instagramPick = context.instagramPick;
  if (current.clips.length === 0) return { timeline: current, added, instagramPick };

  // A photo shown twice reads as padding: keep its first appearance only.
  const seen = new Set<string>();
  const clips = current.clips.filter((clip) => {
    if (clip.kind !== "IMAGE") return true;
    if (seen.has(clip.assetId)) return false;
    seen.add(clip.assetId);
    return true;
  });
  if (clips.length < current.clips.length) {
    added.push(`${current.clips.length - clips.length} repeated photo${current.clips.length - clips.length === 1 ? "" : "s"} taken out`);
    current = { ...current, clips };
    if (current.music?.bpm) current = snapCutsToBeats(current, durations(context.assets));
  }

  if (!current.music && !instagramPick) {
    const song = pickSong(songs, style);
    if (song?.instagram) {
      instagramPick = song.instagram;
      added.push(`music: ${song.title} from Instagram`);
    } else if (song) {
      const asset = context.assets[song.id];
      // A new reel's song has "On the beat" on (ADR 0059).
      current = setMusic(current, { assetId: song.id, sourceStartMs: 0, volume: 0.8, bpm: song.bpm ?? asset?.bpm ?? null, beatOffsetMs: asset?.beatOffsetMs ?? null, onBeat: true, autoPicked: true });
      current = snapCutsToBeats(current, durations(context.assets));
      added.push(`music: ${song.title}, cuts on the beat`);
    }
  }

  const details = detailsFromInfo(info, style);
  if (details) {
    // The model's own fields win, except that a style without a card keeps the card hidden.
    const theirs = Object.fromEntries(Object.entries(current.details ?? {}).filter(([key, value]) => value && (style.detailsCard || key !== "placement")));
    const merged = listingDetailsSchema.parse({ ...details, ...theirs });
    if (JSON.stringify(merged) !== JSON.stringify(current.details)) {
      current = setDetails(current, merged);
      added.push("details card");
    }
  }

  if (!current.texts.some((text) => !text.id.startsWith("room-"))) {
    const hook = style.hook(info);
    const first = clipDurationMs(current.clips[0]);
    current = addText(current, { id: newId(), text: hook.text, startMs: 0, endMs: Math.max(first, 1500), x: 0.5, y: 0.42, style: hook.style, color: "#ffffff", size: hook.size, byApp: true });
    added.push(`hook "${hook.text.replace(/\n/g, " ")}"`);
  }

  if (style.roomLabels && current.clips.some((clip) => clip.room) && !current.texts.some((text) => text.id.startsWith("room-"))) {
    current = addRoomLabels(current);
    added.push("room labels");
  }
  // The card was added last: anything the model put where it now sits moves up.
  current = keepTextsClearOfCard(current);
  return { timeline: current, added, instagramPick };
}

/**
 * The cut by rule, for when there is no model or its answer is unusable:
 * outside shots first and views last, photos at the style's pace with a
 * slow push-in, 360 photos as sweeps, one shot per video from its middle (a
 * shoot of fewer than three clips may give a long video two separate windows),
 * the whole reel kept under the style's length.
 */
export function ruleCut(timeline: Timeline, context: Context): Timeline {
  const { assets, style, newId } = context;
  const first = timeline.clips.filter((clip) => OUTSIDE_FIRST.test(nameOf(clip, assets)));
  const last = timeline.clips.filter((clip) => !first.includes(clip) && VIEW_LAST.test(nameOf(clip, assets)));
  const middle = timeline.clips.filter((clip) => !first.includes(clip) && !last.includes(clip));
  const ordered = [...first, ...middle, ...last];

  const shots: Clip[] = [];
  for (const clip of ordered) {
    if (clip.kind === "IMAGE") {
      const length = clip.pano ? Math.max(3500, style.shotMs) : style.shotMs;
      shots.push({ ...clip, sourceStartMs: 0, sourceEndMs: length, speed: 1, motion: clip.pano ? "none" : "zoom-in", filter: style.filter, transitionIn: "cut" });
      continue;
    }
    const source = assets[clip.assetId]?.durationMs ?? clip.sourceEndMs;
    const length = Math.min(style.shotMs, Math.max(MIN_CLIP_MS, source));
    // One shot per clip. Only a shoot of fewer than three clips splits a long video, into two windows
    // with a gap between them (a mid-clip split of a longer shoot read as a stutter: ADR 0021, 0024).
    const pieces = ordered.length < 3 && source >= length * 3 ? 2 : 1;
    for (let piece = 0; piece < pieces; piece++) {
      const room = Math.max(0, source - length);
      const start = pieces === 1 ? Math.round(room / 2) : Math.round(room * (piece === 0 ? 0.1 : 0.9));
      const end = Math.min(source, start + length);
      shots.push({ ...clip, id: piece === 0 ? clip.id : newId(), sourceStartMs: Math.max(0, end - length), sourceEndMs: end, speed: 1, filter: style.filter, transitionIn: "cut" });
    }
  }

  // Too long: drop shots from the middle until it fits, keeping the opening and the ending.
  while (shots.length > 4 && shots.reduce((sum, clip) => sum + clipDurationMs(clip), 0) > style.maxMs) {
    shots.splice(Math.floor(shots.length / 2), 1);
  }
  const base: Timeline = { ...timeline, clips: shots, texts: [], music: null, details: null };
  return finishAutopilot(base, context).timeline;
}

/** ruleCut, and the Instagram sound it chose when the songs offered were Instagram's. */
export function ruleCutWithPick(timeline: Timeline, context: Context): { timeline: Timeline; instagramPick?: InstagramAudioTrack } {
  const cut = ruleCut(timeline, context);
  if (cut.music) return { timeline: cut };
  const song = pickSong(context.songs, context.style);
  return { timeline: cut, instagramPick: song?.instagram };
}

/** Whether the model's cut can be shown as the reel: clips, a sensible length, nothing absurdly short. */
export function usableCut(timeline: Timeline): boolean {
  const total = timelineDurationMs(timeline);
  return timeline.clips.length > 0 && total >= 6000 && total <= 90_000 && timeline.clips.every((clip) => clipDurationMs(clip) >= 700);
}

/** The feel a style asks for, when the person was not asked (ADR 0087): the slow luxury style is quiet, the quick ones lively. */
export function briefForStyle(style: AutopilotStyle, brief: Partial<CutBrief> = {}): CutBrief {
  const feel = brief.feel ?? (style.id === "privacy" ? "quiet" : style.id === "just-listed" ? "lively" : "classic");
  const listing = brief.listing ?? (style.id === "open-house" ? "open-home" : "for-sale");
  return { listing, feel };
}

/**
 * The first cut by the cut planner (ADR 0087), when the clips have their shot analysis: the song first (its beat grid
 * shapes the lengths; nothing is snapped afterwards), then the plan, then the finish (details card, hook), and the
 * hook carried across the first cut. Never a finish button: Pop stays off this path. Null when no clip has an
 * analysis, or the plan fails its own gate (the caller then cuts by rule).
 */
export function plannedCut(
  timeline: Timeline,
  context: Context & { analyses: Record<string, PlannerAnalysis | null | undefined>; brief?: Partial<CutBrief>; sourceDurationsMs?: Record<string, number | null | undefined> },
): { timeline: Timeline; plan: CutPlan; instagramPick?: InstagramAudioTrack } | null {
  if (!timeline.clips.some((clip) => context.analyses[clip.assetId])) return null;
  let base: Timeline = { ...timeline, texts: [], music: null, details: null };
  let instagramPick: InstagramAudioTrack | undefined;
  const song = pickSong(context.songs, context.style);
  if (song?.instagram) instagramPick = song.instagram;
  else if (song) {
    const asset = context.assets[song.id];
    base = setMusic(base, { assetId: song.id, sourceStartMs: 0, volume: 0.8, bpm: song.bpm ?? asset?.bpm ?? null, beatOffsetMs: asset?.beatOffsetMs ?? null, onBeat: true, autoPicked: true });
  }
  // An Instagram sound is attached at posting, but its tempo still paces the cut.
  const withGrid = instagramPick && song?.bpm && !base.music ? { ...base, music: { assetId: song.id, sourceStartMs: 0, volume: 0.8, bpm: song.bpm, beatOffsetMs: 0 } as Timeline["music"] } : base;
  let planned: { timeline: Timeline; plan: CutPlan };
  try {
    planned = planCutOnTimeline(withGrid, { analyses: context.analyses, brief: briefForStyle(context.style, context.brief), sourceDurationsMs: context.sourceDurationsMs ?? durations(context.assets), carry: true });
  } catch {
    return null;
  }
  const cut: Timeline = withGrid === base ? planned.timeline : { ...planned.timeline, music: base.music };
  const finished = finishAutopilot(cut, { ...context, instagramPick });
  const result = carryOpeningTitle(finished.timeline, planned.plan.carryUntilMs);
  if (!planReport(result, planned.plan).pass) return null;
  return { timeline: result, plan: planned.plan, instagramPick: finished.instagramPick ?? instagramPick };
}
