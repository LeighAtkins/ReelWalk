import { pickMatchingFrame, smoothKeyframes, trackPatch, type Clip, type Gray, type Quad, type TextOverlay } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";

/** Browser side of @reelwalk/core's motion module: small grayscale frames from a video element. */

export const ANALYSIS_WIDTH = 48;
export const ANALYSIS_HEIGHT = 85;

let scratch: HTMLCanvasElement | null = null;

/** The video's current frame as luminance at the analysis size. */
export function grayFrame(video: HTMLVideoElement, width = ANALYSIS_WIDTH, height = ANALYSIS_HEIGHT): Gray {
  scratch ??= document.createElement("canvas");
  scratch.width = width; scratch.height = height;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Frame analysis is unavailable in this browser.");
  ctx.drawImage(video, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return { data: gray, width, height };
}

function seek(video: HTMLVideoElement, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("The video could not be read.")); }, 15_000);
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("The video could not be read.")); };
    const cleanup = () => { clearTimeout(timer); video.removeEventListener("seeked", done); video.removeEventListener("error", failed); };
    video.addEventListener("seeked", done, { once: true }); video.addEventListener("error", failed, { once: true });
    video.currentTime = ms / 1000;
  });
}

async function load(asset: LibraryAsset): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous"; video.preload = "auto"; video.muted = true;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${asset.fileName} could not be read.`)), 20_000);
    video.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
    video.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`${asset.fileName} could not be read.`)); }, { once: true });
    video.src = asset.url; video.load();
  });
  return video;
}

// A third of 1080×1920: fine enough that a sub-pixel match is under two output pixels.
export const TRACK_WIDTH = 360;
export const TRACK_HEIGHT = 640;

/**
 * Pin a text to the picture (ADR 0039): follow the surface under it through
 * the clip it starts on and return a path of position, scale and rotation
 * keyframes over the text's lifetime. Two patches either side of the text's
 * centre are tracked; their midpoint moves the text, their distance scales
 * it and their angle rotates it. When a patch is lost the path holds.
 */
