/**
 * Variants (ADR 0063): from one finished reel, sibling reels that open
 * differently (three hooks) at two lengths, so the studio can post them and
 * see which one Instagram likes. Every variant is made from the source
 * timeline with the editor's own commands (moveClip, deleteClip, trimClip,
 * retimeToLength, snapToBeat), so titles move the way they move in the
 * editor, and it refers to the same media assets: nothing is copied.
 *
 * Pure and deterministic: the same reel and inputs give the same variants.
 */
import { applyCommand, type Command } from "./commands";
import { textAttachment } from "./text-timing";
import {
  addRoomLabels,
  clipDurationMs,
  clipStartsMs,
  hasDetails,
  hasRoomLabels,
  keepTextsClearOfCard,
  textSchema,
  timelineDurationMs,
  timelineSchema,
  type Clip,
  type Timeline,
} from "./timeline";
import { transcriptWindow, type Transcript } from "./transcript";

export const VARIANT_HOOKS = ["hero", "presenter", "title"] as const;
export type VariantHook = (typeof VARIANT_HOOKS)[number];
export const VARIANT_LENGTHS_S = [15, 30] as const;
export type VariantLength = (typeof VARIANT_LENGTHS_S)[number];

export const VARIANT_HOOK_LABELS: Record<VariantHook, string> = {
  hero: "Hero shot first",
  presenter: "Presenter first",
  title: "Title card first",
};

/** No shot in a variant plays for less than this: more clips than fit are dropped, evenly, keeping the last. */
export const MIN_VARIANT_SHOT_MS = 1500;
/** The presenter's line may take up to this share of the variant. */
const PRESENTER_SHARE = 0.45;
/** How long the title card holds over the opening. */
export const TITLE_CARD_MS = 2500;
/** A variant may run at most this much over its length; more and shots are dropped, or the variant is skipped. */
export const MAX_OVER_MS = 2000;
/** A 30 s variant must be at least this much longer than the 15 s one to be worth making. */
const MIN_LENGTH_GAP_MS = 3000;
/** Rooms that make a hero shot, best first, when the studio has not picked a cover. */
const HERO_ROOMS = ["exterior", "aerial", "view", "pool"];

export type VariantInput = {
  /** The reel's title: the title card's words when the reel has no listing details and no headline. */
  title: string;
  /** Source lengths by asset id, so trims never run past a video's end. */
  sourceDurationsMs: Record<string, number | null | undefined>;
  /** What each video says (ADR 0035), by asset id: finds the presenter's line. */
  transcripts?: Record<string, Transcript | null | undefined>;
};

export type Variant = { hook: VariantHook; lengthS: VariantLength; timeline: Timeline; totalMs: number };
export type SkippedVariant = { hook: VariantHook; lengthS: VariantLength; reason: string };

/** The shot a hero variant opens on: the studio's cover frame, else the exterior, aerial, view or pool, else the first shot. */
export function heroClipId(timeline: Timeline): string | null {
  if (timeline.cover && timeline.clips.some((clip) => clip.id === timeline.cover!.clipId)) return timeline.cover.clipId;
  for (const room of HERO_ROOMS) {
    const clip = timeline.clips.find((item) => item.room?.toLowerCase() === room);
    if (clip) return clip.id;
  }
  return timeline.clips[0]?.id ?? null;
}

/** The first video in which someone speaks within the part the reel plays: the presenter's line. */
export function presenterClipId(timeline: Timeline, transcripts: VariantInput["transcripts"] = {}): string | null {
  const clip = timeline.clips.find((item) => {
    const transcript = item.kind === "VIDEO" ? transcripts[item.assetId] : null;
    return transcript ? transcriptWindow(transcript, item.sourceStartMs, item.sourceEndMs).length > 0 : false;
  });
  return clip?.id ?? null;
}

/** The words of the title card: the details' price and address, else the reel's first headline, else its title unless that is the default "Reel 3". */
export function titleCardText(timeline: Timeline, title: string): string | null {
  const details = timeline.details;
  if (details && hasDetails(details)) {
    const line = [details.price, details.address].filter(Boolean).join(" · ");
    if (line) return line.slice(0, 200);
  }
  const headline = timeline.texts.find((text) => !text.id.startsWith("room-") && (text.style === "headline" || text.style === "elegant"));
  if (headline) return headline.text;
  const clean = title.trim();
  return clean && !/^reel \d+$/i.test(clean) ? clean.slice(0, 200) : null;
}

