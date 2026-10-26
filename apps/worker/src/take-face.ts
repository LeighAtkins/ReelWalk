import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { trackFace, type FaceSample } from "@reelwalk/core";
import { run } from "./library/tools";

/**
 * Where the presenter's face goes through a finished take (ADR 0089 round 3), so keyword lockups follow her head when
 * she walks or the take drifts. Seeded with the identity gate's box on the composed first frame, which Veo starts from;
 * followed with the surface tracker on small grey frames. Stored with the gate's record as `{ end: "track", ... }`.
 */

/** Frames per second the face is tracked at, and the size they are decoded to (a third of 1080×1920 each way). */
export const FACE_TRACK_FPS = 10;
const TRACK_WIDTH = 360, TRACK_HEIGHT = 640;

/** The record stored in `identityChecks`. */
export type FaceTrackRecord = { end: "track"; fps: number; seed: number[]; samples: FaceSample[] };

/**
 * The box to start from: the newest first-frame check's last usable locate attempt, its `refined` box when the gate
 * looked again (grid [ymin, xmin, ymax, xmax] on 0–1000). Null when the gate left none.
 */
export function seedBoxFromChecks(checks: unknown): number[] | null {
  if (!Array.isArray(checks)) return null;
  const valid = (box: unknown): box is number[] => Array.isArray(box) && box.length === 4 && box.every((n) => typeof n === "number" && Number.isFinite(n)) && box[2] > box[0] && box[3] > box[1];
  for (const check of [...checks].reverse()) {
    if (!check || typeof check !== "object" || (check as { end?: unknown }).end !== "first") continue;
    const attempts = Array.isArray((check as { locate?: unknown }).locate) ? (check as { locate: Record<string, unknown>[] }).locate : [];
    for (const attempt of [...attempts].reverse()) {
      if (attempt.rejected !== undefined && attempt.rejected !== "face-too-small") continue;
      if (valid(attempt.refined)) return attempt.refined;
      if (valid(attempt.box)) return attempt.box;
    }
  }
  return null;
}

/** The face track of a take, or null when there is no seed or the tracker could not follow her. Never throws. */
export async function faceTrackOfTake(video: Buffer, checks: unknown, id: string): Promise<FaceTrackRecord | null> {
  const seed = seedBoxFromChecks(checks);
  if (!seed) return null;
  const workdir = await mkdtemp(path.join(os.tmpdir(), `face-${id}-`));
  try {
    const file = path.join(workdir, "take.mp4");
    await writeFile(file, video);
    const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-vf", `fps=${FACE_TRACK_FPS},scale=${TRACK_WIDTH}:${TRACK_HEIGHT}`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
      { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeoutMs: 60_000 });
    const size = TRACK_WIDTH * TRACK_HEIGHT, count = Math.floor(stdout.length / size);
    const frames = Array.from({ length: count }, (_, i) => ({ width: TRACK_WIDTH, height: TRACK_HEIGHT, data: Float32Array.from(stdout.subarray(i * size, (i + 1) * size)) }));
    const [ymin, xmin, ymax, xmax] = seed.map((v) => v / 1000);
    const samples = trackFace(frames, frames.map((_, i) => (i * 1000) / FACE_TRACK_FPS), { x0: xmin, y0: ymin, x1: xmax, y1: ymax });
    if (!samples) console.log(`ai-video: ${id}: face track: the tracker could not follow her face`);
    return samples ? { end: "track", fps: FACE_TRACK_FPS, seed, samples } : null;
  } catch (error) {
    console.warn(`ai-video: ${id}: face track not made: ${error instanceof Error ? error.message : error}`);
    return null;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
