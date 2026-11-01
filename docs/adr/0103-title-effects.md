# 0103 — The sixteen title effects

Date: 2026-11-01

## Context

The first style reference (ADR 0102, "16 ways to hook viewers with a title") demonstrates sixteen title effects in four
families. None of them was drawable in ReelWalk, so a recipe read from that reel listed every one as a gap and a reel
following it could only use the nearest fade, rise or blur. The owner wants the effects built in first, then a reel
showing them.

## Decision

The sixteen effects are **title animations**, values of `TEXT_ANIMATIONS` like `pop` or `blurQuick`, so they go wherever
an animation already goes: the timeline schema, `applyTextStyle` and `updateText` commands, kit styles, the editor and
the connector. The names are listed once, in `packages/core/src/title-effects.ts` (`NAMED_EFFECTS`, `EFFECT_FAMILIES`,
`EFFECT_NOTES`). The style recipe reads them from there, so it now counts them as supported and only `other` is a gap.

| Family | Effects |
| --- | --- |
| Dots | `dotHop` (a dot hops along, letters appear behind it), `rollout` (a dot rolls in, the word unrolls from it), `slingshot` (a dot is drawn back and slings the word in), `splits` (three dots spread and become the word) |
| Line art | `timelineScrub` (a playhead scrubs a line, revealing the word), `tracedOutline` (the outline is traced, then fills), `orbitRing` (a ring orbits, the word settles inside), `pluckedString` (a line vibrates, the word opens out of it) |
| Drop-ins | `stickerStack` (each word drops in on its own label), `oneBigSlam` (a huge word slams down with trails and a shake), `tumblingLetters` (letters fall and turn into place), `heavyLanding` (the word drops and squashes) |
| Pixels | `pixelSwarm` (particles converge into the word), `pixelRain` (pixels fall, the word builds from the bottom), `mosaicResolve` (mosaic blocks sharpen into the word), `ledScoreboard` (an LED dot-matrix scrolls in) |

- **Pure frame functions.** `titleEffectFrame(effect, { titleMs, lifeMs, chars, words, seed, heightEm })`
  (`packages/render/src/reel/toolbox/title-effects.ts`) returns everything about one frame:
  - the whole title's opacity and move, and the words' own opacity (`textOpacity`), so dots, rings and swarms show
    before the words do;
  - a clip, blur, mosaic block size, LED shift and outline progress;
  - per-letter or per-word moves;
  - decorations (dots, lines, rings, motion-trail ghosts, pixels).

  Lengths are in em and box fractions, so an effect scales with the type. Scatter is seeded from the text, so the
  editor's Player and the worker's export draw the same frame. The functions are tested without a browser (94 tests):
  every effect starts hidden or out of place, rests exactly, and is gone at the end of the title.
- **Timing.** Each effect has its own entrance (420 ms for the slam, up to 1.1 s for the traced outline; stickers and
  tumbling letters stagger by word or letter). The entrance never takes more than half the title: a short title plays it
  on a faster clock. Every effect leaves with a 180 ms fade, so the title is gone on the cut it is held to.
- **Drawing.** `TitleEffect.tsx` draws the title in its own style (font, colour, shadow, kit style), then:
  - decorations in an SVG laid over the text box, sized to the widest wrapped line and placed from the number of lines;
  - the mosaic as an SVG flood, tile and dilate filter;
  - the LED as the type seen through a mask of round holes, with a glow in its own colour;
  - the traced outline as a stroked copy and a filled copy in one grid cell, so they wrap alike;
  - stickers on plates in the title colour, with black or white ink, whichever reads.

  `ReelComposition` uses it for screen titles. A title placed on a surface (ADR 0082's perspective plane) cuts in, as a
  reveal there would.
- **Editor.** The Arrives control keeps the plain animations. An Effect menu next to it lists the sixteen, grouped by
  family.
- **Checked on real footage.** `packages/render/scripts/title-effect-stills.ts <out>` renders each effect as a 2 s shot
  over stock footage and writes one contact sheet per family (frames 2, 6, 10, 15, 21, 45). These sheets were used to
  check every effect while building it.

## Not in this step

1. Follow this style on Create (ADR 0102's next step): a create run that reads a recipe can now place the reference's
   own effects instead of the nearest one.
2. A reel that shows the sixteen, built in ReelWalk.
3. Effects on surface titles and on kinetic (word-by-word) captions.
