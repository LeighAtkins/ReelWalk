import { findSurfaceQuad, leanQuad, pickMatchingFrame, planePoints, smoothKeyframes, trackPlane, type Clip, type Gray, type Quad, type TextOverlay } from "@reelwalk/core";
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

/** How well a pin followed its surface: what the Pin sheet shows before the user trusts it. */
export type TrackQuality = {
  /** Points with detail found on the surface at the start. */
  points: number;
  /** Mean points agreeing with the plane per step. */
  inliers: number;
  /** Steps refused by the gates (held instead of jumping). */
  held: number;
  /** Steps taken. */
  steps: number;
  /** "good" tracks cleanly; "weak" held often or had few points; "lost" faded before the end. */
  grade: "good" | "weak" | "lost";
};

/**
 * Pin a text to the picture (ADR 0039): follow the surface under it through
 * the clip it starts on and return a path of position, scale, rotation and
 * corner keyframes over the text's lifetime. Many points on the surface are
 * tracked and one rigid homography per step moves the plane, so its corners
 * cannot drift apart. If the surface is lost (it left the frame, or something
 * covered it) the title holds and fades over a quarter of a second instead
 * of cutting.
 */
export async function trackTextPath(
  asset: LibraryAsset, clip: Clip, clipStartMs: number, text: Pick<TextOverlay, "x" | "y" | "startMs" | "endMs"> & { surface?: readonly number[] },
  onProgress?: (fraction: number) => void,
  /** Turn and tilt of the plane into the wall's perspective, degrees; ignored when the text has a surface. */
  lean: { yaw: number; pitch: number } = { yaw: 0, pitch: 0 },
): Promise<{ path: NonNullable<TextOverlay["path"]>; pin: NonNullable<TextOverlay["pin"]>; lostAtMs: number | null; quality: TrackQuality } | null> {
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
    const radius = Math.round(TRACK_WIDTH * 0.03), range = Math.round(TRACK_WIDTH * 0.06), tolerance = TRACK_WIDTH * 0.006;
    const centre = { x: text.x * TRACK_WIDTH, y: text.y * TRACK_HEIGHT };
    // The plane around the text, kept inside the frame with room for a patch.
    const hw = TRACK_WIDTH * 0.2, hh = TRACK_HEIGHT * 0.075, margin = radius + 1;
    const cx = Math.max(margin + hw, Math.min(TRACK_WIDTH - 1 - margin - hw, centre.x)), cy = Math.max(margin + hh, Math.min(TRACK_HEIGHT - 1 - margin - hh, centre.y));
    // The plane is the surface the author chose (its own perspective, from the picture's edges), or a box
    // around the text turned and tilted like the wall; the tracker then moves that plane.
    const surface = text.surface && text.surface.length === 8 ? (text.surface.map((v, i) => (i % 2 === 0 ? v * TRACK_WIDTH : v * TRACK_HEIGHT)) as Quad) : null;
    const flat: Quad = surface ?? [cx - hw, cy - hh, cx + hw, cy - hh, cx + hw, cy + hh, cx - hw, cy + hh];
    const leaned = surface ? surface : (leanQuad(flat.map((v, i) => (i % 2 === 0 ? v / TRACK_WIDTH : v / TRACK_HEIGHT)) as Quad, lean.yaw, lean.pitch).map((v, i) => (i % 2 === 0 ? v * TRACK_WIDTH : v * TRACK_HEIGHT)) as Quad);
    let quad: Quad = leaned;
    // Points with detail on the surface and along its edges (a clean wall's own edges carry the motion);
    // a bare box gets a wider search area (its frame, skirting or picture edges).
    const xs = [flat[0], flat[2], flat[4], flat[6]], ys = [flat[1], flat[3], flat[5], flat[7]];
    const grow = (k: number): Quad => { const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys); const gx = (x1 - x0) * k, gy = (y1 - y0) * k; return [x0 - gx, y0 - gy, x1 + gx, y0 - gy, x1 + gx, y1 + gy, x0 - gx, y1 + gy]; };
    let points = planePoints(prev, surface ? grow(0.08) : flat, { grid: surface ? 9 : 7, radius, minEnergy: surface ? 8 : 10 });
    if (points.length < 6) points = planePoints(prev, surface ? grow(0.3) : [cx - hw * 1.8, cy - hh * 2.5, cx + hw * 1.8, cy - hh * 2.5, cx + hw * 1.8, cy + hh * 2.5, cx - hw * 1.8, cy + hh * 2.5], { grid: 9, radius, minEnergy: 8 });
    // A clean flat wall has nothing to follow on it: borrow the motion of everything around it (a door frame,
    // a window, the floor), which moves with the wall for the small step between two samples.
    if (surface && points.length < 8) points = [...points, ...planePoints(prev, grow(1.0), { grid: 11, radius, minEnergy: 8 }).filter(c => !points.some(p => Math.hypot(p[0] - c[0], p[1] - c[1]) < radius))];
    if (surface && points.length < 8) points = [...points, ...planePoints(prev, [margin, margin, TRACK_WIDTH - margin, margin, TRACK_WIDTH - margin, TRACK_HEIGHT - margin, margin, TRACK_HEIGHT - margin], { grid: 12, radius, minEnergy: 8 }).filter(c => !points.some(p => Math.hypot(p[0] - c[0], p[1] - c[1]) < radius))];
    if (points.length < 4) return null;
    const quad0 = quad.map((v, i) => (i % 2 === 0 ? v / TRACK_WIDTH : v / TRACK_HEIGHT)) as Quad;
    const baseDistance = Math.hypot(quad[2] - quad[0], quad[3] - quad[1]) || 1;
    const baseAngle = Math.atan2(quad[3] - quad[1], quad[2] - quad[0]);
    const path: NonNullable<TextOverlay["path"]> = [{ t: 0, x: 0, y: 0, s: 1, r: 0, q: quad0 }];
    const fadeSpan = Math.min(1, 250 / (lastSource - firstSource));
    let lostAtT: number | null = null, lostAtMs: number | null = null;
    const quality: TrackQuality = { points: points.length, inliers: 0, held: 0, steps: 0, grade: "good" };
    let misses = 0, inlierSum = 0;
    const inFrame = (p: [number, number]) => p[0] >= margin && p[1] >= margin && p[0] < TRACK_WIDTH - margin && p[1] < TRACK_HEIGHT - margin;
    for (let source = firstSource + stepMs; source <= lastSource + 1; source += stepMs) {
      const at = Math.min(source, lastSource);
      await seek(video, at);
      const next = grayFrame(video, TRACK_WIDTH, TRACK_HEIGHT);
      const t = Math.min(1, (at - firstSource) / (lastSource - firstSource));
      if (lostAtT === null) {
        quality.steps++;
        const moved = trackPlane(prev, next, points.filter(inFrame), quad, { radius, range, tolerance, model: "affine" });
        if (!moved) {
          // Hold this step (a hand, a flare, a bad fit); three in a row and the surface is gone.
          quality.held++;
          if (++misses >= 3) { lostAtT = t; lostAtMs = Math.round(at); }
        } else {
          misses = 0; inlierSum += moved.inliers;
          quad = moved.quad;
          points = moved.points.filter(inFrame);
          // Keep the plane well covered as it slides across the frame: top up from the current picture.
          if (points.length < 8) points = [...points, ...planePoints(next, surface ? grow(1.0) : quad, { grid: surface ? 11 : 7, radius, minEnergy: surface ? 8 : 10 }).filter(c => !points.some(p => Math.hypot(p[0] - c[0], p[1] - c[1]) < radius))];
        }
      }
      const [tlx, tly, trx, try_, brx, bry, blx, bly] = quad;
      const mid = { x: (tlx + trx + brx + blx) / 4, y: (tly + try_ + bry + bly) / 4 };
      const distance = Math.hypot(trx - tlx, try_ - tly) || 1;
      const angle = Math.atan2(try_ - tly, trx - tlx);
      const o = lostAtT === null ? 1 : Math.max(0, 1 - (t - lostAtT) / fadeSpan);
      path.push({
        t: Number(t.toFixed(4)),
        x: Number(Math.max(-0.5, Math.min(0.5, mid.x / TRACK_WIDTH - text.x)).toFixed(4)),
        y: Number(Math.max(-0.5, Math.min(0.5, mid.y / TRACK_HEIGHT - text.y)).toFixed(4)),
        s: Number(Math.max(0.2, Math.min(5, distance / baseDistance)).toFixed(3)),
        r: Number(Math.max(-180, Math.min(180, ((angle - baseAngle) * 180) / Math.PI)).toFixed(2)),
        q: quad.map((v, i) => Number(Math.max(-2, Math.min(3, i % 2 === 0 ? v / TRACK_WIDTH : v / TRACK_HEIGHT)).toFixed(4))) as Quad,
        ...(o < 1 ? { o: Number(o.toFixed(3)) } : {}),
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
    quality.inliers = quality.steps ? Math.round(inlierSum / Math.max(1, quality.steps - quality.held)) : 0;
    quality.grade = lostAtMs !== null ? "lost" : quality.held > quality.steps * 0.15 || quality.inliers < 8 ? "weak" : "good";
    return clean.length >= 2 ? { path: clean, pin: { assetId: asset.id, fromMs: Math.round(firstSource), toMs: Math.round(lastSource), quad: quad0, ...(!surface && (lean.yaw || lean.pitch) ? { lean } : {}) }, lostAtMs, quality } : null;
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

/**
 * The flat surface under a text at the frame it starts on (ADR 0043): the
 * strongest edges left, right, above and below it, as four corners in frame
 * fractions, or null when the picture has no usable edges there.
 */
export async function detectSurface(asset: LibraryAsset, clip: Clip, clipStartMs: number, text: Pick<TextOverlay, "x" | "y" | "startMs">): Promise<{ quad: number[]; weakest: number } | null> {
  const speed = clip.speed || 1;
  const sourceMs = clip.sourceStartMs + Math.max(0, text.startMs - clipStartMs) * speed;
  let video: HTMLVideoElement | null = null;
  try {
    video = await load(asset);
    await seek(video, Math.min(sourceMs, Math.max(0, clip.sourceEndMs - 40)));
    const gray = grayFrame(video, TRACK_WIDTH * 2, TRACK_HEIGHT * 2);
    const found = findSurfaceQuad(gray, text.x * gray.width, text.y * gray.height);
    if (!found) return null;
    return { quad: found.quad.map((v, i) => Number((i % 2 === 0 ? v / gray.width : v / gray.height).toFixed(4))), weakest: Math.min(found.sides.left, found.sides.right, found.sides.top, found.sides.bottom) };
  } catch {
    return null;
  } finally {
    if (video) { video.removeAttribute("src"); video.load(); }
  }
}
