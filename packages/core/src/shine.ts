/**
 * Light and lens on type (ADR 0061): a soft light sweep across the letters,
 * glints on their edges and an anamorphic streak, as data the renderer draws
 * inside the title's own box, so a surface title's shine warps and travels
 * with its tracked plane.
 *
 * API
 *
 *   shineAt(spec, titleMs, aspect?): ShineState
 *     spec     the title's saved `shine` (preset plus optional overrides).
 *     titleMs  ms since the title's first frame (frame × 1000 / fps). Everything
 *              is a pure function of it and the title's id-free spec: no clock,
 *              no Math.random, so frame n draws the same in the editor's
 *              preview, a still and the export.
 *     aspect   the text box's height / width (for where the band crosses the
 *              middle line, which the flare follows); 0.25 if unknown.
 *     returns  the band (or null between passes), the glints alive on this
 *              frame (letter index plus a place on that letter), and the
 *              flare (or null).
 *
 *   shineBandCss(band): { tone, bloom }
 *     two copies of the letters over them: `tone` fills the letters with a
 *     gradient across the band (shade, light, shade: so it reads even on white
 *     letters), `bloom` is the letters in the light's colour with a soft glow,
 *     masked to the band's core. Percentages of the text box, so it needs no
 *     measuring and follows any transform it sits in.
 *
 *   glintSvg(glint, colour): string     one four-point star, in its own em box.
 *   flareCss(flare): CSSProperties-like record for the streak.
 *
 * Coordinates: fractions of the text's own box (the span the letters are laid
 * out in). In a surface title that box is in plane px and is warped by the
 * plane's homography; in a screen title it is the words' box.
 *
 * Invariants:
 *   - Same spec and titleMs ⇒ identical state and identical strings.
 *   - Before `startMs` nothing draws; between passes (when `everyMs` > 0) the
 *     band is null; a preset with no band never returns one.
 *   - Numbers in strings are rounded so the strings are stable.
 */
import { hash01 } from "./particles";
import type { ShinePreset, TextOverlay } from "./timeline";

export type ShineSpec = NonNullable<TextOverlay["shine"]>;

export type ShinePresetSpec = {
  /** Tilt of the band from vertical, degrees. */
  angle: number;
  /** First pass, ms after the title appears. */
  startMs: number;
  /** Repeat interval (0: once). */
  everyMs: number;
  /** How long one pass takes; 0 for no band. */
  passMs: number;
  /** Half the band's width, as a fraction of the gradient line. */
  band: number;
  /** The light's colour on the letters, its bloom, and the shade either side of it (what makes it read on white letters). */
  color: string;
  glow: string;
  shade: string;
  intensity: number;
  /** Glints alive at once (slots), each slot's cycle and how long a twinkle lasts. */
  glints: number;
  glintPeriodMs: number;
  glintMs: number;
  glintColor: string;
  flare: boolean;
  flareColor: string;
};

export const SHINE_PRESET: Record<ShinePreset, ShinePresetSpec> = {
  // A crisp white light that crosses the words once, then again every few seconds.
  sweep: { angle: 20, startMs: 400, everyMs: 3200, passMs: 800, band: 0.15, color: "#ffffff", glow: "rgba(255,255,255,0.85)", shade: "rgba(38,46,60,0.5)", intensity: 0.95, glints: 0, glintPeriodMs: 0, glintMs: 0, glintColor: "#ffffff", flare: false, flareColor: "#ffffff" },
  // No sweep: small stars catch the letters' edges, a few at a time, all through the title.
  glint: { angle: 0, startMs: 250, everyMs: 0, passMs: 0, band: 0, color: "#ffffff", glow: "rgba(255,255,255,0.8)", shade: "rgba(0,0,0,0)", intensity: 1, glints: 3, glintPeriodMs: 1500, glintMs: 700, glintColor: "#ffffff", flare: false, flareColor: "#ffffff" },
  // Late sun: a wide, warm, slower pass with a lens streak riding on it, and a couple of glints.
  golden: { angle: 32, startMs: 500, everyMs: 4200, passMs: 1600, band: 0.24, color: "#ffe1a8", glow: "rgba(255,168,64,0.8)", shade: "rgba(150,74,0,0.38)", intensity: 0.9, glints: 2, glintPeriodMs: 2100, glintMs: 800, glintColor: "#fff1cf", flare: true, flareColor: "#ffc070" },
};

