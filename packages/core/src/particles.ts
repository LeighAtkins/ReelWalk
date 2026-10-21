/**
 * Particles that live on a title's plane (ADR 0055): snow, embers or dust,
 * so a pinned title feels part of the scene rather than a sticker.
 *
 * API
 *
 *   particleField({ kind, density, seed, timeMs, box }): ParticleField
 *     box     the title's own box: plane px for a surface title (rect.width ×
 *             rect.height, before warping), composition px for a screen title.
 *     timeMs  reel time. Everything is a function of it and the seed: positions
 *             come from an integer hash of (seed, particle, slot), motion from
 *             time. No Math.random, no state, so frame n is the same in the
 *             editor's preview, a still and the export.
 *     returns the field's size (the box plus a margin on every side), the
 *             margins, and the particles in field px (origin at the field's
 *             top-left, i.e. (-marginX, -marginY) in box px).
 *
 *   particleSvg(field, layer, id, blend?): string
 *     one <svg> of the particles in `layer` ("back" draws below the letters,
 *     "front" above them) for one blend pass: "normal" (snow, dust, the ember
 *     halos, the flakes' cool shadows) or "screen" (the ember sparks, which the
 *     renderer screen-blends). `id` prefixes the filter ids; unique on the page.
 *
 * Depth: every particle has a depth 0–1 from the hash. Near ones (> 0.7) are
 * large and soft and always draw in front of the letters; far ones (< 0.35)
 * are small and faint and always behind; mid ones are crisp and split by a
 * per-particle bit. That split, not the count, is what reads as depth.
 *
 * Invariants:
 *   - Every particle centre lies inside the field (snow and dust wrap, faded
 *     at the edges; embers live a short life and respawn).
 *   - The count depends only on kind and density.
 *   - A particle's depth, and so its side of the letters, is fixed.
 */
import type { ParticleKind } from "./timeline";

export type ParticleBand = "near" | "mid" | "far";

export type Particle = {
  /** Centre, field px. */
  x: number;
  y: number;
  /** Radii along and across its motion, field px (at a 1080-wide composition). */
  rx: number;
  ry: number;
  /** Direction of the long axis, degrees. */
  angle: number;
  opacity: number;
  color: string;
  depth: number;
  band: ParticleBand;
  /** Drawn above the letters (true) or below them. */
  front: boolean;
  /** An ember's glow: a normal-blended, blurred disc under the spark. */
  halo?: { r: number; opacity: number };
  /** A near flake's cool shadow, so it reads on a white sky. */
  shadow?: boolean;
};

export type ParticleField = { kind: ParticleKind; width: number; height: number; marginX: number; marginY: number; particles: Particle[] };

export type ParticleInput = {
  kind: ParticleKind;
  /** 0.2 to 2, default 1. */
  density?: number;
  seed?: number;
  timeMs: number;
  box: { width: number; height: number };
};

/** Particles at density 1 (Medium); Thick (1.8) carries 1.8×. */
export const PARTICLE_BASE: Record<ParticleKind, number> = { snow: 70, embers: 50, dust: 35 };
/** The share of mid-depth particles drawn in front of the letters. */
export const PARTICLE_MID_FRONT_SHARE = 0.4;
export const NEAR_DEPTH = 0.7;
export const FAR_DEPTH = 0.35;
const SHADOW_COLOUR = "#1a2a3a";

/** How many particles a kind draws at a density. */
export function particleCount(kind: ParticleKind, density = 1): number {
  const d = Math.min(2, Math.max(0.2, density));
  return Math.round(PARTICLE_BASE[kind] * d);
}

/** The margins (px) around a box the particles may wander into: 30% of each side, with room above and below a single line (a quarter of its width), at least 32. */
export function particleMargins(box: { width: number; height: number }): { x: number; y: number } {
  return { x: Math.round(Math.max(32, box.width * 0.3)), y: Math.round(Math.max(32, box.height * 0.3, box.width * 0.25)) };
}

