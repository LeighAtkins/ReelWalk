import { locate, clipDurationMs, clipSourceMsAt, type Clip, type TextOverlay, type Timeline, framePlan, REEL_FORMAT } from "./timeline";
import { applyHomography, homography, type Quad } from "./motion";
import { cameraKeysAt, cameraStillAtStart, openingProgress, type CameraMove } from "./camera";
import { FONT_METRICS } from "./font-metrics";

export function cameraMoveAt(motion: Clip["motion"], progress: number, elapsedSeconds: number) {
  const p = Math.max(0, Math.min(1, progress));
  const snap = 1 - Math.pow(1 - Math.max(0, Math.min(1, elapsedSeconds / 0.18)), 3);
  switch (motion) {
    case "zoom-in": return { scale: 1 + 0.14 * p, x: 0 };
    case "zoom-out": return { scale: 1.14 - 0.14 * p, x: 0 };
    case "pan": return { scale: 1.16, x: -5 + 10 * p };
    case "snap-in": return { scale: 1 + 0.12 * snap, x: 0 };
    case "snap-out": return { scale: 1.12 - 0.12 * snap, x: 0 };
    default: return { scale: 1, x: 0 };
  }
}

/**
 * The clip's camera at `progress` (ADR 0067): its eased move when it has one
 * (`camera`); on the opening shot a move that would ease out of a standstill
 * is read from a tenth of the way in, so frame 0 already moves (the presets
 * move from frame 0 by themselves). Otherwise the Ken Burns preset `motion`
 * as before, with no vertical shift. Scale about the centre; x and y in
 * percent of the frame.
 */
export function clipCameraAt(clip: Pick<Clip, "motion" | "camera">, progress: number, elapsedSeconds: number, opening = false): CameraMove {
  if (clip.camera) return cameraKeysAt(clip.camera, opening && cameraStillAtStart(clip.camera) ? openingProgress(progress) : progress);
  const move = cameraMoveAt(clip.motion, progress, elapsedSeconds);
  return { scale: move.scale, x: move.x, y: 0 };
}

/** `progress` for a pinned text while a clip other than its own is on screen: it sits still at its base position. */
export const PINNED_ELSEWHERE = -1;

/** `locate`, but on the frame-rounded plan the composition renders: which clip owns the frame at `reelMs`, and how far into it (ms). */
export function locateFrame(timeline: Timeline, reelMs: number, fps: number = REEL_FORMAT.fps): { index: number; offsetMs: number } | null {
  const frame = Math.round((reelMs * fps) / 1000);
  const plan = framePlan(timeline, fps);
  for (const [index, entry] of plan.clips.entries()) {
    if (frame >= entry.from && frame < entry.from + entry.durationInFrames) return { index, offsetMs: Math.max(0, ((frame - entry.from) * 1000) / fps) };
  }
  return null;
}

/**
 * Where along a pinned text's path the reel is at `reelMs`: the clip on
 * screen must be the one the path was tracked on, and t runs over the
 * source window that was tracked. Otherwise the text holds its base spot.
 */
export function pinnedProgress(timeline: Timeline, text: TextOverlay, reelMs: number, fps: number = REEL_FORMAT.fps): number {
  if (!text.pin) return 0;
  // The composition cuts between clips on whole frames (framePlan rounds each start), so the clip on
  // screen is read off the same rounded plan: at a boundary that rounds down, the millisecond
  // clock still says the previous clip while the picture is already the next one.
  const at = locateFrame(timeline, reelMs, fps);
  const clip = at ? timeline.clips[at.index] : null;
  if (!clip || !at || clip.assetId !== text.pin.assetId) return PINNED_ELSEWHERE;
  const sourceMs = clipSourceMsAt(clip, at.offsetMs);
  const span = text.pin.toMs - text.pin.fromMs;
  return span > 0 ? (sourceMs - text.pin.fromMs) / span : 0;
}

/**
 * True when a pinned title is taken off before its shot ends: it was shortened
 * on purpose (a wall that leaves the frame, a push-in), so the render fades it
 * out instead of cutting it. A title that runs to the cut just goes with the cut.
 */
