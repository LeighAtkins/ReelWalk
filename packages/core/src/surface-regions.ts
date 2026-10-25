/**
 * What the vision model is asked about a frame, and how its answer is read
 * (ADR 0075). The model does the one thing the geometry cannot: say which
 * parts of a picture are flat surfaces, and which kind (a bare wall, snow, the
 * sky). It is not trusted with where their edges are: every corner it names is
 * pulled onto a real straight edge by `findSurfaces` (surface-finder.ts), and
 * what it says is cleaned here first (clamped, ordered, dropped when it makes
 * no four-sided shape), so a bad answer costs a candidate, never a crash.
 */
import { SURFACE_KINDS, orderSurfaceCorners, type SurfaceHints, type SurfaceKind, type SurfaceRegion } from "./surface-finder";

/** Most regions asked for; the sheet shows three. */
export const SURFACE_REGIONS_MAX = 6;

export const SURFACE_REGIONS_INSTRUCTIONS = `You look at one still from a real-estate or travel video, shot on a phone in portrait, and mark the flat surfaces where a line of large title text could be painted so that it looks part of the place: a bare wall, the floor, a ceiling, a band of sky, snow or lawn, a tabletop, the glass of a window.

The picture has a thin white grid over it, a line every 10% of its width and height, counted from the top-left corner; the lines at 50% are thicker. Give every position as a fraction of the picture, x from the left and y from the top, each between 0 and 1.

For each surface give its four corners in the order top-left, top-right, bottom-right, bottom-left, as the surface itself is seen: follow its real edges, so a wall seen from the side or a floor running away from you is a slanted four-sided shape, not a box. Include only the part you can see. Leave out whatever stands in front of it (people, furniture, plants, lamps) by choosing the clear part; set "clear" to false when something still covers a good part of it.

Choose only large, calm surfaces: at least a tenth of the picture, plain or gently textured, not a busy pattern, not a face, not a screen. Prefer the ones a person would pick to put a title on. Give at most ${SURFACE_REGIONS_MAX}, best first. If nothing is suitable, give an empty list.

Also give the y of the horizon (the line where a floor or the ground would meet the sky or the far wall) as a fraction, when you can see or infer it, otherwise null.

Answer only with the JSON object.`;

export const SURFACE_REGIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["regions", "horizon"],
  properties: {
    regions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "corners", "confidence", "clear", "note"],
        properties: {
          kind: { type: "string", enum: [...SURFACE_KINDS] },
          corners: { type: "array", items: { type: "number" }, description: "Eight numbers: x then y of the top-left, top-right, bottom-right and bottom-left corners, each 0 to 1." },
          confidence: { type: "number", description: "0 to 1: how sure you are that this is one flat surface of that kind." },
          clear: { type: "boolean", description: "False when something in front covers a good part of it." },
          note: { type: "string", description: "Up to eight words on what it is, for a person choosing." },
        },
      },
    },
    horizon: { type: ["number", "null"], description: "The y of the horizon, 0 to 1, or null." },
  },
} as const;

const isKind = (value: unknown): value is SurfaceKind => typeof value === "string" && (SURFACE_KINDS as readonly string[]).includes(value);

/** The model's answer, cleaned into hints: regions with finite, clamped, ordered corners; anything else dropped. */
export function parseSurfaceRegions(json: unknown): SurfaceHints {
  if (!json || typeof json !== "object") return { regions: [], horizonY: null };
  const raw = json as { regions?: unknown; horizon?: unknown };
  const regions: SurfaceRegion[] = [];
  for (const item of Array.isArray(raw.regions) ? raw.regions : []) {
    if (regions.length >= SURFACE_REGIONS_MAX) break;
    if (!item || typeof item !== "object") continue;
    const region = item as { kind?: unknown; corners?: unknown; confidence?: unknown; clear?: unknown; note?: unknown };
    const corners = Array.isArray(region.corners) ? region.corners : [];
    if (!isKind(region.kind) || corners.length !== 8 || corners.some((v) => typeof v !== "number" || !Number.isFinite(v))) continue;
    const clamped = (corners as number[]).map((v) => Math.min(1.05, Math.max(-0.05, v)));
    // The model may start anywhere round the shape: put the corners in the order the rest of the app reads.
    const ordered = orderSurfaceCorners([[clamped[0], clamped[1]], [clamped[2], clamped[3]], [clamped[4], clamped[5]], [clamped[6], clamped[7]]]);
    regions.push({
      kind: region.kind,
      quad: [...ordered].map((v) => Number(v.toFixed(4))),
      confidence: typeof region.confidence === "number" && Number.isFinite(region.confidence) ? Math.min(1, Math.max(0, region.confidence)) : 0.5,
      clear: region.clear !== false,
      ...(typeof region.note === "string" && region.note.trim() ? { note: region.note.trim().slice(0, 60) } : {}),
    });
  }
  const horizon = typeof raw.horizon === "number" && Number.isFinite(raw.horizon) ? Math.min(1.2, Math.max(-0.2, raw.horizon)) : null;
  return { regions, horizonY: horizon };
}
