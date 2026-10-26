# 0083 - Remotion's own primitives for cuts, text, fonts and colour

Date: 2026-10-26

## Context

The owner: "we're not hitting the aesthetic ceiling at all, everything so far is below standard, so if Remotion built
it already we should use that instead." The render package (`packages/render/src/reel`) hand-rolled what Remotion now
ships: clip-level fades and whips inside each clip's sequence (`presentation.ts`, `whip.ts`), title layout from a span
or from estimated glyph widths (`measure.ts` falling back to `estimateLineWidth`), a font hold of our own
(`fonts.ts`) and CSS filter presets (`look.ts`). It depended only on `remotion`, `@remotion/media`, `@remotion/renderer`
and `@remotion/bundler` at 4.0.534.

The same comparison reel rendered before the change (`packages/render/scripts/primitives-fixture.ts`; six Pexels
snow-lodge clips) showed the defects plainly: a one-word title ran off both edges and broke inside the word
("xtraordinaril / Magnificent"); a 24-character price wrapped to three lines in the card; the serif hook drew in Georgia.

## Decision

### Versions and skills

- `remotion` and every `@remotion/*` package move together to **4.0.538**, the current 4.0.x (`npm view remotion
  version`), in the render package, the web app and the old editor; `mediabunny` to 1.62.0 as `@remotion/studio@4.0.538`
  lists. `zod` stays at 4.6.7, newer than studio's 4.5.4 and pinned by the root override.
- New render dependencies, all 4.0.538: `@remotion/transitions`, `@remotion/layout-utils`, `@remotion/motion-blur`,
  `@remotion/effects`, `@remotion/fonts`; and `@fontsource-variable/playfair-display` 5.3.0 (OFL 1.1).
- Remotion's agent skills (`npx skills add remotion-dev/skills -a claude-code --copy`) are committed under
  `.claude/skills/remotion-*`, so later agents follow Remotion's own rules. ESLint ignores `.claude/**` (the skills'
  example components are documentation, not our code). `skills-lock.json` is gitignored by the repo and not committed.

### Transitions: every cut is a TransitionSeries join (`transition-plan.ts`, `transitions.tsx`)

The clips are now a `<TransitionSeries>`. The schema's kinds map as follows (unchanged schema, unchanged commands):

| kind        | drawn as                                                                                          |
|-------------|---------------------------------------------------------------------------------------------------|
| `cut`       | adjacent sequences, no transition                                                                 |
| `fade`      | Remotion `fade()`, 10 frames at 30 fps, `Easing.inOut(quad)`: a crossfade (it was a dip to black) |
| `whip`      | `whipPan`, our presentation on `whip.ts`'s geometry, 8 frames, `Easing.inOut(cubic)`              |
| `walk`      | no transition (the 360 walk is drawn inside the incoming clip)                                    |
| `speedRamp` | no transition (its push and blur follow the speed plan inside both clips, ADR 0073/0074)          |

The reel's opening shot with `transitionIn: "fade"` still fades up from black inside its clip (there is nothing to
cross from). Durations follow the transitions skill: about a third of a second, capped at 12 frames' worth at 30 fps.

**Timing is unchanged.** A Remotion transition overlaps two sequences and shortens the timeline, which would move every
later title, beat and sound. So each transition is centred on its saved cut: the outgoing sequence runs `after` frames
past the cut and the incoming one starts `before` frames early (`clipSpans`), lengthening the sequences by exactly what
the overlap takes back. The total length and every cut frame are unchanged (tested), and the transition's midpoint
lands on the cut, as the old whip's did (4 frames out, 4 in). Each half takes at most half of the clip on its side, so a
clip's two transitions never overlap and Remotion's "a transition is no longer than its sequences" always holds; a
transition next to a clip too short for it shrinks or becomes a cut.

