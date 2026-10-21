import { describe, expect, it } from "vitest";
import {
  parseTimeline, particleCount, particleField, particleSvg, passOpacity, PASS_FADE_MS, personLayerOpacity, sceneLayers, stackTitles,
  type ParticleKind, type Timeline,
} from "../src";

const FPS = 30;

function reel(texts: unknown[]): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "c1", assetId: "walk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2500 },
      { id: "c2", assetId: "room", kind: "VIDEO", sourceStartMs: 200, sourceEndMs: 2600 },
      { id: "c3", assetId: "photo", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2000 },
    ],
    texts,
    music: null,
  });
}

describe("passOpacity (ADR 0055)", () => {
  const text = { behind: true, passMs: 1000 };

  it("hides the presenter before the crossing and shows her fully after it", () => {
    expect(passOpacity(text, 0)).toBe(0);
    expect(passOpacity(text, 999)).toBe(0);
    expect(passOpacity(text, 1000)).toBe(0);
    expect(passOpacity(text, 1000 + PASS_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(passOpacity(text, 1000 + PASS_FADE_MS)).toBe(1);
    expect(passOpacity(text, 5000)).toBe(1);
  });

  it("ramps over 160 ms by default and over passFadeMs when set", () => {
    expect(PASS_FADE_MS).toBe(160);
    expect(passOpacity(text, 1080)).toBeCloseTo(0.5);
    expect(passOpacity({ ...text, passFadeMs: 400 }, 1100)).toBeCloseTo(0.25);
    expect(passOpacity({ ...text, passFadeMs: 0 }, 999)).toBe(0);
    expect(passOpacity({ ...text, passFadeMs: 0 }, 1000)).toBe(1);
  });

  it("is 1 without passMs, and passMs is ignored on a title that is not behind", () => {
    expect(passOpacity({ behind: true }, 0)).toBe(1);
    expect(passOpacity({ behind: false, passMs: 1000 }, 0)).toBe(1);
    expect(passOpacity({ passMs: 1000 }, 0)).toBe(1);
  });

  it("keeps a saved reel without the new fields valid and unchanged", () => {
    const t = reel([{ id: "w", text: "WELCOME", startMs: 0, endMs: 2000, behind: true }]);
    expect(t.texts[0]).not.toHaveProperty("passMs");
    expect(t.texts[0]).not.toHaveProperty("particles");
  });
});

describe("sceneLayers with a passing title", () => {
  const ids = (t: Timeline) => sceneLayers(t, FPS).map((l) => l.kind === "title" ? `title:${l.text.id}` : l.kind === "person" ? `person:${l.clipIndex}${l.pass ? `:${l.pass.textId}` : ""}` : `object:${l.text.id}:${l.clipIndex}`);

  it("carries pass only when passMs is set", () => {
    const plain = sceneLayers(reel([{ id: "w", text: "WELCOME", startMs: 0, endMs: 2000, behind: true }]), FPS);
    const person = plain.find((l) => l.kind === "person");
    expect(person).toBeDefined();
    expect(person && "pass" in person ? person.pass : undefined).toBeUndefined();
    expect(personLayerOpacity(person!, 0, FPS)).toBe(1);

    const passing = sceneLayers(reel([{ id: "w", text: "WELCOME", startMs: 0, endMs: 2000, behind: true, passMs: 1000 }]), FPS);
    const own = passing.filter((l) => l.kind === "person");
    expect(own).toHaveLength(1);
    expect(own[0].kind === "person" && own[0].pass).toEqual({ textId: "w", fromFrame: 0, toFrame: 60, passMs: 1000, passFadeMs: 160 });
  });

  it("fades the presenter in at the crossing and never shows her outside the title's window", () => {
    const layer = sceneLayers(reel([{ id: "w", text: "WELCOME", startMs: 500, endMs: 2000, behind: true, passMs: 1000, passFadeMs: 200 }]), FPS).find((l) => l.kind === "person")!;
    expect(personLayerOpacity(layer, 0, FPS)).toBe(0); // before the title
    expect(personLayerOpacity(layer, 20, FPS)).toBe(0); // 667 ms, before the crossing
    expect(personLayerOpacity(layer, 33, FPS)).toBeCloseTo(0.5); // 1100 ms
    expect(personLayerOpacity(layer, 45, FPS)).toBe(1); // 1500 ms
    expect(personLayerOpacity(layer, 60, FPS)).toBe(0); // the title is gone
  });

  it("draws a passing title above the shared presenter and its own presenter above it", () => {
    const t = reel([
      { id: "a", text: "A", startMs: 0, endMs: 2000, behind: true },
      { id: "p", text: "COME IN", startMs: 0, endMs: 2000, behind: true, passMs: 1200, occluders: [{ x: 0.5, y: 0.5 }] },
      { id: "cap", text: "Caption", startMs: 0, endMs: 2000 },
    ]);
    expect(ids(t)).toEqual(["title:a", "person:0", "title:p", "object:p:0", "person:0:p", "title:cap"]);
    expect(stackTitles(t.texts).map((text) => text.id)).toEqual(["a", "p", "cap"]);
  });

  it("mounts no shared matte for a clip whose only behind title passes", () => {
    const t = reel([{ id: "p", text: "COME IN", startMs: 0, endMs: 3000, behind: true, passMs: 1200 }]);
    expect(ids(t)).toEqual(["title:p", "person:0:p", "person:1:p"]);
  });

  it("leaves a title that is not behind alone even with passMs", () => {
    const t = reel([{ id: "x", text: "X", startMs: 0, endMs: 2000, passMs: 1000 }]);
    expect(ids(t)).toEqual(["title:x"]);
  });
});

describe("particleField (ADR 0055)", () => {
  const box = { width: 800, height: 220 };
  const kinds: ParticleKind[] = ["snow", "embers", "dust"];

  it("is a pure function of the frame: same time, same string; another time or seed, another string", () => {
    for (const kind of kinds) {
      const a = particleSvg(particleField({ kind, timeMs: 1234, box }), "back", "t");
      expect(particleSvg(particleField({ kind, timeMs: 1234, box }), "back", "t")).toBe(a);
      expect(particleSvg(particleField({ kind, timeMs: 1267, box }), "back", "t")).not.toBe(a);
      expect(particleSvg(particleField({ kind, timeMs: 1234, box, seed: 7 }), "back", "t")).not.toBe(a);
    }
  });

  it("keeps every particle inside the box and its margins, over a long run", () => {
    for (const kind of kinds) {
      for (let ms = 0; ms < 60_000; ms += 997) {
        const field = particleField({ kind, timeMs: ms, box, density: 2, seed: 3 });
        expect(field.width).toBe(box.width + field.marginX * 2);
        expect(field.height).toBe(box.height + field.marginY * 2);
        for (const p of field.particles) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(field.width);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(field.height);
          expect(p.opacity).toBeGreaterThanOrEqual(0);
          expect(p.opacity).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("gives the box a 30% margin", () => {
    const field = particleField({ kind: "snow", timeMs: 0, box: { width: 600, height: 300 } });
    expect(field.marginX).toBe(180);
    expect(field.marginY).toBe(150);
  });

  it("draws about 70 snow, 50 embers and 35 dust at Medium, 1.8× at Thick", () => {
    expect(particleCount("snow", 1)).toBe(70);
    expect(particleCount("embers", 1)).toBe(50);
    expect(particleCount("dust", 1)).toBe(35);
    expect(particleCount("snow", 1.8)).toBe(126);
    expect(particleCount("snow", 5)).toBe(140);
    for (const density of [0.5, 1, 1.8]) expect(particleField({ kind: "embers", timeMs: 0, box, density }).particles).toHaveLength(particleCount("embers", density));
  });

  it("puts near particles in front of the letters and far ones behind, each keeping its side", () => {
    for (const kind of kinds) {
      const a = particleField({ kind, timeMs: 0, box, density: 2 });
      const b = particleField({ kind, timeMs: 5000, box, density: 2 });
      expect(a.particles.filter((p) => p.band === "near").every((p) => p.front && p.depth > 0.7)).toBe(true);
      expect(a.particles.filter((p) => p.band === "far").every((p) => !p.front && p.depth < 0.35)).toBe(true);
      const mid = a.particles.filter((p) => p.band === "mid");
      expect(mid.some((p) => p.front) && mid.some((p) => !p.front)).toBe(true);
      expect(b.particles.map((p) => p.front)).toEqual(a.particles.map((p) => p.front));
    }
  });

  it("sizes, softens and colours each kind by depth", () => {
    const snow = particleField({ kind: "snow", timeMs: 900, box, density: 2 }).particles;
    const near = snow.filter((p) => p.band === "near"), far = snow.filter((p) => p.band === "far"), mid = snow.filter((p) => p.band === "mid");
    expect(near.every((p) => p.ry >= 3.5 && p.ry <= 7 && p.shadow)).toBe(true);
    expect(mid.every((p) => p.ry >= 1.5 && p.ry <= 3 && !p.shadow)).toBe(true);
    expect(far.every((p) => p.ry >= 0.75 && p.ry <= 1.5 && p.opacity <= 0.45)).toBe(true);
    expect(snow.every((p) => Math.abs(p.rx / p.ry - 1.3) < 1e-9)).toBe(true);
    const embers = particleField({ kind: "embers", timeMs: 900, box, density: 2 }).particles;
    expect(embers.filter((p) => p.band === "near").every((p) => p.rx >= 2 && p.rx <= 3.5 && p.halo && p.halo.r >= 4 && p.halo.r <= 6)).toBe(true);
    expect(new Set(embers.map((p) => p.color)).size).toBeGreaterThan(5);
    const dust = particleField({ kind: "dust", timeMs: 900, box, density: 2 }).particles;
    expect(dust.every((p) => p.rx >= 1.5 && p.rx <= 3 && p.opacity <= 0.5 && p.color === "#fff4dc")).toBe(true);
  });

  it("moves snow down at 25–45 px/s and embers up", () => {
    const at = (kind: ParticleKind, ms: number) => particleField({ kind, timeMs: ms, box, seed: 1 }).particles;
    const dy = (kind: ParticleKind) => {
      const a = at(kind, 1000), b = at(kind, 1100);
      // Only particles that did not wrap or respawn in the 100 ms.
      const moves = a.map((p, i) => b[i].y - p.y).filter((d) => Math.abs(d) < 20);
      return moves.reduce((s, d) => s + d, 0) / moves.length;
    };
    expect(dy("snow")).toBeGreaterThan(2.5);
    expect(dy("snow")).toBeLessThan(4.5);
    expect(dy("embers")).toBeLessThan(-2);
  });

  it("lets an ember live 1.5–3 s: it fades in, fades out and is born again elsewhere", () => {
    const series = Array.from({ length: 120 }, (_, k) => particleField({ kind: "embers", timeMs: k * 50, box, seed: 2 }).particles[0]);
    const opacities = series.map((p) => p.opacity);
    expect(Math.min(...opacities)).toBeLessThan(0.05);
    expect(Math.max(...opacities)).toBeGreaterThan(0.3);
    expect(new Set(series.map((p) => Math.round(p.x / 40))).size).toBeGreaterThan(1);
  });

  it("splits embers into a normal pass (halos) and a screen pass (sparks); snow has no screen pass", () => {
    const field = particleField({ kind: "embers", timeMs: 1500, box, density: 2 });
    expect(particleSvg(field, "front", "e", "normal")).toContain("e-halo");
    expect(particleSvg(field, "front", "e", "screen")).not.toContain("e-halo");
    const snow = particleField({ kind: "snow", timeMs: 1500, box, density: 2 });
    expect(particleSvg(snow, "front", "s", "screen")).not.toContain("<ellipse");
    expect(particleSvg(snow, "front", "s", "normal")).toContain("#1a2a3a");
  });

  it("snapshots one frame of each kind", () => {
    for (const kind of kinds) {
      const field = particleField({ kind, timeMs: 2000, box: { width: 300, height: 80 }, density: 0.2, seed: 42 });
      const passes = (["back", "front"] as const).flatMap((layer) => (["normal", "screen"] as const).map((blend) => particleSvg(field, layer, `title-${kind}`, blend)));
      expect(passes.join("\n")).toMatchSnapshot(kind);
    }
  });
});
