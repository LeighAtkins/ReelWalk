/**
 * What "Put text on a surface" writes into a title (ADR 0075), in one place so the editor's tap, the
 * `placeOnSurface` command and an agent's explicit placement all land the same fields: the corners the
 * title fills, the surface blend, the house serif with no box (owner rule: no backgrounded text), the
 * ink chosen from the surface, and the track when the surface could be followed.
 */
import type { TextOverlay } from "./timeline";

export const SURFACE_PICKS = ["auto", "wall", "floor", "ceiling", "sky", "tabletop", "ground", "window"] as const;
export type SurfacePick = (typeof SURFACE_PICKS)[number];

export type TitleOnSurface = {
  /** The corners the title fills (tl, tr, br, bl), frame fractions: a title-shaped rectangle in the surface's own perspective. */
  corners: number[];
  /** The ink that reads on that surface, from the picture under it. */
  ink?: { color: string; shadow: "soft" | "strong" };
  /** The surface followed through the shot (ADR 0052): the path and pin the tracker wrote. Absent: the title is placed, not tracked. */
  pinned?: { path: NonNullable<TextOverlay["path"]>; pin: NonNullable<TextOverlay["pin"]> };
  /** The shot's span when the title is made to stand for the whole shot. */
  timing?: { startMs: number; endMs: number };
};

/** Why a placement cannot be used, or null. */
export function placementProblem(placement: unknown): string | null {
  if (!placement || typeof placement !== "object") return "placement must be an object with corners";
  const p = placement as Partial<TitleOnSurface>;
  if (!Array.isArray(p.corners) || p.corners.length !== 8 || p.corners.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < -0.5 || v > 1.5)) return "placement.corners must be eight numbers (x, y of top-left, top-right, bottom-right, bottom-left) between -0.5 and 1.5";
  if (p.ink && (typeof p.ink.color !== "string" || !/^#[0-9a-f]{6}$/i.test(p.ink.color) || (p.ink.shadow !== "soft" && p.ink.shadow !== "strong"))) return "placement.ink must be { color: \"#rrggbb\", shadow: \"soft\" | \"strong\" }";
  return null;
}

/** The fields a placement sets on a title. Everything about the old surface (posts, cut-outs, taps, a track on another plane) goes. */
export function surfacePatch(placement: TitleOnSurface): Partial<Omit<TextOverlay, "id">> {
  const c = placement.corners;
  // The title lives where its surface is: x and y are the middle of the corners (a track's keyframes are offsets from there).
  const x = (c[0] + c[2] + c[4] + c[6]) / 4, y = (c[1] + c[3] + c[5] + c[7]) / 4;
  return {
    x: Number(Math.min(1, Math.max(0, x)).toFixed(4)),
    y: Number(Math.min(1, Math.max(0, y)).toFixed(4)),
    style: "elegant",
    font: "serif",
    size: 1,
    blend: "surface",
    surface: placement.corners.map((v) => Number(v.toFixed(4))),
    ...(placement.ink ? { color: placement.ink.color, shadow: placement.ink.shadow } : {}),
    path: placement.pinned?.path,
    pin: placement.pinned?.pin,
    bars: undefined,
    cutouts: undefined,
    occluders: undefined,
    ...(placement.timing ?? {}),
  };
}
