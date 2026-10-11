/**
 * Free stock footage from Pixabay. Needs PIXABAY_API_KEY (free, instant at
 * pixabay.com/api/docs). Pixabay's Content License allows use in projects
 * without attribution; the creator is credited anyway, and the source and
 * licence travel with the imported MediaAsset.
 */

export const STOCK_LICENSE = "Pixabay Content License";

export type StockVideo = {
  id: number;
  /** Poster frame. */
  image: string;
  durationMs: number;
  width: number;
  height: number;
  /** The page on Pixabay, for the credit line. */
  url: string;
  creator: string;
  /** The MP4 to import: the smallest rendition that still fills a 1080-wide frame, else the largest. */
  file: { url: string; width: number; height: number } | null;
};

type PixabayRendition = { url: string; width: number; height: number; size: number; thumbnail: string };
type PixabayHit = {
  id: number;
  pageURL: string;
  duration: number;
  user: string;
  videos: { large?: PixabayRendition; medium?: PixabayRendition; small?: PixabayRendition; tiny?: PixabayRendition };
};

export function isStockConfigured(): boolean {
  return Boolean(process.env.PIXABAY_API_KEY);
}

function pickFile(hit: PixabayHit): StockVideo["file"] {
  const renditions = Object.values(hit.videos).filter((r): r is PixabayRendition => !!r && !!r.url && r.width > 0 && r.height > 0);
  const sorted = [...renditions].sort((a, b) => a.width * a.height - b.width * b.height);
  const good = sorted.find((r) => Math.min(r.width, r.height) >= 1080) ?? sorted[sorted.length - 1];
  return good ? { url: good.url, width: good.width, height: good.height } : null;
}

function toStock(hit: PixabayHit): StockVideo {
  const file = pickFile(hit);
  const poster = hit.videos.medium?.thumbnail ?? hit.videos.small?.thumbnail ?? hit.videos.large?.thumbnail ?? hit.videos.tiny?.thumbnail ?? "";
  return {
    id: hit.id,
    image: poster,
    durationMs: Math.round(hit.duration * 1000),
    width: file?.width ?? 0,
    height: file?.height ?? 0,
    url: hit.pageURL,
    creator: hit.user,
    file,
  };
}

// Pixabay asks for results to be cached for 24 hours and allows about 100
// requests a minute per key; one cache per web instance keeps repeat searches
// (every venue reel starts from a handful of queries) off the API.
const DAY_MS = 24 * 3600_000;
const cache = new Map<string, { at: number; result: Promise<{ hits: PixabayHit[] }> }>();

async function pixabay(query: Record<string, string>): Promise<{ hits: PixabayHit[] }> {
  const key = JSON.stringify(query);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.result;
  if (cache.size >= 500) cache.delete(cache.keys().next().value!);
  const result = fetchPixabay(query);
  cache.set(key, { at: Date.now(), result });
  // A failed request is not worth remembering.
  result.catch(() => cache.delete(key));
  return result;
}

async function fetchPixabay(query: Record<string, string>): Promise<{ hits: PixabayHit[] }> {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) throw new Error("Stock search is not set up: PIXABAY_API_KEY is missing.");
  const url = new URL("https://pixabay.com/api/videos/");
  url.searchParams.set("key", key);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Pixabay answered ${response.status}.`);
  return (await response.json()) as { hits: PixabayHit[] };
}

export async function searchStock(query: string, perPage = 24): Promise<StockVideo[]> {
  const result = await pixabay({ q: query.trim(), per_page: String(perPage), safesearch: "true", video_type: "film" });
  return result.hits.map(toStock).filter((video) => video.file !== null);
}

export async function getStock(id: number): Promise<StockVideo> {
  const result = await pixabay({ id: String(id) });
  const hit = result.hits[0];
  if (!hit) throw new Error("That clip is no longer available.");
  return toStock(hit);
}

/** The credit line for a clip, kept on the asset and offered for the caption. */
export function stockCredit(video: StockVideo): string {
  return `Video by ${video.creator} on Pixabay`;
}
