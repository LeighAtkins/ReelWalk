# Brand: the ivory R

Decided 2026-10-13, replacing the blueprint look described in
`landing-references.md`. The identity is the @reelwalking profile mark: a
Bodoni Moda capital R in ivory on black, whose stem is a strip of film that
spools out along the baseline and whose leg ends in a riding boot. Everything
in the product follows from that one letter: the colours are the letter's,
the display face is the letter's, and the audience is the one the letter
speaks to, US real-estate photographers and the agents who pay them for
luxury listing reels.

## Tokens

| Name | Hex | Role |
|---|---|---|
| Noir | `#0a0a0a` | ground, the mark's own black |
| Soot | `#151412` | bars, sheets, sunken cards |
| Umber | `#262320` | raised controls, pressed tools |
| Ivory | `#f3ede2` | text, primary buttons, the mark |
| Stone | `#a89f93` | secondary text |
| Lacquer | `#c1272d` | the one colour: playhead, selection, Export |

Lines are ivory at 12% and 28%. The greys are warm (a touch of red and
yellow) so that nothing on screen reads blue; the old navy is gone entirely.
`--ok` and `--warn` survive for status badges only.

## Type

- **Bodoni Moda Variable** (optical size 6–96, weight 400–900) for display:
  the wordmark, h1 and h2, plan names and prices, the step figures. Weight 500
  at display sizes, optical size pinned to 96 so the hairlines stay thin;
  weight 600 and optical size 48 in the app's 22–32px headings. Tracking is
  zero or a hair negative (−0.01em); Bodoni does not want to be squeezed.
- **Archivo Variable** at normal width for everything else: body, UI,
  buttons, labels. Weights 400 (body), 500 (UI), 600 (buttons, h3). The width
  axis is no longer used for voice; `.timecode` keeps 75% because narrow
  tabular figures are a legibility choice, not a style.
- Body 16/1.5, measure under 34em. Serif display lines get line-height 1.0.

## Layout

The landing page reads like a magazine spread, not a SaaS hero: the headline
runs full width in Bodoni at up to 96px, and beneath it the lede and buttons
sit left while the three finished reels stand right in black frames, the way
they appear on the Instagram grid. Left-aligned throughout. Sections are
divided by a single hairline; the walkthrough keeps its figures because the
four screens really are a sequence, drawn as Bodoni numerals rather than red
badges. Only the plans are cards.

```
R ReelWalk                         Plans   Sign in   (Start free)
────────────────────────────────────────────────────────────────
Listing reels,
made between shoots.
                               ┌────┐  ┌────┐  ┌────┐
lede, 34em                     │    │  │    │  │    │
(Start free, no card)          │    │  │    │  │    │
See a finished reel            └────┘  └────┘  └────┘
────────────────────────────────────────────────────────────────
How it works      1 Pick the listing's photos …      [screen]
```

## Principles

1. The letter does the talking. One display face set large and left, ivory
   on noir, with nothing behind it: no glow, no gradient, no grid.
2. Colour means something. Lacquer appears only where the app is live or
   about to spend something: the playhead, the selected clip, Export, the
   record dot. The primary button is ivory.
3. Elevation by lightness. Surfaces step from noir to soot to umber; edges
   are ivory hairlines; the only shadow is the one under a phone.
4. Show the work. Real rooms, finished reels, the app's own screens.

## What was rejected on the way

- Keeping the red CTA: on black it read as an alarm, not an invitation.
- A brass or gold accent: the luxury cliché, and it fights lacquer.
- Sprocket-hole rules between sections: one motif, used once, in the mark.
- Tight negative tracking on Bodoni: it closes the hairline counters.
