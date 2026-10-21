/**
 * The end state for mattes (ADR 0051, not wired in yet): immutable mask
 * artifacts made once by the worker, decoding each source sequentially, and
 * Remotion only sampling them. This file fixes the contract (the storage keys,
 * the manifest, the sampler interface and the frame lookup) so the worker
 * side can be built against it. `MATTE_ARTIFACTS_ENABLED` stays false until
 * the producer exists; the components ignore this module meanwhile.
 *
 * Masks live in *source* space, one per decoded source frame, so trims,
 * speed changes, refits and reorders reuse them; the composition maps a
 * frame to a source frame and draws through the clip's fit, as it does for
 * the footage. In that world the person settle term is raw(i) toward
 * raw(i − 1) of the *source* (free in a sequential decode), which is a rule
 * change and so a new MATTE_VERSION.
 */
import { z } from "zod";
import { fnv1a64, MATTE_VERSION } from "./matte-core";

/** Off until the worker produces artifacts; then the views sample instead of segmenting. */
export const MATTE_ARTIFACTS_ENABLED = false;

export const MATTE_ARTIFACT_FORMAT = 1;

/** What a set of masks is of: the person in a source, or the objects under a title's taps. */
export type MatteSubject =
  | { kind: "person" }
  | { kind: "object"; taps: { x: number; y: number }[]; pin: { fromMs: number; quad: number[]; path: number[][] } | null };

/** A stable hash of what the masks depend on beyond the source and the version. */
export function subjectHash(subject: MatteSubject): string {
  if (subject.kind === "person") return "person";
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  const canonical = JSON.stringify({
    taps: subject.taps.map((t) => [round(t.x), round(t.y)]),
    pin: subject.pin ? { fromMs: subject.pin.fromMs, quad: subject.pin.quad.map(round), path: subject.pin.path.map((q) => q.map(round)) } : null,
  });
  return `object-${fnv1a64(canonical)}`;
}

/**
 * Where an artifact lives in the media bucket:
 * `mattes/<source sha256>/<MATTE_VERSION>/<subject>/manifest.json`, with the
 * frames beside it as `frames/<index, 6 digits>.png`. Every part of the key is
 * a content hash or a version, so an artifact is never rewritten: a new model,
 * threshold or tap set is a new key, and old reels keep theirs.
 */
export function matteArtifactPrefix(sourceSha256: string, subject: MatteSubject, version = MATTE_VERSION): string {
  if (!/^[0-9a-f]{64}$/.test(sourceSha256)) throw new Error("a matte artifact is keyed by the source's sha256");
  return `mattes/${sourceSha256}/${version}/${subjectHash(subject)}`;
}

export function matteFrameKey(prefix: string, index: number): string {
  return `${prefix}/frames/${String(index).padStart(6, "0")}.png`;
}

/**
 * manifest.json. Frames are 8-bit grayscale PNGs (alpha 0–255) at the mask
 * size, lossless so every decoder reads the same bytes; `frames[i]` is the
 * sha256 of frame i's PNG, so the sampler can refuse a corrupted file and a
 * re-run can prove it made the same artifact.
 */
export const matteManifestSchema = z.object({
  format: z.literal(MATTE_ARTIFACT_FORMAT),
  matteVersion: z.string().min(1),
  subject: z.string().min(1),
  source: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive(), frameCount: z.number().int().positive() }),
  mask: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  /** Per frame: how it was made. Object masks say whether each tap was tracked or followed the wall. */
  status: z.array(z.string()).optional(),
  frames: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
}).refine((m) => m.frames.length === m.source.frameCount, "one frame hash per source frame");

export type MatteManifest = z.infer<typeof matteManifestSchema>;

/** The source frame on screen at composition frame `n` of a clip: the same clock the footage uses. */
export function sourceFrameIndex(manifest: Pick<MatteManifest, "source">, clip: { sourceStartMs: number; speed?: number }, n: number, fps: number): number {
  const seconds = clip.sourceStartMs / 1000 + (n / fps) * (clip.speed || 1);
  // Half a source frame of tolerance, so a composition frame on a source frame's timestamp gets that frame.
  const index = Math.floor(seconds * manifest.source.fps + 1e-6);
  return Math.max(0, Math.min(manifest.source.frameCount - 1, index));
}

/**
 * What a view needs from an artifact: frame `index`'s mask as something it
 * can draw through the clip's fit. The browser implementation loads the PNG
 * named by `matteFrameKey` and checks its hash against the manifest; it must
 * fail (an export error) rather than draw nothing when either is missing.
 */
export interface MatteSampler {
  readonly manifest: MatteManifest;
  frame(index: number): Promise<CanvasImageSource>;
}

/** A manifest the current code may sample: the same version, or the sampler must refuse it (an old artifact is a different matte). */
export function checkManifest(raw: unknown, expected: { sourceSha256: string; subject: MatteSubject }): MatteManifest {
  const manifest = matteManifestSchema.parse(raw);
  if (manifest.matteVersion !== MATTE_VERSION) throw new Error(`matte artifact is ${manifest.matteVersion}, this renderer draws ${MATTE_VERSION}`);
  if (manifest.source.sha256 !== expected.sourceSha256) throw new Error("matte artifact is for a different source");
  if (manifest.subject !== subjectHash(expected.subject)) throw new Error("matte artifact is for different taps");
  return manifest;
}
