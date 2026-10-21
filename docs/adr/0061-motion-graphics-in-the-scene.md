# 61. Motion graphics that sit in the scene: shine, kinetic type and pinned callouts

Date: 2026-10-21

## Context

Pro-editing area 3. Titles can already be painted on a tracked surface
(ADR 0039/0043), placed by one evaluator (ADR 0046), cut by posts, cut-outs
and tapped objects (ADR 0044/0051), walked through and dusted with particles
in their plane (ADR 0055). What they cannot do is *move* like finished motion
graphics: light catching the letters, words arriving one at a time or from
behind a pillar, a price counting up, a small label pointing at a feature
of the room that stays on it as the camera moves.

All of it has to be deterministic per frame (the editor's Player, a still
and the worker's export are the same composition), drawn in the title's own
plane so it follows a tracked surface, and added without touching the
tracker, the mattes, the particles or the pacing work (W14, ADR 0059).

## Decision

### Schema (additive, `textSchema`)

- `shine?: { preset: "sweep" | "glint" | "golden"; angle?; startMs?; everyMs?; flare? }`
- `kinetic?: { preset: "words" | "behind" | "count"; startMs?; durationMs? }`
- `callout?: { x, y }`: the feature, frame fractions on the title's first frame.

`startMs` in both is **ms after the title appears**, so a title moved on the
timeline keeps its motion with it. Saved reels have none of these and render
exactly as before: no field is reinterpreted, and the renderer takes the old
code path for a title without them.

### Pure modules in core

`packages/core/src/shine.ts`, `kinetic.ts`, `callout.ts`. Each is a function
of the title's time (frame × 1000 / fps) and the saved spec: no clock, no
`Math.random`; any variety (which letter a glint lands on) is the integer
hash particles already use (`hash01`). They return data or rounded strings
(CSS gradients, SVG), so "same frame, same output" is a unit test.

- **Shine.** `shineAt(spec, titleMs)` gives the band (centre and half-width
  along a tilted gradient line, 0..1 across the text box), the glints alive
  on this frame (a letter, a place on its upper edge, a size and a turn) and
  the flare. Presets:
  - *Sweep*: a white band, 20° from vertical, 0.8 s, 0.4 s in, again every 3.2 s.
  - *Glint*: no band; three slots of four-point stars, each twinkling 0.7 s
    in a 1.5 s cycle on a hashed letter (spaces skipped).
  - *Golden hour*: a wide warm band (1.6 s, 32°), an anamorphic streak riding
    it, two glints, every 4.2 s.
  The band is drawn as **two copies of the letters** over them, both in
  percentages of the text box so no measuring is needed: a *tone* copy whose
  fill is shade → light → shade across the band, clipped to the glyphs
  (`background-clip: text`), and a *bloom* copy in the light's colour with a
  glow, masked to the band's core. The first cut was the bloom alone: on
  white letters over a white window it barely showed (stills, 2026-10-21);
  the shade either side is what makes white letters read as lit.
- **Kinetic.** `wordReveal` splits the text into words and the space between
  them (kept, so the layout is the full text's); each word fades up 0.35 em,
  unblurring from 6 px, staggered over the move. `slideFromBehind` slides the
  words away from an edge, from wholly behind it to their place (ease-out
  expo), clipped on the side they come from; if the words at rest reach
  past the edge the clip opens over the last 15% so the rest shows (the
  post's own cut still hides what it covers). `revealEdge` picks the edge:
  the post or cut-out (`maskShapes`, plane px) or the tapped object (its
  carried tap, taken back into plane px through this frame's homography)
  nearest the words, else their own left edge. `countUpText` counts every
  number in the text from 0 in its own format (decimals, thousands
  separators: "$1.2M", "4 BED", "2,400 sq ft"), rounded down so the last
  frame is the first to show the full number; the size is held by a hidden
  full copy, as the typewriter does, with tabular figures.
- **Callout.** `calloutQuad(point)` is a square ±8% × ±4.5% around the point
  (about 170 px at 1080); Pin tracks it with the ordinary pin path
  (`calloutTrackTarget` hands `pinTitle` the point as x/y and the square as
  the surface), so `pin.quad` is the square and each keyframe's `q` is where
  it went. `calloutAnchorAt` maps the point through the square's homography.
  `calloutGeometry` draws, from the title's time: the dot pops (0–220 ms),
  the leader line draws out of its rim (140–520 ms) and stops 12 px outside
  the label's box, the label settles 14 px outward along the line (380–680
  ms); everything fades over the last 250 ms.

### The scene evaluator

One addition to `evaluateTitle` (ADR 0046): a title with `callout` is a
**screen** placement whose `center` is the label (its saved x/y plus the
point's travel) and which carries `callout.anchor` (composition px). Scale
and rotation are 1 and 0 (a label is read, not painted on a wall), it never
wraps, and its opacity is the path's tracked `o`, so **it fades where the
track was lost** and is hidden on another shot like any pin. `titleCorners`
returns null for a callout, so nothing treats its tracked square as a plane.

### The renderer

`TextView` (ReelComposition.tsx) draws shine and kinetic type in
`MotionLetters`, **inside the title's face span**. For a surface title that
span lives in the plane's box under the plane's `matrix3d`, so the band, the
glints, the streak and the words' slide are laid out in plane px and warp
and travel with the tracked surface; the "from behind" clip is a polygon on
the plane box, also in plane px. A screen title gets the same in its own
box. The flare is screen-blended. A callout's dot and line are one SVG over
the composition, under the label, at the placement's opacity.

Kinetic words and from-behind bring the words in themselves, so the
title's entrance (`animation`) is not applied with them; a count keeps the
entrance but replaces the typewriter. A callout uses its own reveal.

### Pacing seam (ADR 0059)

`typeMotionCues(text)` lists when each title's shine and kinetic move begin,
in reel ms; `setTypeMotionCue(text, key, reelMs)` stores one back relative to
the title, on a whole frame and inside the title; `snapTypeMotionToBeat`
moves every cue to the nearest beat of the music's grid (`nearestBeatMs`),
never before the title appears. The pacing work can snap with these without
knowing the field layout.

### Editor

- Tapping a title and **Edit** opens the text sheet; under Style there is a
  **Motion** row (No motion / Shine / Kinetic). Shine shows Sweep / Glint /
  Golden hour; Kinetic shows Word by word / From behind / Count up (with a
  hint when there is no number). When editing, "Starts 0.4 s after the text
  appears" with **Use this frame** (reads the playhead when pressed) and,
  when the music has a tempo, **On the beat**. The "Arrives" row hides when
  kinetic type brings the words in itself. Same `updateText` apply path, so
  undo and autosave are unchanged.
- **Add text** has a **Kind** row: Title / Callout ↗. A callout starts as a
  small white box label right of centre with its point below-left of it; the
  editor says "Drag the blue dot onto the feature, then Pin it to follow it".
  With a callout selected, the preview shows a 44 px blue dot on the point;
  dragging it sets the point (and drops a pin made for the old point). Pin
  on a callout opens a short sheet: Pin to the feature, whole shot, Unpin.
  Rows a callout does not use (movement, depth, blend, people in front,
  particles) are hidden for it.

### Acceptance harness

The smoke fixture's OCEAN VIEWS (p1, pinned on the room shot) carries
`shine: { preset: "sweep" }`, so preview-against-export compares a sweep in a
warped, tracked plane. The attachment probe drops a title's shine and
kinetic move (light is not glyph shape; a slide is not where the letters
rest), and a callout is not a planar title for the attachment check.

## Consequences

- Titles can be lit, typed in and pointed without keyframes; every move is
  one preset and one start time, in the plane, the same in every render.
- Shine costs two more copies of the letters while the band is on screen;
  glints wrap the chosen letter in a span, which can change kerning at that
  letter by a fraction of a pixel while it twinkles.
- Known gaps, not done:
  - "From behind" on a screen title has no occluder to come from, so it
    comes from behind its own left edge (a mask reveal).
  - Glints sit on the letter's box (upper right shoulder), not on traced
    glyph edges; there is no glyph outline in the browser to trace cheaply.
  - The shine copies in a word-by-word title clip to the words' *current*
    state; `background-clip: text` through inline-block words with
    transforms is untested beyond the stills.
  - A callout pinned with Pin uses the tracker as is; a point on a
    featureless floor may be refused ("too few features"), and the callout
    then stays still.
  - The pacing work (ADR 0059) is not wired to the cues yet; the seam exists.
  - The text sheet was not driven on a phone in this change (no e2e for it).

## What was verified

- `packages/core/tests/type-motion.test.ts` (24 tests): schema (a saved
  title without the fields parses without them; the fields round-trip; an
  unknown preset is refused); shine is a pure function of the frame (same
  frame ⇒ equal state, CSS and SVG strings for every preset at six frames),
  nothing before its start, the band crosses from wholly before to wholly
  past the letters monotonically and repeats every `everyMs`, angle and start
  overrides, glints never on a space and at most the preset's count, the
  golden streak rides the band and can be turned off, a snapshot per preset;
  kinetic words hidden, staggered in order and whole with the text kept
  intact, from-behind starts wholly behind the edge in either direction and
  opens across a post, the edge picked from posts and taps, count-up formats
  ("0 BED", "$0.6M", "2,100 sq ft", "$1,250,000"), monotonic and never past
  the number; the pacing cues (frame rounding, clamping, beat snap never
  before the title); **plane space**: on a tracked surface with a post, the
  post's edge found in plane px, carried by the frame's homography, lands on
  the post and moves with the track across four frames; callouts: the
  tracked square, the point through the square's homography (not just its
  centre), the label travels exactly as far as the point with scale 1 and
  rotation 0 though the path carries 1.3× and 12°, **opacity 1 → between →
  0 across a lost keyframe**, hidden on another shot, the dot/line/label
  reveal, the line ending exactly 12 px outside the label, no line when the
  point is under the label, the exit fade, and a snapshot of the SVG.
- `apps/web/components/editor/type-motion-draft.test.ts` (4 tests): one kind
  at a time in the Motion row, start from the playhead on a whole frame
  inside the text, the beat for the motion, the callout's starting look.
- `pnpm check` passes (lint, typecheck of every package, all tests: core 606,
  render 68, web 27, worker 146, db 6).
- Render smoke with acceptance on Windows (`SMOKE_COMPARE=1 pnpm --filter
  @reelwalk/render smoke`, FFMPEG = an ffmpeg 7.1 essentials build, FFPROBE =
  Remotion's): 15 frames drew, MP4 4.91 s with video and audio; preview
  against export ok on all ten frames (SSIM 0.980–0.993, worst block ≤ 14.9),
  including frames 75–128 with the sweep on OCEAN VIEWS in its tracked plane
  (frame 93 is mid-sweep: SSIM 0.980, worst block 12.0); the three planar
  titles on their planes (drift ≤ 1.1 px, shape and controls ok, present in
  the export). Baseline (report-only) differs at frame 19 (known since ADR
  0055) and at frame 93 (worst block 41.8: the sweep, new on purpose); the
  committed references were not updated.
- Stills of every preset at 1080 on the reader footage
  (`packages/render/scripts/type-motion-stills.ts`): Sweep, Glint and Golden
  hour on the pinned window title, word by word, from behind the window's
  mullion, a count-up with a sweep after it, and a pinned callout drawing in
  and fading where its synthetic track is lost. Looked at full size and in
  crops. The first sweep (bloom only) was invisible on the white window; the
  shade either side of the band is the second cut.
- Not verified: the text sheet and the callout dot on a phone or in a
  browser (no dev server with a database here, no e2e added); a real Pin of
  a callout with the browser tracker (the stills use a synthetic track).
