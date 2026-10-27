# 0091 - Inverted titles

Date: 2026-10-27

## Context

The owner sent a sixth reference reel (Instagram `DZWLhE3uEhO`, a realtor's talking-head reel) and asked for its style,
adding: "Pay attention to the color of the fonts, sometimes it's like an inverted color thing." The reel was measured
frame by frame (ReelWalk-hybrid `output/ref-DZWLhE3uEhO/report.md`). Its big keywords ("buyer", "agent", "bachelors",
"dollar") are one pale-yellow ink whose colour depends on the picture behind each letter:

- "dollar" at 26.1 s: the "d" over a dark column is bright yellow (215, 214, 126), "ollar" over the window is dark brown
  (91, 82, 53), and the split runs through the "o" exactly on the column's edge. After a push-in the whole word is over
  the window and all brown, except gold stripes where the dark mullions pass behind it.
- Fitted against a background plate from the frames before the word arrives, the letters' colour falls as the
  background brightens in every channel. A tinted negative, letters = ink × (1 − s · picture) with ink ≈ #f2ef9c and
  s ≈ 0.75, fits best. Difference and exclusion fit almost as well; an opaque fill fits far worse (RMSE 49 vs 73 / 255).
- The small companion words ("single", "your") are plain white, not inverted.

The house rule is white text unless the background is truly white (taste verdict 2026-10-26); the owner names this
inverted look as the explicit exception. Titles could already meet the picture two ways, `blend: "plain"` (on top) and
`"surface"` (hard-light paint, ADR 0039). Nothing could make letters that are light on dark and dark on light within one
word.

## Decision

**`blend: "invert"`** on a title, additive to the existing enum (`packages/core/src/timeline.ts`). The letters show the
picture behind them as a negative, tinted with the title's `color`:

- **Renderer** (`packages/render/src/reel/look.ts` `invertLayers`, `ReelComposition.tsx` `TextView`): the same letters
  are drawn once per pass, each pass blending with everything already drawn under it. Pass 1 is white with
  `mix-blend-mode: difference`, which gives 1 − picture, a true negative. Pass 2, only when the colour is not white or the
  title has a gradient or picture fill (ADR 0089), is the colour or fill with `mix-blend-mode: multiply`, which gives
  colour × (1 − picture). Pale yellow then gives yellow on dark and brown on a window. Neither pass draws a shadow,
  stroke, plate or the fill's drop shadow: under a difference a shadow is invisible, and under a multiply it would darken
  the negative. Screen titles and surface-placed titles both use it. Particles, flares and callout lines are drawn once.
  A single CSS `difference` with a yellow ink would give |ink − picture|, which is navy over a white window, not the
  reference's brown, so the tint is a separate pass.
- **Preview = export.** Both are the one `ReelComposition` drawn by Chrome, and the passes are siblings in the title's
  `AbsoluteFill`, which forms no stacking context. They blend with the footage the same way the existing `surface`
  hard-light does.
- **Critic** (`critic.ts`): an inverted title has no colour of its own, so legibility judges the negative of the
  picture's darkest and brightest tenth, each against itself (`invertedInkLuminance`: negated in sRGB as CSS does, times
  the tint's luminance). It does not use the mean: a word across a dark wall and a bright window, the intended case,
  averages to a grey that is not there. A real mid-tone is the weak spot, where the negative is the same grey. The fix
  offered there is "On top, not inverted" (`blend: "plain"`). The box, outline, strong-shadow and extrusion exemptions do
  not apply to an inverted title, because it is drawn without them.
- **Finishes** (ADR 0064) leave an inverted title alone: a finish's colour would change the tint.
- **Editor**: a third option, "Inverts the picture", on the title sheet's existing "Meets the picture" control.
- **Agents** set it with `updateText` / `addText` (`{ blend: "invert", color: "#ffffff" }`) through `/api/reels/:id/commands`
  or the MCP's `apply_commands`. No new command is needed.

Not done: the reference's partial strength (s ≈ 0.75). Ours is a full negative. A `strength` could be added later as
the negative pass's opacity if the owner wants it softer.

## Consequences

- Saved reels are unchanged: `blend` absent or `plain`/`surface` render exactly as before (a single pass with an empty
  override).
- An inverted title over mid-grey footage disappears, which is inherent to the look. The critic flags it, so place
  these words over clearly light or dark areas (a window, a dark wall), as the reference does.
- Two passes for coloured titles double the letters' layout and paint cost for those titles only.

## Verified

- Unit tests: `packages/render/tests/invert-blend.test.ts` (passes, tint and fill handling, the filter is cleared and not
  set to `none` so RevealFace's blur still composes, and the schema accepts `invert`, keeps old titles and rejects
  unknown modes); critic tests (fine on dark, bright and a dark/bright split, flagged on mid-grey with the "On top, not inverted"
  fix even with a strong shadow, outline, box or extrusion, ink maths); finishes test.
- Real renderer: `packages/render/scripts/invert-stills.ts` renders "dollar" with `renderReelStills` over a picture
  with a dark wall (22, 34, 34), a bright window (228, 236, 236) and a dark mullion
  (`docs/adr/assets/0091-invert-proof.jpg`). Measured letter colours: white inverted gives (230, 218, 218) on the wall
  and (32, 24, 24) on the window, the exact negative up to anti-aliasing. #f2ef9c inverted gives (218, 204, 134) on the
  wall and (31, 23, 16) on the window, the predicted colour × (1 − picture). A plain white title over the window is
  invisible there.
