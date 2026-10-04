import { z } from "zod";

/**
 * A floor plan and where each shot was taken on it. This is what lets a reel
 * show a "you are here" marker that moves through the home as the clips play.
 *
 * All coordinates are fractions of the plan's own box: x from 0 (left) to 1
 * (right), y from 0 (top) to 1 (bottom). `aspect` is that box's width / height.
 */

const unit = z.number().min(0).max(1);
const point = z.tuple([unit, unit]);

export const planSchema = z.object({
  aspect: z.number().min(0.2).max(5),
  rooms: z.array(z.object({ points: z.array(point).min(3).max(80) })).min(1).max(80),
  /** Door openings as line segments, drawn as gaps in the walls. */
  doors: z.array(z.tuple([point, point])).max(200).default([]),
});
export type Plan = z.infer<typeof planSchema>;

/** Where a shot was taken: a position on the plan and the way the camera faced. */
export const spotSchema = z.object({
  x: unit,
  y: unit,
  /** Direction of the centre of the photo, in degrees clockwise from the top of the plan. */
  heading: z.number().min(-360).max(360),
  /**
   * For a 360 photo: where the room's main window is, as a camera yaw in
   * degrees from the centre of the image. Used to aim automatic sweeps.
   */
  aim: z.number().min(-180).max(180).optional(),
});
export type Spot = z.infer<typeof spotSchema>;

export const PLAN_CORNERS = ["top-left", "top-right"] as const;

/** The plan overlay on a reel. */
export const planOverlaySchema = z.object({
  geometry: planSchema,
  /** Both corners sit inside Instagram's safe area; the bottom is covered by its caption. */
  corner: z.enum(PLAN_CORNERS).default("top-left"),
  visible: z.boolean().default(true),
});
export type PlanOverlay = z.infer<typeof planOverlaySchema>;

export function pointInPolygon(x: number, y: number, polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Index of the room a spot is in, or -1 (a shot from a doorway can fall between rooms). */
export function roomIndexAt(plan: Plan, spot: Pick<Spot, "x" | "y">): number {
  // Smallest room first: a closet inside a larger outline should win.
  let best = -1;
  let bestArea = Infinity;
  plan.rooms.forEach((room, index) => {
    if (!pointInPolygon(spot.x, spot.y, room.points)) return;
    const area = Math.abs(polygonArea(room.points));
    if (area < bestArea) {
      best = index;
      bestArea = area;
    }
  });
  return best;
}

function polygonArea(points: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) sum += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
  return sum / 2;
}

/**
 * Turns a plan in any units into the 0..1 box used here, with a small margin.
 * Returns the mapping too, so shot positions can be converted the same way.
 */
export function normalizePlan(
  rooms: readonly (readonly (readonly [number, number])[])[],
  doors: readonly (readonly [readonly [number, number], readonly [number, number]])[] = [],
): { plan: Plan; toPlan: (x: number, y: number) => [number, number] } {
  const xs = rooms.flatMap((room) => room.map((p) => p[0]));
  const ys = rooms.flatMap((room) => room.map((p) => p[1]));
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX || 1;
  const height = Math.max(...ys) - minY || 1;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const round = (value: number) => Math.round(clamp(value) * 10_000) / 10_000;
  const toPlan = (x: number, y: number): [number, number] => [round((x - minX) / width), round((y - minY) / height)];
  const plan = planSchema.parse({
    aspect: Math.min(5, Math.max(0.2, width / height)),
    rooms: rooms.map((room) => ({ points: room.map(([x, y]) => toPlan(x, y)) })),
    doors: doors.map(([a, b]) => [toPlan(a[0], a[1]), toPlan(b[0], b[1])]),
  });
  return { plan, toPlan };
}

/** "living room" -> "Living room". */
export function roomTitle(label: string): string {
  const trimmed = label.trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : "";
}
