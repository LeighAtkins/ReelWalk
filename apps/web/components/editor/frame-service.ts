import { clipMomentAtSource, framePlan, midFrameMs, type Clip, type ClipMoment, type Timeline } from "@reelwalk/core";
import { FILTER_CSS } from "@reelwalk/render/reel";
import { drawClipFrame } from "./frame-draw";

/**
 * Frames as the composition shows them (ADR 0047). Analysis (surface
 * detection, tracking) and the loupe read pixels from here, drawn through the
 * clip's fit, zoom and camera move at that moment, so a composition fraction
 * means the same pixel to the detector, the loupe, the handles and the
 * render. Replaces reading the first <video> found in the stage's DOM and
 * stretching the whole source over the analysis canvas.
 */

/** A clip instance and the media it plays. `durationInFrames` is its length on the frame plan, for the camera move's progress. */
export type FrameClip = { clip: Clip; media: { src: string; kind: string }; durationInFrames?: number };

/** Composition-sized canvas for the loupe; analysis asks for its own smaller sizes. */
export const FRAME_WIDTH = 1080, FRAME_HEIGHT = 1920;

/** "view" is what the viewer sees (the loupe); "analysis" is the picture alone on flat grey (frame-draw.ts). */
export type FramePurpose = "view" | "analysis";

type Drawable = HTMLVideoElement | HTMLImageElement;

// Duck-typed rather than instanceof, so stand-in videos in tests (no DOM classes) are sized too.
const sizeOf = (media: Drawable) => ("videoWidth" in media ? { width: media.videoWidth, height: media.videoHeight } : { width: media.naturalWidth, height: media.naturalHeight });

/** Draws `media` at its current frame as the composition shows `clip` at `moment`, for viewing or for analysis. */
export function drawPresented(ctx: CanvasRenderingContext2D, media: Drawable, clip: Pick<Clip, "fit" | "zoom" | "motion" | "camera" | "filter">, moment: ClipMoment, width: number, height: number, purpose: FramePurpose): void {
  drawClipFrame(ctx, media, sizeOf(media), clip, moment, width, height,
    purpose === "analysis" ? { kind: "analysis" } : { kind: "view", grade: FILTER_CSS[clip.filter] ?? "", canFilter: typeof ctx.filter === "string" });
}

// ── Media elements ──────────────────────────────────────────────

/** Seeks a video and resolves once the frame at `ms` is decoded. */
export function seekVideo(video: HTMLVideoElement, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("The video could not be read.")); }, 15_000);
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("The video could not be read.")); };
    const cleanup = () => { clearTimeout(timer); video.removeEventListener("seeked", done); video.removeEventListener("error", failed); };
    video.addEventListener("seeked", done, { once: true }); video.addEventListener("error", failed, { once: true });
    video.currentTime = ms / 1000;
  });
}