export function endsBeforeShot(timeline: Timeline, text: TextOverlay): boolean {
  if (!text.pin) return false;
  const at = locate(timeline, Math.max(text.startMs, text.endMs - 1));
  if (!at) return false;
  const clipEndMs = text.endMs - 1 - at.offsetMs + clipDurationMs(timeline.clips[at.index]);
  return clipEndMs - text.endMs > 80;
}

/**
 * A pinned title given a new plane without re-tracking (ADR 0044): each
 * keyframe's corners are the old plane's corners carried by that frame's
 * motion, so the new plane is carried the same way. Lets a corner be moved
 * on any frame of the shot and the whole track follow at once.
 */
export function reshapePin(text: TextOverlay, surface: readonly number[]): { pin: NonNullable<TextOverlay["pin"]>; path: TextOverlay["path"] } | null {
  if (!text.pin?.quad || !text.path) return null;
  const from = text.pin.quad as Quad;
  const path = text.path.map((key) => {
    if (!key.q) return key;
    const H = homography(from, key.q as Quad);
    if (!H) return key;
    const q = [0, 1, 2, 3].flatMap((i) => { const [x, y] = applyHomography(H, surface[i * 2], surface[i * 2 + 1]); return [Number(x.toFixed(4)), Number(y.toFixed(4))]; });
    return { ...key, q };
  });
  return { pin: { ...text.pin, quad: [...surface] }, path };
}

/** The tracked plane's corners at `progress`, interpolated between keyframes; null when the text has no planar track. */
export function textQuadAt(text: TextOverlay, progress: number): number[] | null {
  if (!text.path || !text.pin?.quad || progress === PINNED_ELSEWHERE) return null;
  const t = Math.max(0, Math.min(1, progress));
  const found = text.path.findIndex(p => p.t >= t);
  const end = found < 0 ? text.path.length - 1 : found;
  const b = text.path[Math.max(0, end)], a = text.path[Math.max(0, end - 1)];
  if (!a.q || !b.q) return null;
  const mix = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return a.q.map((v, i) => v + (b.q![i] - v) * mix);
}

export function textPositionAt(text: TextOverlay, progress: number): { x: number; y: number; scale: number; rotation: number; opacity: number } {
  if (!text.path) return { x: text.x, y: text.y, scale: 1, rotation: 0, opacity: 1 };
  if (text.pin && progress === PINNED_ELSEWHERE) return { x: text.x, y: text.y, scale: 1, rotation: 0, opacity: 1 };
  const t = Math.max(0, Math.min(1, progress));
  const found = text.path.findIndex(p => p.t >= t);
  const end = found < 0 ? text.path.length - 1 : found;
  const b = text.path[Math.max(0, end)];
  const a = text.path[Math.max(0, end - 1)];
  const mix = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  const lerp = (from: number, to: number) => from + (to - from) * mix;
  return {
    x: Math.max(0, Math.min(1, text.x + lerp(a.x, b.x))), y: Math.max(0, Math.min(1, text.y + lerp(a.y, b.y))),
    scale: lerp(a.s ?? 1, b.s ?? 1), rotation: lerp(a.r ?? 0, b.r ?? 0), opacity: lerp(a.o ?? 1, b.o ?? 1),
  };
}

/** An editable finish: keep footage/order/timing, use readable type and one accent move. */
export function luxuryFinish(timeline: Timeline, variant: "refined" | "modern" = "refined", applyColour = true): Timeline {
  const hero = timeline.clips.findIndex(c => !c.pano && clipDurationMs(c) >= 1000);
  return { ...timeline,
    clips: timeline.clips.map((c, index) => ({ ...c, filter: applyColour ? variant === "refined" ? "golden" : "crisp" : c.filter,
      lensSoftness: c.pano ? c.lensSoftness : 0.28,
      motion: c.pano ? c.motion : index === hero ? "snap-out" : "none",
    })),
    // Contrast is independent of typography: keep small text and the user's font.
    texts: timeline.texts.map(t => ({ ...t, shadow: t.shadow ?? "strong" })),
  };
}

