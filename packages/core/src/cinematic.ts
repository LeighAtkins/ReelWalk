import { clipDurationMs, type Clip, type TextOverlay, type Timeline } from "./timeline";

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

export function textPositionAt(text: TextOverlay, progress: number): { x: number; y: number; scale: number; rotation: number } {
  if (!text.path) return { x: text.x, y: text.y, scale: 1, rotation: 0 };
  const t = Math.max(0, Math.min(1, progress));
  const found = text.path.findIndex(p => p.t >= t);
  const end = found < 0 ? text.path.length - 1 : found;
  const b = text.path[Math.max(0, end)];
  const a = text.path[Math.max(0, end - 1)];
  const mix = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  const lerp = (from: number, to: number) => from + (to - from) * mix;
  return {
    x: Math.max(0, Math.min(1, text.x + lerp(a.x, b.x))), y: Math.max(0, Math.min(1, text.y + lerp(a.y, b.y))),
    scale: lerp(a.s ?? 1, b.s ?? 1), rotation: lerp(a.r ?? 0, b.r ?? 0),
  };
}

/** An editable finish: keep footage/order/timing, use readable type and one accent move. */
export function luxuryFinish(timeline: Timeline, variant: "refined" | "modern" = "refined", applyColour = true): Timeline {
  const hero = timeline.clips.findIndex(c => !c.pano && clipDurationMs(c) >= 1000);
  return { ...timeline,
    clips: timeline.clips.map((c, index) => ({ ...c, filter: applyColour ? variant === "refined" ? "golden" : "crisp" : c.filter,
      lensSoftness: c.pano ? c.lensSoftness : 0.28,
      motion: c.pano ? c.motion : index === hero ? "snap-out" : "none",
      transitionIn: c.transitionIn === "whip" ? "cut" : c.transitionIn,
    })),
    // Contrast is independent of typography: keep small text and the user's font.
    texts: timeline.texts.map(t => ({ ...t, shadow: t.shadow ?? "strong" })),
  };
}