/** A detached, muted video of `src`, resolved when its first frame is ready. */
export function loadVideo(src: string, label = "The video"): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous"; video.preload = "auto"; video.muted = true; video.playsInline = true;
  return new Promise<HTMLVideoElement>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} could not be read.`)), 20_000);
    video.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(video); }, { once: true });
    video.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`${label} could not be read.`)); }, { once: true });
    video.src = src; video.load();
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  return new Promise((resolve, reject) => {
    // Like a video's load: a photo that never arrives must not hold its source's queue forever.
    const timer = setTimeout(() => { image.onload = image.onerror = null; image.src = ""; reject(new Error("The photo could not be read.")); }, 20_000);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(new Error("The photo could not be read.")); };
    image.src = src;
  });
}

/** Frees a detached video's decoder and buffer. */
export function releaseVideo(video: HTMLVideoElement): void {
  video.removeAttribute("src"); video.load();
}

// ── The service ─────────────────────────────────────────────────

/** Two sources open, four frames kept: about 33 MB at composition size, as much as a phone should give this. */
const MAX_MEDIA = 2, MAX_FRAMES = 4;

type MediaEntry = { media: Promise<Drawable>; queue: Promise<unknown>; latest: Map<string, number> };
type FrameEntry = { promise: Promise<HTMLCanvasElement | null>; canvas: HTMLCanvasElement | null };

export type FrameRequest = {
  width?: number;
  height?: number;
  purpose?: FramePurpose;
  /**
   * Latest wins within a channel: a request on the same source and channel
   * made after this one drops it before it seeks (resolving null), so
   * scrubbing with the loupe never queues a backlog of stale seeks. Analysis
   * passes none and is never dropped.
   */
  channel?: string;
};

/** Frees a canvas's backing store now (iOS caps total canvas memory and frees it lazily). */
const freeCanvas = (canvas: HTMLCanvasElement | null) => { if (canvas) { canvas.width = 0; canvas.height = 0; } };

let tickets = 0;

export class FrameService {
  private media = new Map<string, MediaEntry>();
  private frames = new Map<string, FrameEntry>();

  /** What a frame depends on: the clip instance, everything about how it is presented, the seek time, size and purpose. */
  private key(target: FrameClip, seekMs: number, width: number, height: number, purpose: FramePurpose): string {
    const c = target.clip;
    return [c.id, target.media.src, c.sourceStartMs, c.sourceEndMs, c.speed, c.fit, c.zoom, c.motion, c.filter, target.durationInFrames ?? "", seekMs.toFixed(2), width, height, purpose].join("|");
  }

  /**
   * The composition's picture of `target` at `sourceMs` of its source; null
   * for a 360 photo (not a flat picture), unreadable media, or a request
   * superseded in its channel. The video is seeked to the middle of the
   * frame `sourceMs` falls in, so it cannot land on the frame before.
   */
  frameAt(target: FrameClip, sourceMs: number, request: FrameRequest = {}): Promise<HTMLCanvasElement | null> {
    const { width = FRAME_WIDTH, height = FRAME_HEIGHT, purpose = "view", channel } = request;
    const seekMs = target.media.kind === "VIDEO" ? midFrameMs(sourceMs) : 0;
    const key = this.key(target, seekMs, width, height, purpose);
    const hit = this.frames.get(key);
    if (hit) {
      this.frames.delete(key); this.frames.set(key, hit);
      if (channel) this.media.get(target.media.src)?.latest.set(channel, -1);
      return hit.promise;
    }
    const entry: FrameEntry = { promise: Promise.resolve(null), canvas: null };
    entry.promise = this.draw(target, seekMs, width, height, purpose, channel).then((canvas) => {
      entry.canvas = canvas;
      if (!canvas && this.frames.get(key) === entry) this.frames.delete(key);
      return canvas;
    });
    this.frames.set(key, entry);
    while (this.frames.size > MAX_FRAMES) {
      const [oldest, old] = this.frames.entries().next().value!;
      this.frames.delete(oldest);
      freeCanvas(old.canvas);
    }
    return entry.promise;
  }

  /** Frees every source and frame. */
  dispose(): void {
    for (const entry of this.media.values()) entry.media.then((m) => { if (m instanceof HTMLVideoElement) releaseVideo(m); }).catch(() => undefined);
    for (const entry of this.frames.values()) freeCanvas(entry.canvas);
    this.media.clear(); this.frames.clear();
  }

  private open(src: string, kind: string): MediaEntry {
    const held = this.media.get(src);
    if (held) { this.media.delete(src); this.media.set(src, held); return held; }
    const entry: MediaEntry = { media: kind === "IMAGE" ? loadImage(src) : loadVideo(src), queue: Promise.resolve(), latest: new Map() };
    entry.media.catch(() => this.media.delete(src));
    this.media.set(src, entry);
    while (this.media.size > MAX_MEDIA) {
      const [oldest, old] = this.media.entries().next().value!;
      this.media.delete(oldest);
      // Let any read in flight finish before freeing it.
      old.queue.finally(() => old.media.then((m) => { if (m instanceof HTMLVideoElement) releaseVideo(m); }).catch(() => undefined));
    }
    return entry;
  }

  private draw(target: FrameClip, seekMs: number, width: number, height: number, purpose: FramePurpose, channel: string | undefined): Promise<HTMLCanvasElement | null> {
    // Only a 360 photo is drawn as a panorama by the composition; a 360 video plays as a flat picture.
    if ((target.clip.pano && target.media.kind === "IMAGE") || (target.media.kind !== "VIDEO" && target.media.kind !== "IMAGE")) return Promise.resolve(null);
    const entry = this.open(target.media.src, target.media.kind);
    const ticket = ++tickets;
    if (channel) entry.latest.set(channel, ticket);
    // One seek at a time per source: reads queue behind each other, and a superseded one is skipped before it seeks.
    const run = entry.queue.then(async () => {
      if (channel && entry.latest.get(channel) !== ticket) return null;
      const media = await entry.media;
      if (media instanceof HTMLVideoElement) await seekVideo(media, Math.max(0, Math.min(seekMs, media.duration * 1000 - 20)));
      if (channel && entry.latest.get(channel) !== ticket) return null;
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      // Analysis reads its pixels back; the loupe only draws from it, which is faster on the GPU.
      const ctx = canvas.getContext("2d", purpose === "analysis" ? { willReadFrequently: true } : undefined);
      if (!ctx) return null;
      drawPresented(ctx, media, target.clip, clipMomentAtSource(target.clip, seekMs, undefined, target.durationInFrames), width, height, purpose);
      return canvas;
    }).catch(() => null);
    entry.queue = run;
    return run;
  }
}

/** The editor's one frame service: analysis and the loupe share its sources and frames. */
export const frameService = new FrameService();

/** A canvas's pixels as luminance, for the analysis in @reelwalk/core's motion and surface modules. */
export function luminance(canvas: HTMLCanvasElement): { data: Float32Array; width: number; height: number } {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Frame analysis is unavailable in this browser.");
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return { data: gray, width, height };
}

/**
 * `frameAt(clipId, sourceMs)` for the clips of one timeline: the clip
 * instance is looked up by id with its media and its length on the frame
 * plan, so the camera move's progress matches the composition's.
 */
export function timelineFrames(timeline: Timeline, assets: Record<string, { src: string; kind: string }>, service: FrameService = frameService) {
  const plan = framePlan(timeline);
  const target = (clipId: string): FrameClip | null => {
    const index = timeline.clips.findIndex((clip) => clip.id === clipId);
    if (index < 0) return null;
    const clip = timeline.clips[index], media = assets[clip.assetId];
    return media ? { clip, media, durationInFrames: plan.clips[index].durationInFrames } : null;
  };
  return {
    target,
    frameAt(clipId: string, sourceMs: number, request?: FrameRequest): Promise<HTMLCanvasElement | null> {
      const t = target(clipId);
      return t ? service.frameAt(t, sourceMs, request) : Promise.resolve(null);
    },
  };
}