**Handles.** The extra frames are real footage where the source reaches that far (`mediaHandles`: a plain video whose
source starts late enough and runs long enough), and otherwise the clip's first or last frame held with `<Freeze>`
(photos, clips starting at 0, ramped or speed-planned clips, which must keep their own media windows). Freeze is toggled
with `active`, never added or removed, so a handle never remounts the video. The handles are silent: a clip's own sound
and its J-cut audio still cut on the saved frame.

**Mattes.** The person and object mattes are drawn above the titles, outside the series. `AtCuts` wraps each in the
same presentation at the same progress for the halves of its clip's transitions inside the clip's saved span, so a
person stays on their own body through a crossfade or a whip. Both sides are always wrapped (at rest outside their
window), so a matte's canvas never remounts.

**Why the whip stays ours.** Side by side on the same cut (sheets below), Remotion's `slide()` pushed a sharp seam
across the frame with no motion blur: clearly worse than the whip's streak. `blur-slide` (and `zoom-blur`,
`linear-blur`, `cross-zoom` and the other shader presentations) draw through HTML-in-canvas: a phone's browser lacks
it, so the editor's Player falls back to a hard cut at the midpoint, and in our local render it also drew a plain cut.
So the whip is a custom presentation (the skill's custom-presentation pattern) on the old geometry: TransitionSeries
for every kind, the look kept. `push-cut` is not a whip (a hard cut with a punch-in and a flash) and was not used.
`zoom-blur.ts` is not a transition between clips (it is the speed ramp's per-frame blur on both sides of a cut, ADR
0074) and stays.

### Text: measured, fitted, never off the frame (`measure.ts`, core `scene.ts`)

- Titles are measured with `@remotion/layout-utils` `measureText` (a hidden span: a variable font's width axis
  counts). It caches every result for the life of the page, so nothing is measured until `useFontsFor` reports the
  faces loaded; before that, and on the server, core's measured advances (`font-metrics.ts`, regenerated with Playfair)
  stand in, uncached. `fontVariantNumeric` and `fontStretch` go through `additionalStyles` because measureText's cache
  key omits its own `fontVariantNumeric` (tabular and proportional figures would share an entry).
- **Core change (small, in the scene evaluator so the editor's handles agree):** `fitScreenTitle` widens a sentence's
  column to hold a word wider than it (no mid-word break), scales a title whose box is wider than 92 % of the frame down
  to fit, and moves its centre in just far enough to keep it inside. A title that already fits returns unchanged, so
  saved reels that drew correctly draw the same.
- Card prices (one line), hook titles and the end card's line are fitted with `fitText` (`fittedSize`), capped at their
  old sizes. The price is fitted inside the card's content box (the card is border-box).

### Fonts

- **Playfair Display** (owner's choice, 2026-10-26) is the `elegant` style (Medium, 0.01 em, 0.7 of the base size so
  its taller capitals match Cormorant's old cap height) and the serif hook. Cormorant Garamond stays as the title font
  `serif` (an elegant title set in it keeps Cormorant's old size, weight and tracking) and Bodoni Moda as `editorial`.
- The hook's families named `'Archivo'` and `'Cormorant Garamond'`, which nothing declares, so hooks drew in Arial and
  Georgia. They now name the bundled faces, and HookView holds its frame for them like a title.
- **Loading stays fontsource CSS plus our hold**, judged against the skills: `@remotion/google-fonts` fetches from
  Google at render time (a network dependency in the worker); `@remotion/fonts` `loadFont` (local-fonts.md) does the
  same delayRender hold as `useFontsFor` but one whole file per call, losing fontsource's unicode-range split (Noto Sans
  JP is over a hundred files) and needing a file URL from two bundlers (Next's and Remotion's webpack). The faces are
  bundled, so no render depends on the network.

### Look (`look.ts`)

Against color-correction.md: the presets are now `colorCorrection()`-style controls (`FILTER_GRADES`: exposure in stops,
temperature and tint, contrast, saturation) compiled in its order, exposure → white balance → contrast → saturation.
Warmth is a white balance, an sRGB `feColorMatrix` gain on red against blue that keeps a mid grey's luminance, drawn once
per reel (`GradeFilters`), instead of `sepia()` + `hue-rotate()`, which turned every hue (skin and sky) and browned the
colour; and brightness no longer comes last. `colorCorrection()` itself is a WebGL effect on `@remotion/media`'s
`<Video>` only, and the editor previews with `<Html5Video>` on phones, so it would split preview from export; the CSS and
SVG chain keeps them identical. `FILTER_CSS` stays as the editor chips' and frame service's approximation (they have no
SVG defs).

### Evaluated and left off

- **Light leak** (`@remotion/effects` `lightLeak()` in a `TransitionSeries.Overlay`, 16 frames, seed 3, screen blend):
  it renders, but as a loud yellow wash over the whole frame for half a second, not the restrained luxury look. Not
  exposed as a transition kind; default off.
- **Motion blur** (`@remotion/motion-blur` `CameraMotionBlur`, 6 samples, 180°) on the two clips of the speed-ramp cut:
  no visible gain over the ramp's own blur, and the export took 149.0 s against 23.3 s (6.4×; that run also carried the
  light leak and blur-slide). Off. `HtmlInCanvasMotionBlur` needs HTML-in-canvas, which the phone preview lacks.
- **Remotion Elements** ("Location Lower Third", "Social Safe Zones" at convert.remotion.dev): not looked at in this
  change (the site needs a browser session), so no safe-zone overlay or lower-third rework is adopted here; the
  editor's preview already places its stage chrome from `INSTAGRAM.safeZonePx`.

## Consequences

- Saved reels keep their schema, length and cut frames. They do look different where the owner asked: fades cross
  instead of dipping to black, elegant titles and serif hooks are Playfair, sans hooks are Archivo, filter presets are
  regraded, titles that overflowed now fit.
- A fade's two halves are real footage when the sources have handles, and a held frame when not; a held frame under a
  5-frame half-crossfade is hard to see but is not motion.
- The mattes follow the presentations only inside their clip's span: for the half of a transition outside it, the
  matte is not drawn (it never was).
- Agents: no new command or endpoint; `setTransition` with `fade`, `whip`, `cut` draws as above.

## What was verified

On this Windows machine (Remotion 4.0.538 Chrome Headless Shell, default GL), one heavy command at a time under the shared lock:

- Before/after sheets: `FFMPEG=<ffmpeg> MEDIA=<six clips> tsx scripts/primitives-compare.ts <dir> --export`, before on
  origin/main's render sources, after on this branch. In the owner's `ReelWalk-hybrid/output/research/remotion-primitives/`:
  `before/`, `after/`, `after-slide-v1/` (whip as Remotion `slide()`), `variant-blurslide-leak-mblur/`. After: the
  one-word title fits on one line, the price fits the card on one line, the hook is Playfair in three lines in the top
  30 %, fades cross, the whip streaks as before.
- Export time for the 12 s, 6-shot reel at concurrency 2: 24.5 s before, 23.3 s after (23.2 s on a second run); stills
  57.1 s and 51.6 s for 55 frames.
- `scripts/black-frame.ts --export`: 14 frames around the owner's off-frame cuts (one a whip) none dark, export scanned,
  0 flash frames; the same with `--codec mpeg4` (the OffthreadVideo fallback).
- Unit tests: `transition-plan.test.ts` (every kind's mapping, durations, centring, length preserved, no overlapping
  halves, handles, whip schedule), `title-fit.test.ts` (fit, no mid-word break, edge clamp, the 12-word hook),
  `grade.test.ts` (order, no hue rotation, white balance keeps luminance, Playfair default, Cormorant and Bodoni kept).
  `pnpm check` and `pnpm --filter @reelwalk/web build` pass.
- Not verified: the Linux worker's render time and look (CI's smoke runs it); the editor's Player on a real phone.
