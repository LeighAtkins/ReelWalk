/**
 * Stock footage as sets, with a licence trail (ADR 0070). Sourcing took half
 * of every build: agents scraped a stock site through a browser looking for
 * one coherent place with no people and no watermark, and nothing recorded
 * where a clip came from. This module is the pure part: which clips belong
 * together (one creator, one shoot), which to leave out, what the licence
 * record of an imported clip says, and how much a stock clip was changed
 * before it went out (Instagram's originality rule).
 *
 * The fetching, the pixel checks and the database are in apps/web.
 */
import type { Clip, TextOverlay, Timeline } from "./timeline";
import { clipDurationMs, clipStartsMs } from "./timeline";
import { isIdentityMatch, type ColorMatch } from "./look";

export const STOCK_SOURCES = ["pixabay", "pexels"] as const;
export type StockSource = (typeof STOCK_SOURCES)[number];

export const STOCK_SOURCE_LABELS: Record<StockSource, string> = { pixabay: "Pixabay", pexels: "Pexels" };

/** What the frame checks found (ADR 0070): null when a check did not run. */
export type StockChecks = {
  /** A person (face, body, hands) in any sampled frame. */
  people: boolean | null;
  /** Burnt-in text, a logo or a watermark in any sampled frame. */
  text: boolean | null;
  /** The place, in a few words ("white kitchen, marble island"), for the group label. */
  place: string | null;
  framesChecked: number;
};

/** One search hit, source-neutral. */
export type StockClip = {
  source: StockSource;
  id: string;
  creator: string;
  creatorId: string;
  /** The clip's page, for the credit line and the licence record. */
  url: string;
  /** Poster frame. */
  poster: string;
  /** The MP4 to import. */
  file: { url: string; width: number; height: number } | null;
  durationMs: number;
  width: number;
  height: number;
  tags: string[];
  checks?: StockChecks;
};

export type StockFilters = {
  /** Only clips taller than wide. */
  portrait?: boolean;
  minMs?: number;
  maxMs?: number;
  /** Leave out clips that show people. */
  noPeople?: boolean;
  /** Leave out clips with burnt-in text or a watermark. */
  noText?: boolean;
};

export function isPortrait(width: number, height: number): boolean {
  return width > 0 && height > width;
}

/** Tags that usually mean a person is in the shot. A cheap first pass before any pixels are read. */
export const PEOPLE_TAGS: ReadonlySet<string> = new Set([
  "people", "person", "man", "woman", "men", "women", "girl", "boy", "child", "children", "kid", "kids", "family", "couple",
  "portrait", "face", "model", "hands", "hand", "baby", "crowd", "friends", "businessman", "businesswoman", "worker", "chef",
  "waiter", "guest", "guests", "tourist", "tourists", "walking", "running", "dancing", "yoga", "selfie", "lady", "guy", "human",
]);

/** Tags that usually mean lettering or a mark burnt into the picture. */
export const TEXT_TAGS: ReadonlySet<string> = new Set(["text", "typography", "logo", "watermark", "sign", "signage", "neon sign", "title", "lettering", "caption", "quote", "words"]);

const normalise = (tag: string) => tag.trim().toLowerCase();

export function tagsSuggestPeople(tags: readonly string[]): boolean {
  return tags.some((tag) => PEOPLE_TAGS.has(normalise(tag)));
}

export function tagsSuggestText(tags: readonly string[]): boolean {
  return tags.some((tag) => TEXT_TAGS.has(normalise(tag)));
}

/**
 * Whether a clip passes the filters. A pixel check that ran decides people
 * and text; without one, the tags decide. A clip whose check could not run
 * and whose tags say nothing is let through, and marked unchecked for the UI.
 */
export function passesStockFilters(clip: StockClip, filters: StockFilters): boolean {
  if (filters.portrait && !isPortrait(clip.width, clip.height)) return false;
  if (filters.minMs !== undefined && clip.durationMs < filters.minMs) return false;
  if (filters.maxMs !== undefined && clip.durationMs > filters.maxMs) return false;
  if (filters.noPeople && (clip.checks?.people ?? tagsSuggestPeople(clip.tags))) return false;
  if (filters.noText && (clip.checks?.text ?? tagsSuggestText(clip.tags))) return false;
  return true;
}

/** Clips from one creator that look like one shoot: one place, one day, one camera. */
export type StockGroup = {
  /** Stable for the same set: source, creator and the lowest clip id in it. */
  key: string;
  source: StockSource;
  creator: string;
  creatorId: string;
  /** The place, in words: the tags every clip shares, else the most common ones; a check's `place` when there is one. */
  label: string;
  tags: string[];
  clips: StockClip[];
};