/** `count` of `items`, spread evenly through them in their order, always keeping the last (the ending). */
function spread<T>(items: T[], count: number): T[] {
  if (count >= items.length) return items;
  if (count <= 0) return [];
  if (count === 1) return [items[items.length - 1]];
  return Array.from({ length: count }, (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]);
}

/**
 * The presenter's clip, at most `maxMs` long, ending between words: a cut
 * that would fall inside a word finishes the word when that fits, else
 * comes back to the end of the word before. Returns the source window.
 */
function presenterWindow(clip: Clip, maxMs: number, transcript: Transcript | null | undefined, sourceMs: number | null | undefined) {
  const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
  const start = clip.sourceStartMs;
  const limit = Math.min(start + Math.round(maxMs * speed), sourceMs ?? Infinity);
  let end = Math.min(clip.sourceEndMs, limit);
  const words = [...(transcript?.words ?? [])].sort((a, b) => a.s - b.s);
  const at = words.findIndex((word) => word.s < end && word.e > end);
  if (at !== -1) {
    // A short breath after the word, never into the next one.
    const after = (index: number) => words[index].e + Math.max(0, Math.min(150, (words[index + 1]?.s ?? Infinity) - words[index].e));
    if (after(at) <= limit) end = after(at);
    else if (at > 0 && after(at - 1) - start >= 1000 * speed) end = after(at - 1);
  }
  return { sourceStartMs: start, sourceEndMs: end };
}

/** Whether a source time falls inside a spoken word. */
const insideWord = (transcript: Transcript | null | undefined, ms: number) => Boolean(transcript?.words.some((word) => word.s < ms && word.e > ms));

/**
 * Pinned titles (ADR 0039) that still sit on the frames they were tracked
 * on. Retiming keeps a video's middle, so a title tracked on 0.5–2.5 s of a
 * 10 s clip can end up over 3.75–6.25 s: a flash whose path is off the
 * picture shown. Those are dropped, as are pinned titles left over another
 * asset or squeezed under 400 ms.
 */
function keepPinsOnTheirPicture(timeline: Timeline): Timeline {
  const starts = clipStartsMs(timeline);
  const texts = timeline.texts.filter((text) => {
    if (!text.pin) return true;
    const index = starts.findIndex((start, i) => text.startMs >= start && text.startMs < start + clipDurationMs(timeline.clips[i]));
    const clip = timeline.clips[index];
    if (!clip || clip.assetId !== text.pin.assetId || text.endMs - text.startMs < 400) return false;
    const overlap = Math.min(clip.sourceEndMs, text.pin.toMs) - Math.max(clip.sourceStartMs, text.pin.fromMs);
    return overlap >= Math.min(600, text.pin.toMs - text.pin.fromMs);
  });
  return texts.length === timeline.texts.length ? timeline : { ...timeline, texts };
}

/**
 * One variant, or why it cannot be made. Steps, each a document command:
 * the lead shot is moved first; shots beyond what fits at
 * `MIN_VARIANT_SHOT_MS` are dropped evenly (their own titles with them);
 * the rest is brought to length with `retimeToLength`; the presenter's line
 * is given back its words; cuts go back on the beat (not when that would
 * cut the presenter mid-word). Shots that cannot be that short (a 360
 * photo needs 3.5 s, `retime`) can leave the cut long: the real length is
 * measured and one more shot dropped until it fits; a variant still more
 * than `MAX_OVER_MS` over is skipped.
 */
