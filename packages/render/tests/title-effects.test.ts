import { describe, expect, it } from "vitest";
import { EFFECT_FAMILIES, NAMED_EFFECTS, TEXT_ANIMATIONS } from "@reelwalk/core";
import { TEXT_ANIMATION_LABELS } from "../src/reel/look";
import { clipPathOf, effectEnterMs, EXIT_MS, isTitleEffect, seeded, seedOf, titleEffectFrame, wavePath, type EffectFrame } from "../src/reel/toolbox/title-effects";

// The sixteen title effects (ADR 0103), as frames: how each starts, that each comes to rest exactly as the plain title
// (no move, no clip, no decoration left over), that each is gone by the end, and that a title always draws the same.

const LIFE = 3000;
const text = "try this dot hop";
const input = (titleMs: number, lifeMs = LIFE) => ({ titleMs, lifeMs, chars: text.length, words: 4, seed: seedOf(text) });

/** Nothing about the frame differs from the plain title (an LED title stays LED, scrolled home). */
function atRest(f: EffectFrame) {
  expect(f.opacity).toBeCloseTo(1, 5);
  expect(f.textOpacity).toBeCloseTo(1, 5);
  expect([f.x, f.y, f.rotate, f.blur, f.pixelate, f.ledShift]).toEqual([0, 0, 0, 0, 0, 0].map((v, i) => (Object.is([f.x, f.y, f.rotate, f.blur, f.pixelate, f.ledShift][i], -0) ? -0 : v)));
  expect(f.scale).toBeCloseTo(1, 5);
  expect(f.scaleX).toBeCloseTo(1, 5);
  expect(f.scaleY).toBeCloseTo(1, 5);
  expect(clipPathOf(f.clip)).toBeUndefined();
  if (f.stroke) expect(f.stroke).toEqual({ draw: 1, fill: 1 });
  for (const part of [...(f.letters ?? []), ...(f.words ?? [])]) {
    expect(part.opacity).toBeCloseTo(1, 5);
    expect(Math.abs(part.x) + Math.abs(part.y)).toBeLessThan(1e-6);
    expect(part.scale).toBeCloseTo(1, 5);
  }
  for (const decor of f.decor) {
    if (decor.kind === "pixels") expect(decor.items.every((item) => item.opacity === 0)).toBe(true);
    else if (decor.kind === "dot") expect(decor.opacity === 0 || decor.r === 0).toBe(true);
    else expect(decor.opacity).toBe(0);
  }
}

describe("the effects are animations", () => {
  it("are listed in TEXT_ANIMATIONS, labelled, and in four families of four", () => {
    expect(TEXT_ANIMATIONS).toEqual(expect.arrayContaining([...NAMED_EFFECTS]));
    for (const effect of NAMED_EFFECTS) {
      expect(isTitleEffect(effect)).toBe(true);
      expect(TEXT_ANIMATION_LABELS[effect]).toMatch(/\w/);
    }
    expect(Object.values(EFFECT_FAMILIES).map((members) => members.length)).toEqual([4, 4, 4, 4]);
    expect(isTitleEffect("maskUp")).toBe(false);
  });
});

describe.each([...NAMED_EFFECTS])("%s", (effect) => {
  it("starts not yet in place", () => {
    const f = titleEffectFrame(effect, input(0));
    const hidden = f.opacity === 0 || f.textOpacity === 0 || clipPathOf(f.clip) !== undefined || f.x !== 0 || f.y !== 0 || f.scale !== 1 || f.pixelate > 0 || f.ledShift > 0 || (f.stroke?.draw ?? 1) < 1
      || (f.letters ?? []).some((p) => p.opacity < 1 || p.y !== 0 || p.scale !== 1) || (f.words ?? []).some((p) => p.opacity < 1 || p.y !== 0);
    expect(hidden).toBe(true);
  });

  it("comes to rest as the plain title, with nothing left over", () => {
    atRest(titleEffectFrame(effect, input(effectEnterMs(effect, text.length, 4) + 600)));
  });

  it("is gone at the end of the title, fading over the last 180 ms", () => {
    expect(titleEffectFrame(effect, input(LIFE)).opacity).toBe(0);
    expect(titleEffectFrame(effect, input(LIFE - EXIT_MS / 2)).opacity).toBeCloseTo(0.5, 1);
  });

  it("draws the same frame every time", () => {
    expect(titleEffectFrame(effect, input(333))).toEqual(titleEffectFrame(effect, input(333)));
  });

  it("speeds up to finish inside a short title, before its exit", () => {
    const short = 800;
    atRest(titleEffectFrame(effect, { ...input(short * 0.75), lifeMs: short }));
  });
});

