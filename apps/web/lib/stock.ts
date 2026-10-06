/**
 * Free stock footage from Pexels. Needs PEXELS_API_KEY (free, instant at
 * pexels.com/api). Everything imported keeps its source and the Pexels
 * licence on the MediaAsset row, and the photographer is credited.
 */

export const PEXELS_LICENSE = "Pexels License";

export type StockVideo = {
  id: number;
  /** Poster frame. */
  image: string;
  durationMs: number;
  width: number;
  height: number;
  /** The page on Pexels, for the credit line. */
  url: string;
  photographer: string;
  photographerUrl: string;
  /** The MP4 to import: portrait or square where possible, at most 1080 wide. */
  file: { url: string; width: number; height: number } | null;
};

type PexelsVideo = {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string;
  image: string;
  user: { name: string; url: string };
  video_files: { link: string; width: number | null; height: number | null; file_type: string; quality: string | null }[];
};

export function isStockConfigured(): boolean {
  return Boolean(process.env.PEXELS_API_KEY);
}

function pickFile(video: PexelsVideo): StockVideo["file"] {
  const mp4s = video.video_files.filter((file) => file.file_type === "video/mp4" && file.width && file.height);
  // Reels are 1080 wide: the smallest file that still fills the frame, else the biggest there is.
  const sorted = [...mp4s].sort((a, b) => a.width! * a.height! - b.width! * b.height!);
  const good = sorted.find((file) => Math.min(file.width!, file.height!) >= 1080) ?? sorted[sorted.length - 1];
  return good ? { url: good.link, width: good.width!, height: good.height! } : null;
}

function toStock(video: PexelsVideo): StockVideo {
  return {
    id: video.id,
    image: video.image,
    durationMs: Math.round(video.duration * 1000),
    width: video.width,
    height: video.height,
    url: video.url,
    photographer: video.user.name,
    photographerUrl: video.user.url,
    file: pickFile(video),
  };
}

async function pexels<T>(path: string): Promise<T> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error("Stock search is not set up: PEXELS_API_KEY is missing.");
  const response = await fetch(`https://api.pexels.com/videos${path}`, {
    headers: { Authorization: key },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Pexels answered ${response.status}.`);
  return (await response.json()) as T;
}

export async function searchStock(query: string, perPage = 24): Promise<StockVideo[]> {
  const q = encodeURIComponent(query.trim());
  const result = await pexels<{ videos: PexelsVideo[] }>(`/search?query=${q}&orientation=portrait&size=medium&per_page=${perPage}`);
  return result.videos.map(toStock).filter((video) => video.file !== null);
}

export async function getStock(id: number): Promise<StockVideo> {
  return toStock(await pexels<PexelsVideo>(`/videos/${id}`));
}

/** The credit line for a clip, kept on the asset and offered for the caption. */
export function stockCredit(video: StockVideo): string {
  return `Video by ${video.photographer} on Pexels`;
}