/** A uniform number in [0, 1) from three integers: a 32-bit integer mix, the same on every machine. */
export function hash01(seed: number, index: number, slot: number): number {
  let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ Math.imul(index + 1, 0xc2b2ae35), 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15) ^ Math.imul(slot + 1, 0x165667b1), 0x85ebca6b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** x mod n, always in [0, n). */
function wrap(x: number, n: number): number {
  return ((x % n) + n) % n;
}

/** 0 at an edge, 1 from `band` (fraction of the length) inside it: hides the wrap-around. */
function edgeFade(v: number, length: number, band = 0.08): number {
  return Math.min(1, Math.max(0, Math.min(v, length - v) / (length * band)));
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mix(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0")).join("")}`;
}

function bandOf(depth: number): ParticleBand {
  return depth > NEAR_DEPTH ? "near" : depth < FAR_DEPTH ? "far" : "mid";
}

/** The particles of one title on one frame. See the module comment. */
export function particleField(input: ParticleInput): ParticleField {
  const { kind, timeMs, box } = input;
  const seed = input.seed ?? 0;
  const margins = particleMargins(box);
  const W = Math.max(1, Math.round(box.width + margins.x * 2)), H = Math.max(1, Math.round(box.height + margins.y * 2));
  const t = timeMs / 1000;
  const count = particleCount(kind, input.density);
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const u = (slot: number) => hash01(seed, i, slot);
    const depth = u(10);
    const band = bandOf(depth);
    const front = band === "near" ? true : band === "far" ? false : u(9) < PARTICLE_MID_FRONT_SHARE;
    const phase = u(5) * Math.PI * 2;
    const size = u(2);
    if (kind === "snow") {
      // Nearer flakes fall faster and sway wider (parallax), within 25–45 px/s and 10–20 px.
      const vy = 25 + 20 * depth;
      const vx = 4 + (u(3) - 0.5) * 10;
      const amp = 10 + 10 * depth, w = 0.5 + 0.6 * u(4);
      const x = wrap(u(0) * W + vx * t + amp * Math.sin(t * w + phase), W);
      const y = wrap(u(1) * H + vy * t, H);
      // The long axis follows the velocity, so the flake turns slowly as it sways.
      const angle = (Math.atan2(vy, vx + amp * w * Math.cos(t * w + phase)) * 180) / Math.PI;
      const r = band === "near" ? 3.5 + 3.5 * size : band === "mid" ? 1.5 + 1.5 * size : 0.75 + 0.75 * size;
      const base = band === "near" ? 0.6 : band === "mid" ? 0.75 + 0.15 * u(6) : 0.45;
      const opacity = base * edgeFade(x, W) * edgeFade(y, H);
      particles.push({ x, y, rx: r * 1.3, ry: r, angle, opacity, color: "#ffffff", depth, band, front, ...(band === "near" ? { shadow: true } : {}) });
    } else if (kind === "embers") {
      // A short life (1.5–3 s): it fades up, rises 30–60 px/s with a sway and a flicker, fades out, and is born
      // again lower down somewhere else. Each life's start comes from the hash of its cycle number.
      const life = 1.5 + 1.5 * u(3);
      const clock = t / life + u(1);
      const cycle = Math.floor(clock), age = clock - cycle;
      const v = (slot: number) => hash01(seed + cycle * 7919, i, slot);
      const vy = 30 + 30 * v(0);
      const startY = H * (0.35 + 0.6 * v(1));
      const travelled = vy * age * life;
      const x = wrap(W * v(2) + 10 * Math.sin(age * life * (1.4 + u(4)) + phase), W);
      const y = Math.max(0, startY - travelled);
      const envelope = smoothstep(0, 0.15, age) * (1 - smoothstep(0.5, 1, age));
      const flicker = 0.8 + 0.2 * Math.sin(t * (9 + 8 * u(7)) + phase);
      const r = band === "near" ? 2 + 1.5 * size : band === "mid" ? 1.5 + 1.5 * size : 0.75 + 0.75 * size;
      const base = band === "far" ? 0.45 : 1;
      const opacity = base * envelope * flicker * edgeFade(x, W) * smoothstep(0, 0.06, y / H);
      const halo = band === "near" ? { r: 4 + 2 * size, opacity: 0.35 * opacity } : band === "mid" ? { r: r * 2.2, opacity: 0.2 * opacity } : undefined;
      particles.push({ x, y, rx: r, ry: r, angle: 0, opacity, color: mix("#ffb15c", "#ff6a2a", u(8)), depth, band, front, ...(halo ? { halo } : {}) });
    } else {
      // Dust hangs in the air: 5–10 px/s in any direction, with a slow wander.
      const speed = 5 + 5 * u(3), heading = u(4) * Math.PI * 2;
      const x = wrap(u(0) * W + Math.cos(heading) * speed * t + 6 * Math.sin(t * 0.35 + phase), W);
      const y = wrap(u(1) * H + Math.sin(heading) * speed * t + 5 * Math.cos(t * 0.27 + phase), H);
      const r = 1.5 + 1.5 * size;
      const opacity = (0.35 + 0.15 * u(6)) * edgeFade(x, W) * edgeFade(y, H);
      particles.push({ x, y, rx: r, ry: r, angle: 0, opacity, color: "#fff4dc", depth, band, front });
    }
  }
  return { kind, width: W, height: H, marginX: margins.x, marginY: margins.y, particles };
}