export type GroupOptions = {
  /** Jaccard similarity of two clips' tags at or above which they are one shoot (default 0.34: a third of the words shared). */
  minSimilarity?: number;
  /** Ids this close from one creator with any tag in common are one upload session (default 200). */
  idSpan?: number;
};

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const tag of a) if (b.has(tag)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Groups search hits by creator, then by shoot. Stock sites have no location
 * field, so "the same place" is inferred: a creator's clips whose tags mostly
 * overlap, or that were uploaded together (consecutive ids) and share any
 * tag, are one set. Larger sets first, so one tap adds the most footage of
 * one place.
 */
export function groupStock(clips: readonly StockClip[], options: GroupOptions = {}): StockGroup[] {
  const minSimilarity = options.minSimilarity ?? 0.34;
  const idSpan = options.idSpan ?? 200;
  const byCreator = new Map<string, StockClip[]>();
  for (const clip of clips) {
    const key = `${clip.source}:${clip.creatorId}`;
    byCreator.set(key, [...(byCreator.get(key) ?? []), clip]);
  }
  const groups: StockGroup[] = [];
  for (const own of byCreator.values()) {
    const sorted = [...own].sort((a, b) => numericId(a.id) - numericId(b.id));
    const tagSets = sorted.map((clip) => new Set(clip.tags.map(normalise)));
    // Union-find over the creator's clips.
    const parent = sorted.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const similarity = jaccard(tagSets[i], tagSets[j]);
        const close = Math.abs(numericId(sorted[i].id) - numericId(sorted[j].id)) <= idSpan && similarity > 0;
        if (similarity >= minSimilarity || close) parent[find(i)] = find(j);
      }
    }
    const sets = new Map<number, StockClip[]>();
    sorted.forEach((clip, i) => sets.set(find(i), [...(sets.get(find(i)) ?? []), clip]));
    for (const members of sets.values()) {
      const first = members[0];
      groups.push({
        key: `${first.source}:${first.creatorId}:${first.id}`,
        source: first.source,
        creator: first.creator,
        creatorId: first.creatorId,
        label: groupLabel(members),
        tags: sharedTags(members, 6),
        clips: members,
      });
    }
  }
  return groups.sort((a, b) => b.clips.length - a.clips.length || a.creator.localeCompare(b.creator) || a.key.localeCompare(b.key));
}

function numericId(id: string): number {
  const n = Number(id);
  return Number.isFinite(n) ? n : 0;
}