describe("particular moves", () => {
  it("dot hop shows the letters in order behind the dot", () => {
    const f = titleEffectFrame("dotHop", input(300));
    const shown = f.letters!.map((p) => p.opacity > 0);
    expect(shown.indexOf(false)).toBeGreaterThan(0);
    expect(shown.slice(shown.indexOf(false)).every((v) => !v)).toBe(true);
  });
  it("the slingshot overshoots once", () => {
    const xs = Array.from({ length: 60 }, (_, i) => titleEffectFrame("slingshot", input(260 + i * 8)).x);
    expect(Math.max(...xs)).toBeGreaterThan(0.05);
  });
  it("sticker words arrive one after another", () => {
    const f = titleEffectFrame("stickerStack", input(230));
    expect(f.stickers).toBe(true);
    expect(f.words!.map((p) => p.opacity)).toEqual([1, 1, 0, 0]);
  });
  it("shows the swarm, the slingshot's dot and the ring while the words are still hidden", () => {
    const swarm = titleEffectFrame("pixelSwarm", input(100));
    expect(swarm.opacity).toBe(1);
    expect(swarm.textOpacity).toBe(0);
    expect(swarm.decor[0]).toMatchObject({ kind: "pixels" });
    expect(titleEffectFrame("slingshot", input(100))).toMatchObject({ opacity: 1, textOpacity: 0 });
  });
  it("puts the scrub line under the last line of a wrapped title", () => {
    const one = titleEffectFrame("timelineScrub", input(300)).decor[0] as { y: number };
    const two = titleEffectFrame("timelineScrub", { ...input(300), heightEm: 2.3 }).decor[0] as { y: number };
    expect(two.y - one.y).toBeCloseTo(0.575, 3);
  });
  it("the slam trails ghosts before the hit and shakes after it", () => {
    expect(titleEffectFrame("oneBigSlam", input(60)).decor.filter((d) => d.kind === "ghost")).toHaveLength(2);
    expect(titleEffectFrame("oneBigSlam", input(60)).scale).toBeGreaterThan(2);
    expect(titleEffectFrame("oneBigSlam", input(250)).decor).toHaveLength(0);
  });
  it("the heavy landing squashes when it lands", () => {
    const f = titleEffectFrame("heavyLanding", input(650 * 0.6));
    expect(f.scaleY).toBeLessThan(1);
    expect(f.scaleX).toBeGreaterThan(1);
  });
  it("pixel rain builds the word up from the bottom", () => {
    expect(titleEffectFrame("pixelRain", input(500)).clip.top).toBeGreaterThan(0);
    expect(titleEffectFrame("pixelRain", input(500)).clip.bottom).toBe(0);
  });
  it("the mosaic sharpens as it resolves", () => {
    const blocks = [0, 200, 400, 700].map((ms) => titleEffectFrame("mosaicResolve", input(ms)).pixelate);
    expect(blocks[0]).toBeGreaterThan(blocks[1]);
    expect(blocks[1]).toBeGreaterThan(blocks[2]);
  });
  it("the LED scoreboard scrolls in from the right and stays LED", () => {
    expect(titleEffectFrame("ledScoreboard", input(0)).ledShift).toBe(1);
    expect(titleEffectFrame("ledScoreboard", input(2000))).toMatchObject({ led: true, ledShift: 0 });
  });
});

describe("helpers", () => {
  it("scatters the same way for the same words and differently for others", () => {
    expect(seeded(seedOf("a"), 3)).toBe(seeded(seedOf("a"), 3));
    expect(seeded(seedOf("a"), 3)).not.toBe(seeded(seedOf("b"), 3));
    for (let i = 0; i < 50; i++) { const v = seeded(7, i); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
  it("clips generously outside the box and not at all when nothing is clipped", () => {
    expect(clipPathOf({ top: 0, right: 0.25, bottom: 0, left: 0 })).toBe("inset(-50% 25.00% -50% -50%)");
    expect(clipPathOf({ top: 0, right: 0, bottom: 0, left: 0 })).toBeUndefined();
  });
  it("draws a string fixed at both ends", () => {
    expect(wavePath(0, 100, 10, 0, 0)).toBe("M 0.0 10.0 L 100.0 10.0");
    const path = wavePath(0, 100, 10, 8, 1);
    expect(path.startsWith("M 0.0 10.0")).toBe(true);
    expect(path.endsWith("L 100.0 10.0")).toBe(true);
  });
});