export const SHINE_LABELS: Record<ShinePreset, string> = { sweep: "Sweep", glint: "Glint", golden: "Golden hour" };

/** The band of light on one frame: its centre and half-width along the gradient line (0..1 spans the box), tilt and strength. */
export type ShineBand = { position: number; half: number; angle: number; color: string; glow: string; shade: string; opacity: number };
/** One glint: on the `letter`-th visible character (spaces skipped), at (fx, fy) of that letter's box, `size` em across. */
export type ShineGlint = { slot: number; letter: number; fx: number; fy: number; size: number; opacity: number; rotation: number };
/** The anamorphic streak: centred at x (fraction of the box width) on the middle line. */
export type ShineFlare = { x: number; opacity: number; color: string };
export type ShineState = { band: ShineBand | null; glints: ShineGlint[]; flare: ShineFlare | null };

/** The preset with the title's own overrides. */
export function shineSpec(spec: ShineSpec): ShinePresetSpec {
  const preset = SHINE_PRESET[spec.preset];
  return {
    ...preset,
    ...(spec.angle !== undefined ? { angle: spec.angle } : {}),
    ...(spec.startMs !== undefined ? { startMs: spec.startMs } : {}),
    ...(spec.everyMs !== undefined ? { everyMs: spec.everyMs } : {}),
    ...(spec.flare !== undefined ? { flare: spec.flare } : {}),
  };
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const easeInOutSine = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, p)));

/** Where a pass is (0..1) at `titleMs`, or null outside a pass. */
export function shinePassProgress(spec: ShinePresetSpec, titleMs: number): number | null {
  if (spec.passMs <= 0) return null;
  const t = titleMs - spec.startMs;
  if (t < 0) return null;
  const local = spec.everyMs > 0 ? t % Math.max(spec.everyMs, spec.passMs) : t;
  const p = local / spec.passMs;
  return p < 1 ? p : null;
}

/** The shine on one frame. See the module comment. */
export function shineAt(saved: ShineSpec, titleMs: number, aspect = 0.25): ShineState {
  const spec = shineSpec(saved);
  const p = shinePassProgress(spec, titleMs);
  let band: ShineBand | null = null;
  let flare: ShineFlare | null = null;
  if (p !== null) {
    // The band starts wholly off the letters and ends wholly off them; its strength eases in and out at the ends.
    const position = -spec.band + (1 + 2 * spec.band) * easeInOutSine(p);
    const opacity = spec.intensity * smoothstep(0, 0.12, p) * (1 - smoothstep(0.88, 1, p));
    band = { position, half: spec.band, angle: spec.angle, color: spec.color, glow: spec.glow, shade: spec.shade, opacity };
    if (spec.flare) {
      // Where the tilted band crosses the box's middle line: the gradient line is longer than the box is wide by the
      // height's share of the tilt, so its position stretches about the centre by that much.
      const rad = (spec.angle * Math.PI) / 180;
      const stretch = Math.abs(Math.cos(rad)) + aspect * Math.abs(Math.sin(rad));
      const x = 0.5 + ((position - 0.5) * stretch) / Math.max(0.2, Math.abs(Math.cos(rad)));
      flare = { x, opacity: 0.85 * Math.sin(Math.PI * p) * spec.intensity, color: spec.flareColor };
    }
  }
  const glints: ShineGlint[] = [];
  for (let slot = 0; slot < spec.glints; slot++) {
    // Each slot twinkles once per cycle, the slots staggered across it; which letter it lands on is the hash of the cycle.
    const local = titleMs - spec.startMs - (slot * spec.glintPeriodMs) / spec.glints;
    if (local < 0) continue;
    const cycle = Math.floor(local / spec.glintPeriodMs);
    const age = (local - cycle * spec.glintPeriodMs) / spec.glintMs;
    if (age >= 1) continue;
    const u = (k: number) => hash01(cycle * 31 + slot, 7 + slot, k);
    const envelope = Math.pow(Math.sin(Math.PI * age), 1.5);
    glints.push({
      slot, letter: Math.floor(u(0) * 1_000_000), // reduced modulo the letter count by `glintLetter`
      // The upper edge of the letter, towards its right shoulder, where a light from above-left would catch it.
      fx: 0.45 + 0.4 * u(1), fy: 0.12 + 0.12 * u(2),
      size: (0.45 + 0.35 * u(3)) * envelope, opacity: envelope, rotation: Number((45 * age).toFixed(2)),
    });
  }
  return { band, glints, flare };
}

