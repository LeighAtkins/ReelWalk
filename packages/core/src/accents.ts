/**
 * Accents (ADR 0108): things drawn over the footage and under the titles for part of a reel. A portal is a glowing
 * framed card floating in the shot, holding a picture wall and a second copy of a person cut out of a take; a flare is
 * a warm lens flare.
 *
 * API
 *
 *   accentSchema, accentsSchema       what `timeline.accents` may hold, checked when a timeline is parsed and by `setAccents`.
 *   accentEnvelope(accent, reelMs)    how far in the accent is (0..1) and how large it is drawn: it pops in and fades out.
 *   accentAssetIds(accents)           the library assets the accents play or show.
 *   portalFootageBox(portal, card, frame)   where a portal's whole source frame sits in the card, in card px.
 */
import { z } from "zod";

const ms = z.number().int().min(0);
const hex = z.string().regex(/^#[0-9a-f]{6}$/i);

export const portalSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("portal"),
    startMs: ms,
    endMs: ms,
    /** Centre of the card, as a fraction of the frame. */
    x: z.number().min(-0.5).max(1.5),
    y: z.number().min(-0.5).max(1.5),
    /** The card's width and height, as fractions of the frame's width and height. */
    width: z.number().min(0.05).max(1.2),
    height: z.number().min(0.05).max(1.2),
    /** Turned in space (degrees): the card leans away about its vertical axis, and tilts in the frame. */
    yaw: z.number().min(-60).max(60).default(0),
    roll: z.number().min(-30).max(30).default(0),
    /** What fills the card behind the person: a gradient, or a picture from the library. */
    wall: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("gradient"), colors: z.array(hex).min(2).max(4), angle: z.number().min(0).max(360).optional() }),
      z.object({ kind: z.literal("image"), assetId: z.string().min(1) }),
    ]),
    /** The take the person is cut out of, played silently from `sourceStartMs`. */
    person: z.object({
      assetId: z.string().min(1),
      sourceStartMs: ms.default(0),
      /** How much larger than filling the card, about the focus point (frame fractions), which lands on the card's centre. */
      zoom: z.number().min(0.5).max(4).default(1),
      focusX: z.number().min(0).max(1).default(0.5),
      focusY: z.number().min(0).max(1).default(0.5),
      mirror: z.boolean().optional(),
    }),
    /** The lit edge and the glow around it. */
    edgeColor: hex.default("#ffffff"),
    glowColor: hex.default("#ff5ec4"),
    /** Size of the glow, as a fraction of the frame's width. */
    glow: z.number().min(0).max(0.3).default(0.06),
    /** Rides the camera move of the shot under it, like something in the scene. Off: fixed to the frame. */
    followCamera: z.boolean().default(true),
  })
  .refine((portal) => portal.endMs > portal.startMs, { message: "A portal must be on screen for a positive time" });
export type Portal = z.infer<typeof portalSchema>;

export const flareSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("flare"),
    startMs: ms,
    endMs: ms,
    /** Where the light is, as a fraction of the frame. */
    x: z.number().min(-0.5).max(1.5),
    y: z.number().min(-0.5).max(1.5),
    /** Radius of the bloom, as a fraction of the frame's width. */
    size: z.number().min(0.05).max(1.5).default(0.35),
    color: hex.default("#ff8a2a"),
    intensity: z.number().min(0.1).max(1).default(0.8),
    followCamera: z.boolean().default(true),
  })
  .refine((flare) => flare.endMs > flare.startMs, { message: "A flare must be on screen for a positive time" });
export type Flare = z.infer<typeof flareSchema>;

export const accentSchema = z.union([portalSchema, flareSchema]);
export type Accent = z.infer<typeof accentSchema>;
export const accentsSchema = z.array(accentSchema).max(8).refine((accents) => new Set(accents.map((accent) => accent.id)).size === accents.length, { message: "Each accent needs its own id" });
export type AccentsInput = z.input<typeof accentsSchema>;

/** How long an accent takes to arrive and to leave, ms; never more than a third of its time on screen. */
export const ACCENT_IN_MS = 240;
export const ACCENT_OUT_MS = 160;
/** How much smaller than its size a portal starts. */
export const PORTAL_POP_FROM = 0.86;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** On this frame: `opacity` 0..1 and `scale`, easing out from a little small, with no overshoot. Off screen: opacity 0. */
export function accentEnvelope(accent: Pick<Accent, "kind" | "startMs" | "endMs">, reelMs: number): { opacity: number; scale: number } {
  if (reelMs < accent.startMs || reelMs >= accent.endMs) return { opacity: 0, scale: 1 };
  const life = accent.endMs - accent.startMs;
  const arrive = clamp01((reelMs - accent.startMs) / Math.max(1, Math.min(ACCENT_IN_MS, life / 3)));
  const leave = clamp01((accent.endMs - reelMs) / Math.max(1, Math.min(ACCENT_OUT_MS, life / 3)));
  const eased = 1 - Math.pow(1 - arrive, 3);
  return { opacity: Math.min(eased, leave), scale: accent.kind === "portal" ? PORTAL_POP_FROM + (1 - PORTAL_POP_FROM) * eased : 1 };
}

export function accentAssetIds(accents: readonly Accent[] | undefined | null): string[] {
  const ids = new Set<string>();
  for (const accent of accents ?? []) {
    if (accent.kind !== "portal") continue;
    ids.add(accent.person.assetId);
    if (accent.wall.kind === "image") ids.add(accent.wall.assetId);
  }
  return [...ids];
}

/**
 * The whole source frame, placed in the card (card px): large enough to fill the card, times the zoom, with the focus
 * point on the card's centre. The person is drawn at the reel's own size inside this box, so the matte is the same as
 * a person matte anywhere else.
 */
export function portalFootageBox(person: Pick<Portal["person"], "zoom" | "focusX" | "focusY">, card: { width: number; height: number }, frame: { width: number; height: number }): { left: number; top: number; scale: number } {
  const scale = Math.max(card.width / frame.width, card.height / frame.height) * person.zoom;
  return { left: card.width / 2 - person.focusX * frame.width * scale, top: card.height / 2 - person.focusY * frame.height * scale, scale };
}
