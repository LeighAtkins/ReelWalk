import { clipMomentAtSource, clipPicture, framePlan, pictureCanvasTransform, pictureRects, type Clip, type ClipMoment, type Timeline } from "@reelwalk/core";
import { FILTER_CSS } from "@reelwalk/render/reel";

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

type Drawable = HTMLVideoElement | HTMLImageElement;

const sizeOf = (media: Drawable) => (media instanceof HTMLVideoElement ? { width: media.videoWidth, height: media.videoHeight } : { width: media.naturalWidth, height: media.naturalHeight });

const filterSupported = (ctx: CanvasRenderingContext2D) => typeof ctx.filter === "string";

/**
 * Draws `media` at its current frame into `ctx` (a `width`×`height` canvas of
 * the composition) the way ReelComposition's ClipView shows `clip` at
 * `moment`: under Fit (contain) the blurred, enlarged backdrop first, then
 * the picture through its fit and its zoom/move transform, with the clip's
 * colour filter. Whips and fades are transitions and are not drawn.
 */
export function drawPresented(ctx: CanvasRenderingContext2D, media: Drawable, clip: Pick<Clip, "fit" | "zoom" | "motion" | "filter">, moment: ClipMoment, width: number, height: number): void {
  const source = sizeOf(media);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  if (!source.width || !source.height) return;
  const grade = FILTER_CSS[clip.filter] ?? "";
  const k = width / FRAME_WIDTH;
  const canFilter = filterSupported(ctx);
  if (clip.fit === "contain" && canFilter) {
    // ClipView: <AbsoluteFill style="filter: blur(48px) brightness(0.7); transform: scale(1.25)"> with the picture covering it.
    const cover = pictureRects(clipPicture({ fit: "cover", zoom: 1, motion: "none" }, source, moment));
    ctx.save();
    ctx.filter = `${grade} blur(${48 * k}px) brightness(0.7)`.trim();
    ctx.setTransform(1.25, 0, 0, 1.25, width / 2 - 1.25 * (width / 2), height / 2 - 1.25 * (height / 2));
    ctx.drawImage(media, cover.sx, cover.sy, cover.sw, cover.sh, cover.dx * k, cover.dy * k, cover.dw * k, cover.dh * k);
    ctx.restore();
  }
  const picture = clipPicture(clip, source, moment);
  const r = pictureRects(picture);
  ctx.save();
  if (canFilter && grade) ctx.filter = grade;
  ctx.setTransform(...pictureCanvasTransform(picture, width, height));
  ctx.drawImage(media, r.sx, r.sy, r.sw, r.sh, r.dx * k, r.dy * k, r.dw * k, r.dh * k);
  ctx.restore();
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

function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The photo could not be read."));
    image.src = src;
  });
}

/** Frees a detached video's decoder and buffer. */
export function releaseVideo(video: HTMLVideoElement): void {
  video.removeAttribute("src"); video.load();
}

// ── The service ─────────────────────────────────────────────────

/** Two sources open at a time, six frames kept: about 50 MB at composition size, the most a phone should hold for this. */
const MAX_MEDIA = 2, MAX_FRAMES = 6;

type MediaEntry = { media: Promise<Drawable>; queue: Promise<unknown> };

/** What a frame depends on besides the source time: the clip instance and everything about how it is presented. */
function frameKey(target: FrameClip, sourceMs: number, width: number, height: number): string {
  const c = target.clip;
  return [c.id, target.media.src, c.sourceStartMs, c.sourceEndMs, c.speed, c.fit, c.zoom, c.motion, c.filter, target.durationInFrames ?? "", Math.round(sourceMs), width, height].join("|");
}

export class FrameService {
  private media = new Map<string, MediaEntry>();
  private frames = new Map<string, { promise: Promise<HTMLCanvasElement | null>; canvas: HTMLCanvasElement | null }>();

  /**
   * The composition's picture of `target` at `sourceMs` of its source,
   * `width`×`height`; null for a 360 clip (not a flat picture) or media that
   * cannot be read. Cached by clip instance, presentation and time.
   */
  frameAt(target: FrameClip, sourceMs: number, width = FRAME_WIDTH, height = FRAME_HEIGHT): Promise<HTMLCanvasElement | null> {
    const key = frameKey(target, sourceMs, width, height);
    const hit = this.frames.get(key);
    if (hit) {
      this.frames.delete(key); this.frames.set(key, hit);
      return hit.promise;
    }
    const entry: { promise: Promise<HTMLCanvasElement | null>; canvas: HTMLCanvasElement | null } = { promise: Promise.resolve(null), canvas: null };
    entry.promise = this.draw(target, sourceMs, width, height).then((canvas) => { entry.canvas = canvas; if (!canvas) this.frames.delete(key); return canvas; });
    this.frames.set(key, entry);
    while (this.frames.size > MAX_FRAMES) this.frames.delete(this.frames.keys().next().value!);
    return entry.promise;
  }

  /** The frame if it is already drawn, without waiting (for drawing on every pointer move). */
  peek(target: FrameClip, sourceMs: number, width = FRAME_WIDTH, height = FRAME_HEIGHT): HTMLCanvasElement | null {
    return this.frames.get(frameKey(target, sourceMs, width, height))?.canvas ?? null;
  }

  /** Frees every source and frame. */
  dispose(): void {
    for (const entry of this.media.values()) entry.media.then((m) => { if (m instanceof HTMLVideoElement) releaseVideo(m); }).catch(() => undefined);
    this.media.clear(); this.frames.clear();
  }

  private open(src: string, kind: string): MediaEntry {
    const held = this.media.get(src);
    if (held) { this.media.delete(src); this.media.set(src, held); return held; }
    const entry: MediaEntry = { media: kind === "IMAGE" ? loadImage(src) : loadVideo(src), queue: Promise.resolve() };
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

  private draw(target: FrameClip, sourceMs: number, width: number, height: number): Promise<HTMLCanvasElement | null> {
    if (target.clip.pano || (target.media.kind !== "VIDEO" && target.media.kind !== "IMAGE")) return Promise.resolve(null);
    const entry = this.open(target.media.src, target.media.kind);
    // One seek at a time per source: reads queue behind each other.
    const run = entry.queue.then(async () => {
      const media = await entry.media;
      if (media instanceof HTMLVideoElement) await seekVideo(media, Math.max(0, Math.min(sourceMs, media.duration * 1000 - 40)));
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      drawPresented(ctx, media, target.clip, clipMomentAtSource(target.clip, sourceMs, undefined, target.durationInFrames), width, height);
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
    frameAt(clipId: string, sourceMs: number, width = FRAME_WIDTH, height = FRAME_HEIGHT): Promise<HTMLCanvasElement | null> {
      const t = target(clipId);
      return t ? service.frameAt(t, sourceMs, width, height) : Promise.resolve(null);
    },
    peek(clipId: string, sourceMs: number, width = FRAME_WIDTH, height = FRAME_HEIGHT): HTMLCanvasElement | null {
      const t = target(clipId);
      return t ? service.peek(t, sourceMs, width, height) : null;
    },
  };
}