/** Which visible character (index into the text, spaces skipped) a glint sits on, or -1 when the text has none. */
export function glintLetter(text: string, glint: Pick<ShineGlint, "letter">): number {
  const visible = [...text].map((ch, i) => (/\s/.test(ch) ? -1 : i)).filter((i) => i >= 0);
  return visible.length ? visible[glint.letter % visible.length] : -1;
}

const r2 = (v: number) => Number(v.toFixed(2));

/**
 * The band's two copies of the letters. `tone` is a gradient clipped to the glyphs (shade, then the light, then shade,
 * along the band), `bloom` the letters in the light's colour with a glow, masked to the band's core. Alpha masks and
 * gradients in percentages of the text box.
 */
export function shineBandCss(band: ShineBand): { tone: { backgroundImage: string; opacity: number }; bloom: { maskImage: string; color: string; textShadow: string; opacity: number } } {
  const at = (v: number) => `${r2(v * 100)}%`;
  const { position: c, half: h } = band;
  const angle = `${r2(90 + band.angle)}deg`;
  const backgroundImage = `linear-gradient(${angle}, transparent ${at(c - h)}, ${band.shade} ${at(c - h * 0.55)}, ${band.color} ${at(c)}, ${band.shade} ${at(c + h * 0.55)}, transparent ${at(c + h)})`;
  const maskImage = `linear-gradient(${angle}, transparent ${at(c - h * 0.6)}, #000 ${at(c)}, transparent ${at(c + h * 0.6)})`;
  return {
    tone: { backgroundImage, opacity: r2(band.opacity) },
    bloom: { maskImage, color: band.color, textShadow: `0 0 0.05em ${band.glow}, 0 0 0.2em ${band.glow}`, opacity: r2(band.opacity) },
  };
}

/** One glint as an SVG string: a long thin four-point star over a soft core, in a 100 × 100 box (scaled by the element's size). */
export function glintSvg(glint: Pick<ShineGlint, "opacity" | "rotation">, colour: string): string {
  const o = glint.opacity.toFixed(3);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%"><g transform="rotate(${glint.rotation} 50 50)" fill="${colour}" fill-opacity="${o}">`
    + `<circle cx="50" cy="50" r="18" fill-opacity="${(glint.opacity * 0.22).toFixed(3)}"/>`
    + `<circle cx="50" cy="50" r="9" fill-opacity="${(glint.opacity * 0.7).toFixed(3)}"/>`
    + `<path d="M50 0 L56 44 L100 50 L56 56 L50 100 L44 56 L0 50 L44 44 Z"/></g></svg>`;
}

/** The streak: a long, thin, soft ellipse across the box's middle line, screen-blended by the renderer. */
export function flareCss(flare: ShineFlare): { left: string; top: string; width: string; height: string; transform: string; background: string; opacity: number } {
  return {
    left: `${r2(flare.x * 100)}%`, top: "50%", width: "160%", height: "0.42em", transform: "translate(-50%, -50%)",
    background: `radial-gradient(closest-side, rgba(255,255,255,0.95), ${flare.color} 18%, ${flare.color}55 45%, transparent 100%)`,
    opacity: r2(flare.opacity),
  };
}
