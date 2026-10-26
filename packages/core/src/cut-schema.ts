/**
 * The cut grammar's record on a clip (ADR 0087): which named editing technique carries the shot change into the
 * clip, and why it was chosen. Zod only, so timeline.ts can import it without a cycle; the rules that read it are in
 * cut-grammar.ts and the planner that writes it in cut-planner.ts.
 *
 * Owner's rule (2026-10-26): "in every cut or shot change you're employing a real editing concept that keeps things
 * fresh… think about where the viewer's eyes are going, how you're surprising them and keeping them watching."
 */
import { z } from "zod";

/**
 * The vocabulary. Some are drawn (a transition kind does the work), the rest are a hard cut that is a technique
 * because of where its in and out points were put:
 *
 *   eyeTrace        the thing you were looking at is where the next thing is (selection)
 *   matchDirection  the camera's drift carries across the cut (selection)
 *   cutOnAction     the cut sits on a peak of movement, which hides it (selection)
 *   beatCut         a hard cut on a downbeat after a build (selection + music)
 *   occlusionWipe   a door frame, wall edge or person sweeps the lens and the next shot is behind it (drawn, or a cut
 *                   inside the occluder's darkest frame)
 *   zoomThrough     an eased push into a region of A, B emerging from the matching region (drawn)
 *   rackFocus       focus slides through depth, B resolves from the blur (the focus pull, with a depth map when known)
 *   scaleJump       wide to a virtual close-up cropped from the same source, with a micro push (selection + camera)
 *   shapeMatch      a shape or colour carries across (selection)
 *   graphicCarry    a title stays on screen while the picture changes under it (a text spanning the cut)
 *   lightLeak       a soft glint over the cut (drawn, ADR 0082)
 *   dissolve        a crossfade or soft dissolve (drawn, ADR 0082/0083)
 */
export const CUT_TECHNIQUES = [
  "eyeTrace", "matchDirection", "cutOnAction", "beatCut", "occlusionWipe", "zoomThrough", "rackFocus", "scaleJump", "shapeMatch", "graphicCarry", "lightLeak", "dissolve",
] as const;
export type CutTechnique = (typeof CUT_TECHNIQUES)[number];

export const WIPE_SIDES = ["left", "right", "top", "bottom"] as const;
export type WipeSide = (typeof WIPE_SIDES)[number];

/**
 * A small depth map in the shot analysis' format (ADR 0086 `depthSampleSchema`): `grid` is base64 of `cols` × `rows`
 * bytes, row-major, 0 far to 255 near. Depth is smooth, so a coarse grid is enough for a blur mask.
 */
export const depthGridSchema = z.object({
  cols: z.number().int().min(2).max(64),
  rows: z.number().int().min(2).max(64),
  grid: z.string().max(8192),
});
export type DepthGrid = z.infer<typeof depthGridSchema>;

const frac = z.number().min(0).max(1);

export const cutInSchema = z.object({
  technique: z.enum(CUT_TECHNIQUES),
  /** Why this technique, in a few words the director, the critic and a person can read. */
  reason: z.string().trim().min(1).max(200),
  /** How far the eye has to jump across the cut: the attention points' distance, fraction of the frame width. */
  eyeTrace: z.number().min(0).max(2).optional(),
  /** Set when this shot change is the reel's pattern break ("reveal", "scale jump"): the critic spaces these. */
  surprise: z.string().trim().min(1).max(60).optional(),
  /** What moves in this shot: the footage itself, or a virtual push/reframe the planner added. */
  motion: z.enum(["real", "virtual"]).optional(),
  /**
   * The occlusion wipe's edge: the side the occluder enters from and where its edge is (fraction of the frame
   * across the wipe's direction) at even steps through the transition, so the mask follows the real door frame.
   */
  wipe: z.object({ from: z.enum(WIPE_SIDES), edge: z.array(frac).min(2).max(13), soft: z.number().min(0).max(0.3).default(0.06) }).optional(),
  /** The zoom-through's regions: the target in A and the matching region in B (frame fractions), and how far A pushes. */
  zoom: z.object({ ax: frac, ay: frac, bx: frac, by: frac, scale: z.number().min(1.2).max(4).default(2.4) }).optional(),
  /** Depth of A's last frame and B's first, for the rack focus: far blurs first, near holds. */
  depth: z.object({ a: depthGridSchema.optional(), b: depthGridSchema.optional() }).optional(),
  /** A J-cut: this clip's own sound starts this long before the cut (its ambience leads the picture). */
  jMs: z.number().int().min(0).max(1500).optional(),
  /** An L-cut: the previous clip's sound runs on this long after the cut. */
  lMs: z.number().int().min(0).max(1500).optional(),
});
export type CutIn = z.infer<typeof cutInSchema>;
