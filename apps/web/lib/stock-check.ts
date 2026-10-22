import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { StockChecks } from "@reelwalk/core";
import { isAiConfigured, structuredAnswer } from "@/lib/openai";
import type { StockHit } from "@/lib/stock";

const run = promisify(execFile);

/**
 * Frame checks for stock clips (ADR 0070): does the clip show people, does it
 * carry burnt-in text or a watermark, and what place is it. The same vision
 * path the identity gate and the room labels use (`structuredAnswer` with
 * pictures) looks at up to three frames: the poster, and two more when an
 * ffmpeg is available to decode the smallest rendition (`FFMPEG` or `ffmpeg`
 * on PATH; the web image has none, so there the poster alone is checked and
 * `framesChecked` says so). Without a model the checks come back null and the
 * tags decide (`passesStockFilters`).
 *
 * Answers are kept for a day per clip, like the search results, so paging
 * through a search does not re-check a clip.
 */
const DAY_MS = 24 * 3600_000;
const cache = new Map<string, { at: number; result: Promise<StockChecks> }>();

export const UNCHECKED: StockChecks = { people: null, text: null, place: null, framesChecked: 0 };

/** Where in the clip the extra frames are read, as fractions of its length. */
export const SAMPLE_POINTS = [0.15, 0.5, 0.85] as const;

const CHECK_INSTRUCTIONS = [
  "You check stock video frames for a property and venue reel editor.",
  "You see one to three frames of one clip. Answer about the whole clip.",
  "people: true if any frame shows a person or part of one (face, body, hands, silhouette). Reflections and statues count as false.",
  "text_or_watermark: true if any frame carries lettering, a logo, a stock-site watermark, a timestamp or subtitles burnt into the picture. Signs that are part of the scene (a shop sign in the street) count as false.",
  "place: the place in at most six words, like 'white kitchen, marble island' or 'villa pool at sunset'.",
].join("\n");

const CHECK_SCHEMA = {
  type: "object",
  properties: { people: { type: "boolean" }, text_or_watermark: { type: "boolean" }, place: { type: "string" } },
  required: ["people", "text_or_watermark", "place"],
  additionalProperties: false,
};

export function checkStockClip(clip: StockHit): Promise<StockChecks> {
  const key = `${clip.source}:${clip.id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.result;
  if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
  const result = check(clip).catch(() => UNCHECKED);
  cache.set(key, { at: Date.now(), result });
  return result;
}

/** Checks the first `limit` clips, a few at a time, and returns them with their checks attached. */
export async function checkStockClips<T extends StockHit>(clips: T[], limit: number, concurrency = 4): Promise<T[]> {
  const out = [...clips];
  let next = 0;
  const upto = Math.min(limit, clips.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, upto) }, async () => {
    while (next < upto) {
      const at = next++;
      out[at] = { ...out[at], checks: await checkStockClip(out[at]) };
    }
  }));
  return out;
}

async function check(clip: StockHit): Promise<StockChecks> {
  if (!isAiConfigured()) return UNCHECKED;
  const frames = await sampleFrames(clip);
  if (frames.length === 0) return UNCHECKED;
  const { json } = await structuredAnswer({
    instructions: CHECK_INSTRUCTIONS,
    input: `Clip tags: ${clip.tags.join(", ") || "(none)"}. ${frames.length} frame(s) follow.`,
    images: frames,
    schemaName: "stock_frame_check",
    schema: CHECK_SCHEMA,
    maxOutputTokens: 120,
  });
  const answer = json as { people?: unknown; text_or_watermark?: unknown; place?: unknown };
  return {
    people: typeof answer.people === "boolean" ? answer.people : null,
    text: typeof answer.text_or_watermark === "boolean" ? answer.text_or_watermark : null,
    place: typeof answer.place === "string" && answer.place.trim() ? answer.place.trim().slice(0, 60) : null,
    framesChecked: frames.length,
  };
}

/** The poster, plus frames decoded from the smallest rendition when ffmpeg is here; as small JPEG data URLs. */
async function sampleFrames(clip: StockHit): Promise<string[]> {
  const frames: string[] = [];
  const poster = await fetchBytes(clip.poster, 4 * 1024 * 1024).catch(() => null);
  if (poster) frames.push(await toDataUrl(poster));
  if (clip.sample && (await ffmpegAvailable())) {
    const extracted = await extractFrames(clip.sample, clip.durationMs).catch(() => []);
    for (const frame of extracted) frames.push(await toDataUrl(frame));
    // The poster is usually one of the sampled moments; keep three distinct frames at most.
    return frames.slice(-3);
  }
  return frames;
}

async function toDataUrl(bytes: Buffer): Promise<string> {
  const small = await sharp(bytes).resize({ width: 384, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
  return `data:image/jpeg;base64,${small.toString("base64")}`;
}

async function fetchBytes(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Fetch failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("Too large.");
  return bytes;
}

let ffmpegKnown: Promise<boolean> | null = null;
export const ffmpegBin = (): string => process.env.FFMPEG || "ffmpeg";

/** Whether an ffmpeg can be run here; asked once per process. */
export function ffmpegAvailable(): Promise<boolean> {
  ffmpegKnown ??= run(ffmpegBin(), ["-version"]).then(() => true, () => false);
  return ffmpegKnown;
}

/** Frames at SAMPLE_POINTS of the clip, as JPEG buffers, from the smallest rendition in a temp dir that is removed after. */
async function extractFrames(sampleUrl: string, durationMs: number): Promise<Buffer[]> {
  const bytes = await fetchBytes(sampleUrl, 25 * 1024 * 1024);
  const dir = await mkdtemp(path.join(os.tmpdir(), "stock-check-"));
  try {
    const input = path.join(dir, "sample.mp4");
    await writeFile(input, bytes);
    const frames: Buffer[] = [];
    for (const [i, point] of SAMPLE_POINTS.entries()) {
      const at = Math.max(0, (durationMs / 1000) * point);
      const out = path.join(dir, `f${i}.jpg`);
      await run(ffmpegBin(), ["-v", "error", "-y", "-ss", at.toFixed(2), "-i", input, "-frames:v", "1", "-q:v", "4", out]);
      frames.push(await readFile(out));
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