export type OneLineFont = { fontFamily?: string; fontWeight?: string | number; fontSize: number; letterSpacing?: number; fontStretch?: string };

/**
 * The measured face for a font, or null: the renderer's title families (font-metrics.ts, measured in
 * Chromium from the same font files) at the nearest weight and stretch the table has.
 */
export function fontMetricsFor(font: OneLineFont): { avg: number; widths: Record<string, number> } | null {
  const family = (font.fontFamily ?? "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  if (!family) return null;
  const weight = Number(font.fontWeight ?? 600) || 600;
  const stretch = font.fontStretch ? parseFloat(font.fontStretch) || 100 : 100;
  let best: { key: string; distance: number } | null = null;
  for (const key of Object.keys(FONT_METRICS)) {
    const [name, w, s] = key.split("|");
    if (name !== family) continue;
    // Stretch first (a 125% face is a different width), then weight.
    const distance = Math.abs(Number(s) - stretch) * 10 + Math.abs(Number(w) - weight);
    if (!best || distance < best.distance) best = { key, distance };
  }
  return best ? FONT_METRICS[best.key] : null;
}

/**
 * A line's width without a DOM, px: the measured advances of the renderer's own faces summed (unknown
 * characters at the face's lowercase average), or for a family not measured an average 0.62 em a
 * character honouring stretch; plus letter spacing either way. Kerning is not applied, so a line can
 * run a few px wide of the drawn one, never narrow.
 */
export function estimateLineWidth(text: string, font: OneLineFont): number {
  const spacing = (font.letterSpacing ?? 0) * font.fontSize * Math.max(0, text.length - 1);
  const metrics = fontMetricsFor(font);
  if (metrics) {
    let em = 0;
    for (const ch of text) em += metrics.widths[ch] ?? metrics.avg;
    return em * font.fontSize + spacing;
  }
  const stretch = font.fontStretch ? parseFloat(font.fontStretch) / 100 || 1 : 1;
  return text.length * font.fontSize * 0.62 * stretch + spacing;
}

let measureSpan: HTMLSpanElement | null = null;
/**
 * How wide a one-line title is, as a fraction of the frame. In a browser the
 * text is laid out in a hidden span with the same font, weight, stretch and
 * letter spacing (canvas metrics ignore a variable font's width axis and were
 * 30% short); without a DOM, an estimate from the character count. A planar
 * title never wraps, so this decides whether it fits the frame.
 *
 * The composition no longer calls this: scene evaluation (ADR 0046) takes an
 * injected measurer and the renderer passes its own (packages/render
 * src/reel/measure.ts). It stays for the editor's handles until they consume
 * the scene evaluator.
 */
export function oneLineWidth(text: string, font: OneLineFont, frameWidth = 1080): number {
  if (typeof document !== "undefined") {
    try {
      if (!measureSpan) {
        measureSpan = document.createElement("span");
        Object.assign(measureSpan.style, { position: "absolute", left: "-99999px", top: "0", visibility: "hidden", whiteSpace: "nowrap", pointerEvents: "none" });
        document.body.appendChild(measureSpan);
      }
      Object.assign(measureSpan.style, {
        fontFamily: font.fontFamily ?? "sans-serif", fontWeight: String(font.fontWeight ?? 600), fontSize: `${font.fontSize}px`,
        fontStretch: font.fontStretch ?? "normal", letterSpacing: font.letterSpacing !== undefined ? `${font.letterSpacing}em` : "normal",
      });
      measureSpan.textContent = text;
      const width = measureSpan.getBoundingClientRect().width;
      if (width > 0) return width / frameWidth;
    } catch { /* fall through to the estimate */ }
  }
  return estimateLineWidth(text, font) / frameWidth;
}

// planarFitAndShift and PLANAR_MAX_WIDTH moved to scene.ts (ADR 0046), with the rest of title placement.