export function buildVariant(source: Timeline, hook: VariantHook, lengthS: VariantLength, input: VariantInput): Variant | SkippedVariant {
  const skip = (reason: string): SkippedVariant => ({ hook, lengthS, reason });
  if (source.clips.length === 0) return skip("The reel has no shots.");
  const totalMs = lengthS * 1000;
  const context = { generation: 0, sourceDurationsMs: input.sourceDurationsMs };

  const leadId = hook === "hero" ? heroClipId(source) : hook === "presenter" ? presenterClipId(source, input.transcripts) : source.clips[0].id;
  if (!leadId) return skip(hook === "presenter" ? "No shot has someone speaking in it." : "The reel has no shots.");
  const titleText = hook === "title" ? titleCardText(source, input.title) : null;
  if (hook === "title" && !titleText) return skip("Nothing to put on a title card: add the listing details or a headline.");
  const leadClip = source.clips.find((clip) => clip.id === leadId)!;
  const transcript = input.transcripts?.[leadClip.assetId];
  // The presenter's line keeps its own length (up to a share of the reel); everything else shares the time.
  const leadWindow = hook === "presenter" ? presenterWindow(leadClip, Math.round(totalMs * PRESENTER_SHARE), transcript, input.sourceDurationsMs[leadClip.assetId]) : null;
  if (leadWindow && insideWord(transcript, leadWindow.sourceEndMs)) {
    return skip(`Her first line does not reach a pause within ${Math.round((totalMs * PRESENTER_SHARE) / 1000)} s, so it would be cut mid-word. Trim her clip to a shorter line.`);
  }
  const leadMs = leadWindow ? Math.round((leadWindow.sourceEndMs - leadWindow.sourceStartMs) / (leadClip.kind === "IMAGE" ? 1 : leadClip.speed)) : 0;
  const others = source.clips.filter((clip) => clip.id !== leadId);

  /** The cut with `count` of the other shots kept. */
  const cut = (count: number): Timeline => {
    let timeline = source;
    const run = (command: Command) => {
      const result = applyCommand(timeline, command, context);
      if (result.rejected) throw new Error(`${command.type}: ${result.rejected}`);
      timeline = result.timeline;
    };
    run({ type: "moveClip", clipId: leadId, toIndex: 0 });
    // Drop what does not fit, evenly, keeping the ending; a dropped shot's own titles go with it.
    const keep = new Set(spread(others, count).map((clip) => clip.id));
    const dropped = new Set(others.filter((clip) => !keep.has(clip.id)).map((clip) => clip.id));
    if (dropped.size > 0) {
      const before = timeline;
      timeline = { ...timeline, texts: timeline.texts.filter((text) => {
        const attachment = textAttachment(before, text);
        return !(attachment.kind === "clip" && dropped.has(attachment.clipId));
      }) };
      for (const clipId of dropped) run({ type: "deleteClip", clipId });
    }
    if (leadWindow) {
      const rest = timeline.clips.length - 1;
      // retimeToLength gives every shot the same share; asking for the rest's time scaled up to all shots gives the rest that share.
      if (rest > 0) run({ type: "retimeToLength", totalMs: Math.round(((totalMs - leadMs) * timeline.clips.length) / rest) });
      run({ type: "trimClip", clipId: leadId, window: leadWindow });
      if (timeline.music?.bpm && timeline.clips.length > 1) {
        // Back on the beat, unless that would cut the presenter mid-word: then the line wins and the rest keeps its timing.
        const unsnapped = timeline;
        run({ type: "snapToBeat" });
        if (insideWord(transcript, timeline.clips[0].sourceEndMs)) timeline = unsnapped;
      }
    } else {
      run({ type: "retimeToLength", totalMs });
    }
    return timeline;
  };

  let timeline: Timeline;
  try {
    let count = Math.min(others.length, Math.max(0, leadWindow ? Math.floor((totalMs - leadMs) / MIN_VARIANT_SHOT_MS) : Math.floor(totalMs / MIN_VARIANT_SHOT_MS) - 1));
    timeline = cut(count);
    // Measured, not assumed: 360 photos and beat snaps can leave the cut long.
    while (timelineDurationMs(timeline) > totalMs + MAX_OVER_MS && count > 0) timeline = cut(--count);
  } catch (error) {
    return skip(error instanceof Error ? error.message : String(error));
  }
  if (timelineDurationMs(timeline) > totalMs + MAX_OVER_MS) {
    return skip(`It would run ${Math.round(timelineDurationMs(timeline) / 1000)} s even with the fewest shots.`);
  }
  timeline = keepPinsOnTheirPicture(timeline);

  // A drawn opener (ADR 0041) and words-behind titles were made for the source's first shot.
  if (timeline.clips[0].id !== source.clips[0].id || hook === "title") {
    timeline = { ...timeline, hook: null, texts: timeline.texts.filter((text) => !text.id.startsWith("hook-word-")) };
  }
  if (timeline.cover && !timeline.clips.some((clip) => clip.id === timeline.cover!.clipId)) timeline = { ...timeline, cover: null };
  if (hook === "hero") timeline = { ...timeline, cover: { clipId: leadId, offsetMs: 0 } };

  const details = timeline.details;
  // With a price or an address, the title card is the listing's own facts card, moved to the opening.
  const cardIsTitle = hook === "title" && Boolean(details && hasDetails(details) && (details.price || details.address));
  if (details && hasDetails(details)) {
    if (cardIsTitle) {
      // The facts card opens the reel (and still closes it when it did).
      const placement = details.placement === "end" || details.placement === "both" ? "both" : "start";
      timeline = { ...timeline, details: { ...details, placement } };
    } else if (details.placement === "start" || details.placement === "both") {
      // The first thing seen is the hero, the presenter or the title, not a card over them.
      timeline = { ...timeline, details: { ...details, placement: "end" } };
    }
  }
  if (hook === "title" && !cardIsTitle) {
    const endMs = Math.min(TITLE_CARD_MS, clipDurationMs(timeline.clips[0]), timelineDurationMs(timeline));
    // The title card replaces whatever opened the reel before.
    const texts = timeline.texts.filter((text) => text.id.startsWith("room-") || text.startMs >= endMs);
    const card = textSchema.parse({ id: "variant-title", text: titleText!, startMs: 0, endMs, x: 0.5, y: 0.42, style: "headline", font: "serif", size: 1.2, animation: "fade" });
    timeline = { ...timeline, texts: [card, ...texts].slice(0, 50) };
  }
  // The card may have moved: room labels make way for it again.
  if (hasRoomLabels(timeline)) timeline = addRoomLabels(timeline);
  timeline = timelineSchema.parse(keepTextsClearOfCard(timeline));
  return { hook, lengthS, timeline, totalMs: timelineDurationMs(timeline) };
}

