/**
 * The sixteen title effects (ADR 0103), in four families of four, read off the owner's style reference of 2026-10-31
 * ("16 ways to hook viewers with a title", ADR 0102). They are TEXT_ANIMATIONS like any other: a title arrives with one,
 * drawn by @reelwalk/render (toolbox/title-effects.ts) the same in the editor and the export.
 *
 * Kept free of imports so timeline.ts can list them without a cycle.
 */
export const NAMED_EFFECTS = [
  "dotHop", "rollout", "slingshot", "splits",
  "timelineScrub", "tracedOutline", "orbitRing", "pluckedString",
  "stickerStack", "oneBigSlam", "tumblingLetters", "heavyLanding",
  "pixelSwarm", "pixelRain", "mosaicResolve", "ledScoreboard",
] as const;
export type NamedEffect = (typeof NAMED_EFFECTS)[number];

export const EFFECT_FAMILIES = {
  dots: ["dotHop", "rollout", "slingshot", "splits"],
  lineArt: ["timelineScrub", "tracedOutline", "orbitRing", "pluckedString"],
  dropIns: ["stickerStack", "oneBigSlam", "tumblingLetters", "heavyLanding"],
  pixels: ["pixelSwarm", "pixelRain", "mosaicResolve", "ledScoreboard"],
} as const satisfies Record<string, readonly NamedEffect[]>;
export type EffectFamily = keyof typeof EFFECT_FAMILIES;

export const EFFECT_FAMILY_LABELS: Record<EffectFamily, string> = { dots: "Dots", lineArt: "Line art", dropIns: "Drop-ins", pixels: "Pixels" };

/** What each effect is, in a line: used in prompts, the recipe page and the editor. */
export const EFFECT_NOTES: Record<NamedEffect, string> = {
  dotHop: "a dot hops along the line and the word appears behind it",
  rollout: "a dot rolls in and the word unrolls from it",
  slingshot: "a dot slings the word in from the side with an overshoot",
  splits: "three dots split apart and become the word",
  timelineScrub: "a thin line scrubs across and reveals the word as it passes",
  tracedOutline: "the word's outline is drawn as a stroke, then fills",
  orbitRing: "a ring orbits the line, then the word settles inside it",
  pluckedString: "a line vibrates like a plucked string, then resolves into the word",
  stickerStack: "each word drops in on its own label sticker, stacking up",
  oneBigSlam: "one huge word slams down with motion trails and a hit",
  tumblingLetters: "the letters fall and rotate into place one by one",
  heavyLanding: "the word drops from above and lands with a squash",
  pixelSwarm: "particles swarm in and converge into the word",
  pixelRain: "pixels rain down and stack into the word",
  mosaicResolve: "chunky mosaic blocks resolve into the sharp word",
  ledScoreboard: "the word scrolls in as an LED dot-matrix",
};

export function isNamedEffect(value: string): value is NamedEffect {
  return (NAMED_EFFECTS as readonly string[]).includes(value);
}

/** The family an effect belongs to, or null for any other animation. */
export function effectFamilyOf(value: string): EffectFamily | null {
  for (const [family, members] of Object.entries(EFFECT_FAMILIES) as [EffectFamily, readonly string[]][]) if (members.includes(value)) return family;
  return null;
}