/** Tags shared by every clip, else the most frequent ones, most frequent first. */
function sharedTags(clips: readonly StockClip[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const clip of clips) for (const tag of new Set(clip.tags.map(normalise))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const common = ranked.filter(([, n]) => n === clips.length).map(([tag]) => tag);
  return (common.length > 0 ? common : ranked.map(([tag]) => tag)).slice(0, limit);
}

function groupLabel(clips: readonly StockClip[]): string {
  const place = clips.map((clip) => clip.checks?.place).find((value): value is string => Boolean(value));
  if (place) return place;
  const tags = sharedTags(clips, 3);
  return tags.length > 0 ? tags.join(", ") : `${clips.length} clips`;
}

// ── Licence record ──────────────────────────────────────────────

/** Where an imported clip came from, read off the asset's own columns; nothing else is stored. */
export type SourceRecord = {
  assetId: string;
  source: StockSource;
  /** The clip's id on the source site. */
  id: string;
  creator: string | null;
  url: string;
  license: string | null;
  /** When the file was copied into the workspace (the asset's creation time), ISO. */
  importedAt: string | null;
};

export type SourceInput = {
  id: string;
  sourceUrl?: string | null;
  license?: string | null;
  attribution?: string | null;
  createdAt?: Date | string | null;
};

const SOURCE_URL = [
  { source: "pixabay" as const, pattern: /pixabay\.com\/(?:[a-z]{2}\/)?(?:videos|photos)\/(?:[^/]*?-)?(\d+)\/?/i },
  { source: "pexels" as const, pattern: /pexels\.com\/(?:[a-z]{2}-[a-z]{2}\/)?(?:video|photo)\/(?:[^/]*?-)?(\d+)\/?/i },
];

/** The licence record of an asset, or null when it is the studio's own upload (no source URL from a stock site). */
export function stockSource(asset: SourceInput): SourceRecord | null {
  const url = asset.sourceUrl?.trim();
  if (!url) return null;
  for (const { source, pattern } of SOURCE_URL) {
    const found = pattern.exec(url);
    if (!found) continue;
    const importedAt = asset.createdAt ? new Date(asset.createdAt).toISOString() : null;
    return { assetId: asset.id, source, id: found[1], creator: creatorFromCredit(asset.attribution), url, license: asset.license ?? null, importedAt };
  }
  return null;
}

/** "Video by Ana Ruiz on Pixabay" → "Ana Ruiz"; any other credit comes back whole. */
export function creatorFromCredit(credit: string | null | undefined): string | null {
  if (!credit) return null;
  const found = /^(?:video|photo|footage|image)\s+by\s+(.+?)\s+(?:on|via|from)\s+\S+$/i.exec(credit.trim());
  return (found ? found[1] : credit).trim() || null;
}

/** The credit line kept on an imported stock clip. */
export function stockCreditLine(clip: Pick<StockClip, "creator" | "source">): string {
  return `Video by ${clip.creator} on ${STOCK_SOURCE_LABELS[clip.source]}`;
}

/** The stock clips a reel uses, each once, with the clips that show it, in the order they first appear. */
export function reelSources(timeline: Timeline, assets: Record<string, SourceInput>): (SourceRecord & { clipIds: string[] })[] {
  const out = new Map<string, SourceRecord & { clipIds: string[] }>();
  for (const clip of timeline.clips) {
    const asset = assets[clip.assetId];
    if (!asset) continue;
    const have = out.get(clip.assetId);
    if (have) { have.clipIds.push(clip.id); continue; }
    const record = stockSource(asset);
    if (record) out.set(clip.assetId, { ...record, clipIds: [clip.id] });
  }
  return [...out.values()];
}

/** The lines for a caption: creators grouped by site ("Footage: Ana Ruiz, Ben Ito via Pixabay"). Empty when nothing is stock. */
export function sourcesCaption(records: readonly SourceRecord[]): string {
  const bySource = new Map<StockSource, string[]>();
  for (const record of records) {
    const list = bySource.get(record.source) ?? [];
    const name = record.creator ?? `#${record.id}`;
    if (!list.includes(name)) list.push(name);
    bySource.set(record.source, list);
  }
  return [...bySource.entries()].map(([source, names]) => `Footage: ${names.join(", ")} via ${STOCK_SOURCE_LABELS[source]}`).join("\n");
}

// ── Transform check ─────────────────────────────────────────────

/** Each way a clip was changed from the file it came from, 0..1, and the weight it carries. */
export type TransformSignals = {
  /** How much of the source was cut away: 1 − (window ÷ source length). */
  recut: number;
  speed: number;
  grade: number;
  colorMatch: number;
  zoom: number;
  motion: number;
  /** A title over the clip; a little more when it carries particles. */
  text: number;
  transition: number;
  lens: number;
};

export const TRANSFORM_WEIGHTS: Record<keyof TransformSignals, number> = {
  recut: 0.25, speed: 0.15, grade: 0.15, colorMatch: 0.15, zoom: 0.15, motion: 0.1, text: 0.25, transition: 0.05, lens: 0.05,
};

/** Below this a stock clip went out as it came in. */
export const UNTOUCHED_BELOW = 0.25;

export type TransformScore = { score: number; signals: TransformSignals; untouched: boolean };

export type TransformContext = {
  /** The reel's titles; those over the clip's reel window count. */
  texts?: readonly TextOverlay[];
  /** Where the clip starts in the reel (ms); needed for `texts`. */
  clipStartMs?: number;
  /** The source file's length (ms), to tell a recut from a clip played whole. */
  sourceDurationMs?: number | null;
};

/**
 * How much a clip was transformed from its source (ADR 0070): a weighted sum
 * of the edits made to it, capped at 1. Pure; `untouched` is what the critic
 * flags on a stock clip, since Instagram recommends only original work and a
 * clip posted as downloaded is not that.
 */
export function transformScore(clip: Clip, context: TransformContext = {}): TransformScore {
  const window = clip.sourceEndMs - clip.sourceStartMs;
  const source = context.sourceDurationMs ?? null;
  const recut = source && source > 0 && clip.kind === "VIDEO" ? clamp01(1 - window / source) : 0;
  const start = context.clipStartMs ?? 0;
  const end = start + clipDurationMs(clip);
  const over = (context.texts ?? []).filter((text) => text.startMs < end && text.endMs > start);
  const text = over.length === 0 ? 0 : over.some((t) => t.particles || t.shine || t.kinetic) ? 1 : 0.8;
  const signals: TransformSignals = {
    recut,
    speed: clip.speed !== 1 ? 1 : 0,
    grade: clip.filter !== "none" ? 1 : 0,
    colorMatch: isIdentityMatch(clip.colorMatch as ColorMatch | undefined) ? 0 : 1,
    zoom: clamp01((clip.zoom - 1) / 0.5),
    motion: clip.motion !== "none" ? 1 : 0,
    text,
    transition: clip.transitionIn !== "cut" ? 1 : 0,
    lens: clip.lensSoftness && clip.lensSoftness > 0 ? 1 : 0,
  };
  const score = Math.min(1, (Object.keys(TRANSFORM_WEIGHTS) as (keyof TransformSignals)[]).reduce((acc, key) => acc + TRANSFORM_WEIGHTS[key] * signals[key], 0));
  return { score: Math.round(score * 100) / 100, signals, untouched: score < UNTOUCHED_BELOW };
}

/**
 * The stock clips in a reel that went out untouched, for the critic (W3-F).
 * `isStock` says whether an asset came from a stock site (`stockSource(asset) !== null`).
 */
export function untouchedStockClips(timeline: Timeline, isStock: (assetId: string) => boolean, sourceDurationsMs: Record<string, number | null | undefined> = {}): { clipId: string; assetId: string; score: number }[] {
  const starts = clipStartsMs(timeline);
  return timeline.clips.flatMap((clip, index) => {
    if (!isStock(clip.assetId)) return [];
    const result = transformScore(clip, { texts: timeline.texts, clipStartMs: starts[index], sourceDurationMs: sourceDurationsMs[clip.assetId] });
    return result.untouched ? [{ clipId: clip.id, assetId: clip.assetId, score: result.score }] : [];
  });
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
