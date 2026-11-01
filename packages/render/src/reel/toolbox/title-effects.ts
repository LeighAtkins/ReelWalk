import { isNamedEffect, type NamedEffect } from "@reelwalk/core";

/**
 * The sixteen title effects (ADR 0103), as pure functions of the title's own time, so they are tested without a browser
 * and drawn the same in the editor's Player and the worker's export. Read off the owner's style reference (ADR 0102):
 *
 *   dots      dotHop (a dot hops along, letters appear behind it), rollout (a dot rolls in, the word unrolls from it),
 *             slingshot (a dot is drawn back and slings the word in), splits (three dots spread and become the word)
 *   line art  timelineScrub (a playhead scrubs a line and reveals the word), tracedOutline (the outline is traced, then
 *             fills), orbitRing (a ring orbits, the word settles inside), pluckedString (a line vibrates, the word opens
 *             out of it)
 *   drop-ins  stickerStack (each word drops in on its own label), oneBigSlam (one huge word slams down with trails and a
 *             shake), tumblingLetters (letters fall and turn into place), heavyLanding (the word falls and squashes)
 *   pixels    pixelSwarm (particles converge into the word), pixelRain (pixels fall and the word builds up from the
 *             bottom), mosaicResolve (mosaic blocks sharpen into the word), ledScoreboard (an LED dot-matrix scrolls in)
 *
 * Lengths are in em (the title's own font size) and box fractions (0..1 across the title's text box), so an effect
 * scales with the type. y is measured from the box's vertical centre, negative up. Every effect enters within its own
 * length (never more than half the title) and leaves with a 180 ms fade, so a title is gone on the cut it is held to.
 */

export type TitleEffect = NamedEffect;
export const isTitleEffect = (animation: string): animation is TitleEffect => isNamedEffect(animation);

/** A letter's (or a word's) own move, on top of the title's. */
export type PartState = { opacity: number; x: number; y: number; rotate: number; scale: number };

export type EffectDecor =
  /** A dot centred at (x box fraction, y em), radius r em; `stretch` widens it along x (a slingshot pulled back). */
  | { kind: "dot"; x: number; y: number; r: number; opacity: number; stretch: number }
  /** A line from x0 to x1 (box fractions) at y em; `amplitude` em bows it into a wave of `phase`; `head` puts a playhead tick on it. */
  | { kind: "line"; x0: number; x1: number; y: number; thickness: number; opacity: number; amplitude: number; phase: number; head: number | null }
  /** An ellipse round the box, `sweep` of it drawn, turned by `rotate` degrees; a dot rides its leading end. */
  | { kind: "ring"; sweep: number; rotate: number; opacity: number }
  /** A copy of the title behind it, moved and scaled: the slam's motion trail. */
  | { kind: "ghost"; x: number; y: number; scale: number; opacity: number }
  /** Square pixels of side `size` em at (x box fraction, y em). */
  | { kind: "pixels"; size: number; items: { x: number; y: number; opacity: number }[] };

export type EffectFrame = {
  /** The whole title's opacity, decorations included (the 180 ms exit). */
  opacity: number;
  /** The words' own opacity on top of that (they fade in while their dots, ring or swarm are already showing). */
  textOpacity: number;
  /** The whole title's move: em, degrees, scale; scaleX/scaleY squash it from its bottom edge. */
  x: number; y: number; rotate: number; scale: number; scaleX: number; scaleY: number;
  /** Fractions of the text box clipped from each side (0 shows all of it). */
  clip: { top: number; right: number; bottom: number; left: number };
  /** Blur radius, em. */
  blur: number;
  /** Mosaic block size, em (0 is sharp). */
  pixelate: number;
  /** Drawn as LED dots, scrolled `ledShift` of the box to the right inside its own box. */
  led: boolean;
  ledShift: number;
  /** The traced outline: how much of the stroke is drawn (left to right) and how far the fill has come up (0..1). */
  stroke: { draw: number; fill: number } | null;
  /** Each word on its own sticker, stacked. */
  stickers: boolean;
  /** Per character (spaces included), or null when the title moves as one. */
  letters: PartState[] | null;
  /** Per word (stickers), or null. */
  words: PartState[] | null;
  decor: EffectDecor[];
};