/** Blur (stdDeviation, field px) of each soft group. */
const SOFT_BLUR: Record<ParticleKind, number> = { snow: 1.25, embers: 0.8, dust: 0.9 };
const HALO_BLUR = 3;

const f1 = (v: number) => v.toFixed(1);
const f3 = (v: number) => v.toFixed(3);

function shape(x: number, y: number, rx: number, ry: number, angle: number, fill: string, opacity: number): string {
  if (Math.abs(rx - ry) < 0.01) return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${rx.toFixed(2)}" fill="${fill}" fill-opacity="${f3(opacity)}"/>`;
  return `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}" transform="rotate(${f1(angle)} ${f1(x)} ${f1(y)})" fill="${fill}" fill-opacity="${f3(opacity)}"/>`;
}

/**
 * One layer of a field, one blend pass, as an SVG string. Numbers are rounded so the string is stable.
 * Groups: near particles under a soft blur (with their shadows or halos), the rest crisp.
 */
export function particleSvg(field: ParticleField, layer: "front" | "back", id: string, blend: "normal" | "screen" = "normal"): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  const shown = field.particles.filter((p) => p.front === (layer === "front") && p.opacity > 0.005);
  const halos: string[] = [], soft: string[] = [], crisp: string[] = [];
  for (const p of shown) {
    if (field.kind === "embers") {
      if (blend === "normal") { if (p.halo) halos.push(shape(p.x, p.y, p.halo.r, p.halo.r, 0, p.color, p.halo.opacity)); continue; }
      (p.band === "near" ? soft : crisp).push(shape(p.x, p.y, p.rx, p.ry, 0, p.color, p.opacity));
      continue;
    }
    if (blend === "screen") continue;
    const parts = (p.shadow ? shape(p.x + 1, p.y + 1, p.rx, p.ry, p.angle, SHADOW_COLOUR, 0.25 * (p.opacity / 0.6)) : "") + shape(p.x, p.y, p.rx, p.ry, p.angle, p.color, p.opacity);
    (p.band === "near" ? soft : crisp).push(parts);
  }
  const w = field.width.toFixed(0), h = field.height.toFixed(0);
  const filters = [
    halos.length ? `<filter id="${safe}-halo" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${HALO_BLUR}"/></filter>` : "",
    soft.length ? `<filter id="${safe}-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${SOFT_BLUR[field.kind]}"/></filter>` : "",
  ].join("");
  const groups = [
    halos.length ? `<g filter="url(#${safe}-halo)">${halos.join("")}</g>` : "",
    soft.length ? `<g filter="url(#${safe}-soft)">${soft.join("")}</g>` : "",
    crisp.length ? `<g>${crisp.join("")}</g>` : "",
  ].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${filters ? `<defs>${filters}</defs>` : ""}${groups}</svg>`;
}