export async function trackTextPath(
  asset: LibraryAsset, clip: Clip, clipStartMs: number, text: Pick<TextOverlay, "x" | "y" | "startMs" | "endMs">,
  onProgress?: (fraction: number) => void,
): Promise<{ path: NonNullable<TextOverlay["path"]>; pin: NonNullable<TextOverlay["pin"]> } | null> {
  const speed = clip.speed || 1;
  const lifeMs = text.endMs - text.startMs;
  const firstSource = clip.sourceStartMs + Math.max(0, text.startMs - clipStartMs) * speed;
  const lastSource = Math.min(clip.sourceEndMs, clip.sourceStartMs + Math.max(0, text.endMs - clipStartMs) * speed);
  if (lastSource - firstSource < 200 || lifeMs <= 0) return null;
  const stepMs = Math.max(100, (lastSource - firstSource) / 60);
  let video: HTMLVideoElement | null = null;
  try {
    video = await load(asset);
    await seek(video, firstSource);
    let prev = grayFrame(video, TRACK_WIDTH, TRACK_HEIGHT);
    const radius = Math.round(TRACK_WIDTH * 0.045), range = Math.round(TRACK_WIDTH * 0.06);
    const centre = { x: text.x * TRACK_WIDTH, y: text.y * TRACK_HEIGHT };
    // Four corners of a plane around the text, kept inside the frame with room for a patch.
    const hw = TRACK_WIDTH * 0.2, hh = TRACK_HEIGHT * 0.075, margin = radius + 1;
    const cx = Math.max(margin + hw, Math.min(TRACK_WIDTH - 1 - margin - hw, centre.x)), cy = Math.max(margin + hh, Math.min(TRACK_HEIGHT - 1 - margin - hh, centre.y));
    let corners = [{ x: cx - hw, y: cy - hh }, { x: cx + hw, y: cy - hh }, { x: cx + hw, y: cy + hh }, { x: cx - hw, y: cy + hh }];
    const quad0 = corners.flatMap(c => [c.x / TRACK_WIDTH, c.y / TRACK_HEIGHT]) as Quad;
    const left0 = corners[0], right0 = corners[1];
    const baseDistance = Math.hypot(right0.x - left0.x, right0.y - left0.y) || 1;
    const baseAngle = Math.atan2(right0.y - left0.y, right0.x - left0.x);
    const path: NonNullable<TextOverlay["path"]> = [{ t: 0, x: 0, y: 0, s: 1, r: 0, q: quad0 }];
    let held = false;
    for (let source = firstSource + stepMs; source <= lastSource + 1; source += stepMs) {
      const at = Math.min(source, lastSource);
      await seek(video, at);
      const next = grayFrame(video, TRACK_WIDTH, TRACK_HEIGHT);
      const t = Math.min(1, (at - firstSource) / (lastSource - firstSource));
      if (!held) {
        const tracked = corners.map(c => trackPatch(prev, next, c.x, c.y, { radius, range }));
        const good = tracked.filter(c => !c.lost);
        if (good.length < 2) held = true;
        else {
          // A lost corner rides along with the mean move of the good ones, so a hand or a doorway crossing it does not bend the plane.
          const moves = tracked.flatMap((c, i) => c.lost ? [] : [{ x: c.x - corners[i].x, y: c.y - corners[i].y }]);
          const mean = { x: moves.reduce((s, m) => s + m.x, 0) / moves.length, y: moves.reduce((s, m) => s + m.y, 0) / moves.length };
          corners = corners.map((c, i) => tracked[i].lost ? { x: c.x + mean.x, y: c.y + mean.y } : { x: tracked[i].x, y: tracked[i].y });
        }
      }
      const [tl, tr, br, bl] = corners;
      const mid = { x: (tl.x + tr.x + br.x + bl.x) / 4, y: (tl.y + tr.y + br.y + bl.y) / 4 };
      const distance = Math.hypot(tr.x - tl.x, tr.y - tl.y) || 1;
      const angle = Math.atan2(tr.y - tl.y, tr.x - tl.x);
      path.push({
        t: Number(t.toFixed(4)),
        x: Number(Math.max(-0.5, Math.min(0.5, mid.x / TRACK_WIDTH - text.x)).toFixed(4)),
        y: Number(Math.max(-0.5, Math.min(0.5, mid.y / TRACK_HEIGHT - text.y)).toFixed(4)),
        s: Number(Math.max(0.2, Math.min(5, distance / baseDistance)).toFixed(3)),
        r: Number(Math.max(-180, Math.min(180, ((angle - baseAngle) * 180) / Math.PI)).toFixed(2)),
        q: corners.flatMap(c => [Number(Math.max(-2, Math.min(3, c.x / TRACK_WIDTH)).toFixed(4)), Number(Math.max(-2, Math.min(3, c.y / TRACK_HEIGHT)).toFixed(4))]) as Quad,
      });
      prev = next;
      onProgress?.((at - firstSource) / (lastSource - firstSource));
      if (path.length >= 63) break;
    }
    // The path must end at t = 1; the last sample holds to the end of the text's life.
    const last = path[path.length - 1];
    if (last.t < 1) path.push({ ...last, t: 1 });
    else last.t = 1;
    // Strictly increasing t, no duplicates.
    const clean = smoothKeyframes(path.filter((p, i) => i === 0 || p.t > path[i - 1].t));
    return clean.length >= 2 ? { path: clean, pin: { assetId: asset.id, fromMs: Math.round(firstSource), toMs: Math.round(lastSource), quad: quad0 } } : null;
  } catch {
    return null;
  } finally {
    if (video) { video.removeAttribute("src"); video.load(); }
  }
}

/**
 * Where to end `from` so it cuts cleanly into `to`: the frame in the last
 * `windowMs` of `from`'s played window that most resembles `to`'s first
 * played frame. Returns the source end time in ms, and whether it is a
 * close match. Null when either video cannot be read.
 */
export async function findMatchingCut(
  from: { asset: LibraryAsset; sourceStartMs: number; sourceEndMs: number },
  to: { asset: LibraryAsset; sourceStartMs: number },
  { windowMs = 1500, stepMs = 1000 / 24 }: { windowMs?: number; stepMs?: number } = {},
): Promise<{ sourceEndMs: number; close: boolean } | null> {
  let a: HTMLVideoElement | null = null, b: HTMLVideoElement | null = null;
  try {
    [a, b] = await Promise.all([load(from.asset), load(to.asset)]);
    await seek(b, Math.min(to.sourceStartMs, b.duration * 1000 - 40));
    const target = grayFrame(b);
    const last = Math.min(from.sourceEndMs, a.duration * 1000 - 40);
    const first = Math.max(from.sourceStartMs + 300, last - windowMs);
    const candidates: { t: number; gray: Gray }[] = [];
    for (let t = first; t <= last; t += stepMs) {
      await seek(a, t);
      candidates.push({ t: Math.round(t), gray: grayFrame(a) });
    }
    const pick = pickMatchingFrame(candidates, target);
    return pick ? { sourceEndMs: pick.t, close: pick.close } : null;
  } catch {
    return null;
  } finally {
    for (const video of [a, b]) if (video) { video.removeAttribute("src"); video.load(); }
  }
}