export const EXIT_MS = 180;
const REST_PART: PartState = { opacity: 1, x: 0, y: 0, rotate: 0, scale: 1 };
const NO_CLIP = { top: 0, right: 0, bottom: 0, left: 0 };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const span = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));
const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const easeIn = (t: number) => Math.pow(clamp01(t), 3);
const easeInOut = (t: number) => { const x = clamp01(t); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
/** Ease out with an overshoot (a spring that settles once). */
const easeOutBack = (t: number, s = 1.70158) => { const x = clamp01(t) - 1; return 1 + (s + 1) * x * x * x + s * x * x; };

/** A stable pseudo-random number in [0, 1) for (seed, i): the same title draws the same scatter in preview and export. */
export function seeded(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A seed from the title's words, so two titles with different words scatter differently. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** Each effect's entrance length in ms; stickers and tumbling letters grow with the words and letters they bring in. */
export function effectEnterMs(effect: TitleEffect, chars: number, words: number): number {
  switch (effect) {
    case "dotHop": return 900;
    case "rollout": return 800;
    case "slingshot": return 750;
    case "splits": return 850;
    case "timelineScrub": return 900;
    case "tracedOutline": return 1100;
    case "orbitRing": return 1000;
    case "pluckedString": return 900;
    case "stickerStack": return 220 * Math.max(0, words - 1) + 320;
    case "oneBigSlam": return 420;
    case "tumblingLetters": return 45 * Math.max(0, chars - 1) + 450;
    case "heavyLanding": return 650;
    case "pixelSwarm": return 1000;
    case "pixelRain": return 1000;
    case "mosaicResolve": return 800;
    case "ledScoreboard": return 900;
  }
}

const SWARM = 70;
const RAIN = 60;

/**
 * How a title with `effect` is drawn `titleMs` into its `lifeMs`. `chars` counts every character (spaces included),
 * `words` the words; `seed` (seedOf the text) fixes the scatter.
 */
export function titleEffectFrame(effect: TitleEffect, input: { titleMs: number; lifeMs: number; chars: number; words: number; seed: number; heightEm?: number }): EffectFrame {
  const { lifeMs, seed } = input;
  const chars = Math.max(1, input.chars), words = Math.max(1, input.words);
  // The effect runs on its own clock: real time, or faster when the title is too short for the whole entrance, so
  // every move (staggers and trails included) finishes within half the title.
  const natural = effectEnterMs(effect, chars, words);
  const pace = Math.min(1, Math.max(1, lifeMs / 2) / natural);
  const titleMs = input.titleMs / pace;
  const enter = natural;
  const p = clamp01(titleMs / enter);
  const exit = clamp01((lifeMs - input.titleMs) / EXIT_MS);
  // Past the entrance: decorations that linger (a scrub line, a ring) fade over this many ms after it.
  const after = Math.max(0, titleMs - enter);
  // Half the text block's height in em (one line by default): decorations sit against its top and bottom edges.
  const half = Math.max(0.5, (input.heightEm ?? 1.15) / 2);
  const f: EffectFrame = { opacity: exit, textOpacity: 1, x: 0, y: 0, rotate: 0, scale: 1, scaleX: 1, scaleY: 1, clip: { ...NO_CLIP }, blur: 0, pixelate: 0, led: false, ledShift: 0, stroke: null, stickers: false, letters: null, words: null, decor: [] };
  const fadeAfter = (ms: number) => 1 - clamp01(after / ms);

  switch (effect) {
    case "dotHop": {
      // The dot lands on each letter in turn; a letter shows as the dot reaches it.
      const head = p * (chars + 0.6);
      f.letters = Array.from({ length: chars }, (_, i) => {
        const a = clamp01((head - i) * 2.5);
        return { ...REST_PART, opacity: a, y: 0.18 * (1 - easeOut(a)) };
      });
      const at = clamp01(head / chars);
      f.decor.push({ kind: "dot", x: Math.min(1.04, at), y: -half - 0.2 - 0.45 * Math.abs(Math.sin(Math.PI * head)), r: 0.12, opacity: 1 - span(p, 0.86, 1), stretch: 1 });
      break;
    }
    case "rollout": {
      const roll = easeInOut(span(p, 0.05, 0.95));
      f.clip.right = 1 - roll;
      f.decor.push({ kind: "dot", x: -0.12 + 1.16 * roll, y: half - 0.28, r: 0.15, opacity: (1 - span(p, 0.9, 1)) * span(p, 0, 0.08), stretch: 1 });
      break;
    }
    case "slingshot": {
      // Drawn back for the first third, then the word flies in from the left and overshoots once.
      const pull = easeOut(span(p, 0, 0.35));
      const fly = span(p, 0.35, 1);
      f.textOpacity = fly > 0 ? 1 : 0;
      f.x = -6 * (1 - easeOutBack(fly, 2.2));
      f.blur = 0.05 * (1 - easeOut(fly)) * (fly > 0 ? 1 : 0);
      f.decor.push({ kind: "dot", x: -0.1 - 0.12 * pull, y: 0, r: 0.14, opacity: 1 - span(p, 0.35, 0.45), stretch: 1 + 1.4 * pull });
      break;
    }
    case "splits": {
      const spread = easeOut(span(p, 0, 0.4));
      const grow = span(p, 0.4, 1);
      for (const target of [0.15, 0.5, 0.85]) f.decor.push({ kind: "dot", x: 0.5 + (target - 0.5) * spread, y: 0, r: 0.13 * (1 - easeIn(grow)), opacity: 1 - span(grow, 0.6, 1), stretch: 1 });
      f.letters = Array.from({ length: chars }, (_, i) => {
        // Letters grow out of the nearest dot first.
        const at = chars === 1 ? 0.5 : i / (chars - 1);
        const near = Math.min(...[0.15, 0.5, 0.85].map((d) => Math.abs(at - d)));
        const a = span(grow, near * 0.8, near * 0.8 + 0.6);
        return { ...REST_PART, opacity: a > 0 ? Math.min(1, a * 3) : 0, scale: easeOutBack(a) };
      });
      break;
    }
    case "timelineScrub": {
      const head = easeInOut(p);
      f.clip.right = 1 - head;
      f.decor.push({ kind: "line", x0: 0, x1: 1, y: half + 0.1, thickness: 0.05, opacity: 0.85 * fadeAfter(260) * span(p, 0, 0.06), amplitude: 0, phase: 0, head });
      break;
    }
    case "tracedOutline": {
      f.stroke = { draw: easeInOut(span(p, 0, 0.75)), fill: easeOut(span(p, 0.6, 1)) };
      break;
    }
    case "orbitRing": {
      const sweep = easeOut(span(p, 0, 0.6));
      f.decor.push({ kind: "ring", sweep, rotate: -90 + 300 * easeOut(p), opacity: (1 - span(titleMs, enter * 0.75, enter * 1.1)) * span(p, 0, 0.05) });
      const settle = span(p, 0.45, 1);
      f.textOpacity = clamp01(settle * 3);
      f.scale = 0.82 + 0.18 * easeOutBack(settle);
      break;
    }
    case "pluckedString": {
      const ring = 1 - p;
      f.decor.push({ kind: "line", x0: 0, x1: 1, y: 0, thickness: 0.045, opacity: 1 - span(p, 0.55, 0.95), amplitude: 0.42 * ring * ring, phase: p * 14 * Math.PI, head: null });
      const open = easeOut(span(p, 0.3, 0.85));
      f.clip.top = 0.5 * (1 - open);
      f.clip.bottom = 0.5 * (1 - open);
      break;
    }
    case "stickerStack": {
      f.stickers = true;
      f.words = Array.from({ length: words }, (_, k) => {
        const a = span(titleMs, 220 * k, 220 * k + 320);
        const tilt = (seeded(seed, k) - 0.5) * 7;
        return { opacity: a > 0 ? 1 : 0, x: 0, y: -1.6 * (1 - easeOutBack(a, 1.4)), rotate: tilt + 12 * (1 - easeOut(a)) * (k % 2 ? 1 : -1), scale: 1 };
      });
      break;
    }
    case "oneBigSlam": {
      const fall = span(titleMs, 0, 180);
      const settle = span(titleMs, 180, 420);
      f.textOpacity = clamp01(titleMs / 120);
      f.scale = fall < 1 ? 2.6 - 1.6 * easeIn(fall) : 1 - 0.06 * Math.sin(Math.PI * settle) * (1 - settle);
      f.blur = 0.08 * (1 - fall);
      f.y = fall >= 1 ? 0.06 * Math.sin(settle * 5 * Math.PI) * (1 - settle) : 0;
      if (fall < 1) for (const extra of [0.35, 0.7]) f.decor.push({ kind: "ghost", x: 0, y: 0, scale: f.scale + extra, opacity: 0.32 * (1 - fall) });
      break;
    }
    case "tumblingLetters": {
      f.letters = Array.from({ length: chars }, (_, i) => {
        const a = span(titleMs, 45 * i, 45 * i + 450);
        const turn = (seeded(seed, i) > 0.5 ? 1 : -1) * (140 + 80 * seeded(seed, i + 101));
        return { opacity: a > 0 ? 1 : 0, x: 0, y: -1.6 * (1 - easeOutBack(a, 1.2)), rotate: turn * (1 - easeOut(a)), scale: 1 };
      });
      break;
    }
    case "heavyLanding": {
      const fall = span(p, 0, 0.55);
      const land = span(p, 0.55, 1);
      f.textOpacity = p > 0 ? 1 : 0;
      f.y = -2.2 * (1 - fall * fall);
      const squash = fall < 1 ? 0 : 0.22 * Math.pow(1 - land, 2) * Math.cos(land * 3 * Math.PI);
      f.scaleY = 1 - squash;
      f.scaleX = 1 + squash * 0.7;
      break;
    }
    case "pixelSwarm": {
      const items = Array.from({ length: SWARM }, (_, i) => {
        const delay = 0.25 * seeded(seed, i);
        const t = easeInOut(span(p, delay, delay + 0.7));
        const sx = -0.6 + 2.2 * seeded(seed, i + 200), sy = -2.6 + 5.2 * seeded(seed, i + 400);
        const tx = seeded(seed, i + 600), ty = (-0.32 + 0.64 * seeded(seed, i + 800)) * (half / 0.575);
        return { x: sx + (tx - sx) * t, y: sy + (ty - sy) * t, opacity: 1 - span(p, 0.75, 1) };
      });
      f.decor.push({ kind: "pixels", size: 0.09, items });
      f.textOpacity = easeOut(span(p, 0.55, 0.95));
      break;
    }
    case "pixelRain": {
      const items = Array.from({ length: RAIN }, (_, i) => {
        const delay = 0.45 * seeded(seed, i);
        const t = easeIn(span(p, delay, delay + 0.45));
        const startY = -2.6 - 1.2 * seeded(seed, i + 300), restY = half - 0.5 + 0.3 * seeded(seed, i + 500);
        return { x: seeded(seed, i + 700), y: startY + (restY - startY) * t, opacity: (t > 0 ? 1 : 0) * (1 - span(p, 0.8, 1)) };
      });
      f.decor.push({ kind: "pixels", size: 0.1, items });
      f.clip.top = 1 - easeOut(span(p, 0.3, 1));
      break;
    }
    case "mosaicResolve": {
      f.textOpacity = clamp01(titleMs / 100);
      const block = 0.38 * (1 - easeOut(p));
      f.pixelate = block > 0.02 ? Math.round(block * 1000) / 1000 : 0;
      break;
    }
    case "ledScoreboard": {
      f.led = true;
      f.ledShift = 1 - easeOut(p);
      break;
    }
  }
  return f;
}

/** The CSS clip-path for an effect frame's clip, or undefined when nothing is clipped. Generous outside the box, so moves past its edges still show. */
export function clipPathOf(clip: EffectFrame["clip"]): string | undefined {
  if (clip.top <= 0 && clip.right <= 0 && clip.bottom <= 0 && clip.left <= 0) return undefined;
  const side = (v: number) => (v <= 0 ? "-50%" : `${(v * 100).toFixed(2)}%`);
  return `inset(${side(clip.top)} ${side(clip.right)} ${side(clip.bottom)} ${side(clip.left)})`;
}

/** A wave along a line from x0 to x1 (box px) at y (px), as an SVG path: `amplitude` px at its middle, `phase` radians. */
export function wavePath(x0: number, x1: number, y: number, amplitude: number, phase: number, steps = 24): string {
  if (amplitude === 0) return `M ${x0.toFixed(1)} ${y.toFixed(1)} L ${x1.toFixed(1)} ${y.toFixed(1)}`;
  const parts: string[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    // Fixed at both ends, like a string: the bow is greatest in the middle.
    const offset = amplitude * Math.sin(Math.PI * t) * Math.sin(phase + t * Math.PI * 2);
    parts.push(`${s === 0 ? "M" : "L"} ${(x0 + (x1 - x0) * t).toFixed(1)} ${(y + offset).toFixed(1)}`);
  }
  return parts.join(" ");
}
