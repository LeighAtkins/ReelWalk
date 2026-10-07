import type { Clip } from "./timeline";

/** The shortest time a text can be on screen when its edges are dragged. */
export const MIN_TEXT_DRAG_MS = 300;

export type DragEdge = "start" | "end" | "move";

export type RetimeOptions = {
  totalMs: number;
  /** Times an edge sticks to when it comes within snapMs: cuts, the playhead, other texts. */
  snapPoints: number[];
  snapMs: number;
};

/**
 * Snap a time to the nearest snap point within reach, otherwise to a tenth
 * of a second. Returns the time and the distance it moved.
 */
export function snapTime(ms: number, points: number[], snapMs: number): { ms: number; hit: boolean } {
  let best = Math.round(ms / 100) * 100;
  let distance = snapMs;
  let hit = false;
  for (const point of points) {
    const d = Math.abs(point - ms);
    if (d < distance) {
      best = point;
      distance = d;
      hit = true;
    }
  }
  return { ms: best, hit };
}

/**
 * The new on-screen window for a text whose start edge, end edge or whole
 * bar was dragged by deltaMs on the timeline.
 */
export function retimeText(
  text: { startMs: number; endMs: number },
  edge: DragEdge,
  deltaMs: number,
  { totalMs, snapPoints, snapMs }: RetimeOptions,
): { startMs: number; endMs: number } {
  const min = Math.min(MIN_TEXT_DRAG_MS, totalMs);
  if (edge === "start") {
    const { ms } = snapTime(text.startMs + deltaMs, snapPoints, snapMs);
    return { startMs: Math.max(0, Math.min(ms, text.endMs - min)), endMs: text.endMs };
  }
  if (edge === "end") {
    const { ms } = snapTime(text.endMs + deltaMs, snapPoints, snapMs);
    return { startMs: text.startMs, endMs: Math.min(totalMs, Math.max(ms, text.startMs + min)) };
  }
  // Moving keeps the length. Whichever edge lands on a snap point wins.
  const length = text.endMs - text.startMs;
  const start = snapTime(text.startMs + deltaMs, snapPoints, snapMs);
  const end = snapTime(text.endMs + deltaMs, snapPoints, snapMs);
  let startMs = start.ms;
  if (end.hit && (!start.hit || Math.abs(end.ms - (text.endMs + deltaMs)) < Math.abs(start.ms - (text.startMs + deltaMs)))) {
    startMs = end.ms - length;
  }
  startMs = Math.max(0, Math.min(startMs, totalMs - length));
  return { startMs, endMs: startMs + length };
}

/**
 * The source window for a clip whose start or end edge was dragged by
 * deltaMs of timeline time. Dragging the end right shows more of the source;
 * dragging the start right cuts the opening. trimClip applies the limits.
 */
export function clipEdgeWindow(clip: Clip, edge: "start" | "end", deltaMs: number): { sourceStartMs: number; sourceEndMs: number } {
  if (clip.kind === "IMAGE") {
    // A photo has no source to reveal: either edge only changes how long it shows.
    const length = clip.sourceEndMs - clip.sourceStartMs + (edge === "end" ? deltaMs : -deltaMs);
    return { sourceStartMs: 0, sourceEndMs: Math.round(Math.max(1, length) / 100) * 100 };
  }
  const source = deltaMs * clip.speed;
  return edge === "end"
    ? { sourceStartMs: clip.sourceStartMs, sourceEndMs: clip.sourceEndMs + source }
    : { sourceStartMs: clip.sourceStartMs + source, sourceEndMs: clip.sourceEndMs };
}