/**
 * Every hook at every length. A variant that would be the same as one
 * already made, or a 30 s version the footage cannot fill, is skipped with
 * the reason, so the studio is told rather than shown duplicates.
 */
export function buildVariants(source: Timeline, input: VariantInput): { variants: Variant[]; skipped: SkippedVariant[] } {
  const variants: Variant[] = [];
  const skipped: SkippedVariant[] = [];
  for (const hook of VARIANT_HOOKS) {
    for (const lengthS of VARIANT_LENGTHS_S) {
      const made = buildVariant(source, hook, lengthS, input);
      if ("reason" in made) {
        skipped.push(made);
        continue;
      }
      const shorter = variants.find((other) => other.hook === hook && other.lengthS < lengthS);
      if (shorter && made.totalMs - shorter.totalMs < MIN_LENGTH_GAP_MS) {
        skipped.push({ hook, lengthS, reason: `Not enough footage for a longer version: it would run ${Math.round(made.totalMs / 1000)} s.` });
        continue;
      }
      const same = variants.find((other) => other.lengthS === lengthS && JSON.stringify(other.timeline) === JSON.stringify(made.timeline));
      if (same) {
        skipped.push({ hook, lengthS, reason: `It would be the same as “${VARIANT_HOOK_LABELS[same.hook]}”.` });
        continue;
      }
      variants.push(made);
    }
  }
  return { variants, skipped };
}

/** A variant's numbers from Instagram (ADR 0027), stored when read. Null when not posted or not reported. */
export type VariantNumbers = { reelId: string; views: number | null; reach: number | null };

/**
 * The variant that is winning: most plays (views), then most reached. Only
 * named when at least two variants of the set have numbers, so a lone
 * posted variant is not called a winner.
 */
export function variantWinner(rows: VariantNumbers[]): string | null {
  const counted = rows.filter((row) => row.views !== null || row.reach !== null);
  if (counted.length < 2) return null;
  const sorted = [...counted].sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || (b.reach ?? -1) - (a.reach ?? -1));
  const [best, next] = sorted;
  // A tie is no winner.
  return best.views === next.views && best.reach === next.reach ? null : best.reelId;
}

/** What Export all is about to use, in words, before anything starts. */
export function exportAllSummary(count: number, remaining: number | null, atOnce: number): string {
  const exports = (n: number) => `${n} export${n === 1 ? "" : "s"}`;
  const starting = remaining === null ? count : Math.min(count, remaining);
  const parts = [remaining === null ? `This starts ${exports(count)}.` : `This uses ${starting} of your ${remaining} exports left this month.`];
  if (remaining !== null && remaining < count) parts.push(`Only ${exports(remaining)} can start; the rest wait for next month or a bigger plan.`);
  if (atOnce < starting) parts.push(atOnce === 0 ? "Your plan's renders are all busy: wait for one to finish." : `${atOnce} can render at once now; tap Export all again for the rest when they finish.`);
  return parts.join(" ");
}
