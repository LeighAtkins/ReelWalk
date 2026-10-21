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
 *             margin, and the particles in field px (origin at the field's
 *             top-left, i.e. (-margin, -margin) in box px).
 *
 *   particleSvg(field, layer, id): string
 *     one <svg> of the particles in `layer` ("back" draws below the letters,
 *     "front" above them), circles under a single blur filter. `id` names the
 *     filter; it must be unique on the page.
 *
 * Invariants:
 *   - Every particle centre lies inside the field (wrapped, never clamped, so a
 *     particle leaving one edge enters at the opposite one, faded at both).
 *   - The count depends only on kind and density (40 to 120; dust half that).
 *   - Each particle's front/back bit is fixed for its life: a flake does not
 *     hop through the letters.
 */
import type { ParticleKind } from "./timeline";

export type Particle = {
  /** Centre, field px. */
  x: number;
  y: number;
  /** Radius, field px (at a 1080-wide composition). */
  r: number;
  opacity: number;
  color: string;
  /** Drawn above the letters (true) or below them. */
  front: boolean;
};

export type ParticleField = { kind: ParticleKind; width: number; height: number; margin: number; particles: Particle[] };

export type ParticleInput = {
  kind: ParticleKind;
  /** 0.2 to 2, default 1. */
  density?: number;
  seed?: number;
  timeMs: number;
  box: { width: number; height: number };
};

/** Particles at density 0.2 and at density 2 (dust carries half). */
export const PARTICLE_MIN = 40;
export const PARTICLE_MAX = 120;
/** The share of particles drawn in front of the letters. */
export const PARTICLE_FRONT_SHARE = 0.4;

/** How many particles a kind draws at a density. */
export function particleCount(kind: ParticleKind, density = 1): number {
  const d = Math.min(2, Math.max(0.2, density));
  const base = PARTICLE_MIN + ((PARTICLE_MAX - PARTICLE_MIN) * (d - 0.2)) / 1.8;
  return Math.round(kind === "dust" ? base / 2 : base);
}

/** The margin (px) around a box the particles may wander into: about half its height, at least 24, at most 240. */
export function particleMargin(box: { width: number; height: number }): number {
  return Math.round(Math.min(240, Math.max(24, box.height * 0.5, box.width * 0.06)));
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
  const d = Math.min(v, length - v) / (length * band);
  return Math.min(1, Math.max(0, d));
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mix(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0"));
  return `#${out.join("")}`;
}

/** The particles of one title on one frame. See the module comment. */
export function particleField(input: ParticleInput): ParticleField {
  const { kind, timeMs, box } = input;
  const seed = input.seed ?? 0;
  const margin = particleMargin(box);
  const W = Math.max(1, Math.round(box.width + margin * 2)), H = Math.max(1, Math.round(box.height + margin * 2));
  const t = timeMs / 1000;
  const count = particleCount(kind, input.density);
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const u = (slot: number) => hash01(seed, i, slot);
    const front = u(9) < PARTICLE_FRONT_SHARE;
    const phase = u(5) * Math.PI * 2;
    if (kind === "snow") {
      // Bigger flakes are nearer: they fall faster and sway wider (parallax).
      const size = u(2);
      const r = 1 + 2 * size;
      const vy = 45 + 75 * size;
      const vx = 8 + (u(3) - 0.5) * 24;
      const sway = (6 + 12 * size) * Math.sin(t * (0.6 + 0.8 * u(4)) + phase);
      const x = wrap(u(0) * W + vx * t + sway, W);
      const y = wrap(u(1) * H + vy * t, H);
      const opacity = (0.7 + 0.2 * u(6)) * edgeFade(x, W) * edgeFade(y, H);
      particles.push({ x, y, r, opacity, color: "#ffffff", front });
    } else if (kind === "embers") {
      const r = 0.75 + 1.25 * u(2);
      const vy = 30 + 50 * u(3);
      const x = wrap(u(0) * W + 10 * Math.sin(t * (1.2 + u(4)) + phase) + (u(6) - 0.5) * 12 * t, W);
      const y = H - wrap(u(1) * H + vy * t, H);
      const flicker = 0.65 + 0.35 * Math.sin(t * (6 + 8 * u(7)) + phase);
      // Rising from below, they die out over the top third of the field.
      const life = smoothstep(0, 0.35, y / H) * (1 - smoothstep(0.92, 1, y / H));
      particles.push({ x, y, r, opacity: flicker * life * edgeFade(x, W), color: mix("#ffb15c", "#ff6a2a", u(8)), front });
    } else {
      const r = 0.5 + u(2);
      const x = wrap(u(0) * W + (u(3) - 0.5) * 16 * t + 5 * Math.sin(t * 0.4 + phase), W);
      const y = wrap(u(1) * H + (u(4) - 0.5) * 12 * t + 4 * Math.cos(t * 0.3 + phase), H);
      const opacity = (0.12 + 0.18 * u(6)) * edgeFade(x, W) * edgeFade(y, H);
      particles.push({ x, y, r, opacity, color: "#f4efe6", front });
    }
  }
  return { kind, width: W, height: H, margin, particles };
}

const BLUR: Record<ParticleKind, number> = { snow: 0.8, embers: 0.6, dust: 0.9 };

/** One layer of a field as an SVG string. Numbers are rounded so the string is stable and short. */
export function particleSvg(field: ParticleField, layer: "front" | "back", id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  const circles = field.particles
    .filter((p) => p.front === (layer === "front") && p.opacity > 0.005)
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.r.toFixed(2)}" fill="${p.color}" fill-opacity="${p.opacity.toFixed(3)}"/>`)
    .join("");
  const w = field.width.toFixed(0), h = field.height.toFixed(0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><filter id="${safe}" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${BLUR[field.kind]}"/></filter></defs><g filter="url(#${safe})">${circles}</g></svg>`;
}
