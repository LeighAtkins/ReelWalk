import { z } from "zod";
import type { CameraKeyframeMove } from "@reelwalk/core";
const point = z.object({ x: z.number().min(-50).max(50), y: z.number().min(-50).max(50) }).strict();
export const cameraSketchSchema = z.object({ start: point, end: point }).strict();
export type CameraSketch = z.infer<typeof cameraSketchSchema>;
export const DEFAULT_CAMERA_SKETCH: CameraSketch = { start: { x: 0, y: 30 }, end: { x: 0, y: 10 } };
/** An intent diagram, not a measurement or recovered camera route. */
export function cameraSketchIntent(sketch: CameraSketch): { move: CameraKeyframeMove; distanceM: number } | null {
  const value = cameraSketchSchema.safeParse(sketch);
  if (!value.success) return null;
  const dx = value.data.end.x - value.data.start.x, dy = value.data.end.y - value.data.start.y;
  const distanceM = Math.round(Math.hypot(dx, dy) * 10) / 100;
  if (distanceM < 0.5) return null;
  return { move: Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "shift-right" : "shift-left" : dy < 0 ? "push-in" : "pull-back", distanceM };
}
export function clampSketchPoint(x: number, y: number) {
  return { x: Math.max(-50, Math.min(50, Math.round(x))), y: Math.max(-50, Math.min(50, Math.round(y))) };
}
