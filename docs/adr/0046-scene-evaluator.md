# 46. One evaluated placement per title, and occluders scoped to their title

Date: 2026-10-21

## Context

A title carries `x`/`y`, `surface`, `pin.quad`, `path` offsets with scale,
rotation, opacity and corners (`q`), `bars`, `cutouts` and `occluders`, and
nothing said which of them is in charge. The composition's TextView worked it
out inline: corner ordering (ADR 0044), the plane's rectangle, a fill rule for
chosen surfaces and a different fit (`planarFitAndShift`) for tracked planes
without one, the early-end fade, the post mask. The editor's handles re-derive
parts of the same geometry on their own, so preview handles and render drift
apart (post-mortem slips 40-42, 51, 59). The text measurement both use lived
in core and reached for the DOM. And every person matte and object matte was
drawn above every title, though `behind` and the taps belong to one title: a
caption on a shot with a `behind` title had the presenter drawn over it. The
rewrite review of 2026-10-21 (Sol B #1, Sol A #3) put one scene description
for render and editor at the centre of the placement work.

## Decision

- **`packages/core/src/scene.ts` is the authority for where a title is.**
  `evaluateTitle(input)` takes the saved overlay (v1 schema, unchanged), the
  timeline, the frame, the composition size and an injected
  `measure(line, font) -> {width, height}`, and returns one discriminated
  placement:
  - `{ kind: "hidden" }`: a pinned title while another shot is on screen;
  - `{ kind: "screen", center, wrap, scale, rotation, opacity, occluderTaps }`;
  - `{ kind: "surface", plane, restPlane, rect, homography, placed, fitScale,
    lineBox, lines, clipToPlane, maskShapes, occluderTaps, opacity }`.
  Coordinate spaces are named in the module (fraction, composition, viewport,
  plane, source); everything returned is composition px except `maskShapes`
  (plane px) and `occluderTaps` (fractions, what the segmenter is asked).
- **An adapter over v1, not a new schema.** The kind is derived from the
  saved fields exactly as the renderer did (`titleCorners`): a surface with no
  pin is drawn upright inside it (`orientQuad`); a pin with a quad keeps its
  corners' placement order and re-orders every keyframe by the same
  permutation (`orientOrder`); anything else is a screen title. Nothing is
  written back. The fill rules are kept to the pixel: a chosen surface fills
  94% of the width or 92% of the height of its average-opposite-edge
  rectangle; a tracked plane without a chosen surface is fitted to the frame
  by `planarFitAndShift` (moved into scene.ts, still exported for the editor).
  Tracked `o` and the 0.4 s early-end tail are the placement's `opacity`; the
  entrance animation stays in the renderer and multiplies it.
- **No DOM in the evaluator.** The composition passes `domMeasure`
  (`packages/render/src/reel/measure.ts`, the same hidden-span measurement as
  before); tests pass a fixed-advance measurer. `oneLineWidth` stays in core
  for the editor's handles until they consume the evaluator, and its no-DOM
  estimate is now the shared `estimateLineWidth`.
- **TextView draws what the evaluator returns** and has no geometry of its own.
- **Occluders draw above their own title.** `sceneLayers(timeline)` gives the
  bottom-to-top order: `behind` titles, each followed by the objects tapped for
  it; then the presenter matte of each video clip a `behind` title overlaps
  (one per clip, so segmentation is not repeated per title); then titles with
  tapped objects but not `behind`, each followed by its objects; then every
  other title. A plain caption therefore stays above every matte, and a
  `behind` title with no taps still has the presenter in front of it.

## Consequences

- The editor's handles can take the same placement (`plane`, `homography`,
  `rect`, `fitScale`) instead of re-deriving it; that is the next agent's work
  (apps/web/components/editor is untouched here).
- Z-order among titles changes where titles overlap, on purpose. The rule is
  per title: `behind` means the presenter passes in front of it, not `behind`
  means it is in front of the presenter, and a title's tapped objects sit
  directly above that title. Compared with main, where every matte sat above
  every title in saved order:
  - A plain caption on a shot with a `behind` title is now drawn over the
    presenter rather than under it: it never asked to be behind anyone.
  - (a) A tapped title that is not `behind` now draws over the presenter (main
    drew the presenter over every title): its taps name the objects in front of
    it, and the presenter is not one of them.
  - (b) The group beats saved order: a plain caption saved before a `behind` or
    tapped title now draws on top of it, because a caption in front of the
    picture must not be cut by another title's occluders.
  - (c) A `behind` title's tapped objects now sit below the presenter and below
    later titles: they belong to that title's layer, so they cover that title
    and nothing else.
  The editor's tap targets (`preview.tsx`) are stacked the same way through
  `stackTitles`, so a tap selects the title that is drawn on top.
- The object matte still computes its own carried taps (`carriedTaps` in
  ObjectMatte.tsx, owned by the matte work); the evaluator's `carryTaps` gives
  the same points and is there for it to adopt.
- Not done: occluders as separate entities with declared targets, surfaces
  owning their own coordinate system and track, and the screen-space title's
  box measured rather than left to CSS wrapping. These need schema additions,
  which this change avoids.

## Follow-ups (from the PR #195 review, not done here)

- `occluderTaps`, `homography`, `restPlane` and `lineBox` are returned but not
  yet consumed by the renderer; they are there for the editor handles and the
  mattes.
- ObjectMatte's `carriedTaps` duplicates `carryTaps`; the mattes work adopts it.
- `packages/render/src/reel/measure.ts` duplicates core's `oneLineWidth`; the
  latter goes when the editor stops calling it.
- The editor still fits titles with `oneLineWidth` + `planarFitAndShift` on the
  un-reordered `pin.quad`; the editor-handles work switches it to the evaluator.

## What was verified

- `packages/core/tests/scene.test.ts` (16 tests): screen vs surface vs hidden
  derivation, corner-order independence, the average-opposite-edge fit with a
  short bottom edge, height-bound strips, post/cut-out mask transform, tracked
  opacity and the early-end fade, taps carried through a keyframe, the layer
  order, and an oracle copied from the pre-0046 TextView compared on every
  third frame of five legacy titles (identical numbers), plus a snapshot.
- `pnpm check` passes (lint, typecheck of every package including apps/web,
  all tests).
- CI's worker image job ran the render smoke on this branch: 15 frames drew,
  MP4 4.91 s with video and audio.
- Frame hashes (`packages/render/scripts/frame-hashes.ts`): worker images built
  from origin/main (643bfac, with only the two scripts copied in) and from this
  branch rendered the smoke reel's frames 10, 40, 75, 90, 110, 130, 146, 160,
  200 and 230 as full-size PNGs. All ten SHA-256 hashes are identical, including
  the pinned and surfaced titles with posts on frames 75-146 and the behind
  title over the presenter matte on frames 10 and 40. The smoke reel has no
  title overlap that the new layer order changes, so this proves placement
  parity, not the new z-order (covered by the sceneLayers tests).
