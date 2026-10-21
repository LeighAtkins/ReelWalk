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
- Z-order among titles changes where titles overlap on screen: grouped by
  their occluders rather than by saved order. A plain caption that overlapped
  a `behind` title used to sit under the presenter; it now sits on top, which
  is the point. Two overlapping titles in different groups swap if the plain
  one was saved first.
- The object matte still computes its own carried taps (`carriedTaps` in
  ObjectMatte.tsx, owned by the matte work); the evaluator's `carryTaps` gives
  the same points and is there for it to adopt.
- Not done: occluders as separate entities with declared targets, surfaces
  owning their own coordinate system and track, and the screen-space title's
  box measured rather than left to CSS wrapping. These need schema additions,
  which this change avoids.

## What was verified

- `packages/core/tests/scene.test.ts` (16 tests): screen vs surface vs hidden
  derivation, corner-order independence, the average-opposite-edge fit with a
  short bottom edge, height-bound strips, post/cut-out mask transform, tracked
  opacity and the early-end fade, taps carried through a keyframe, the layer
  order, and an oracle copied from the pre-0046 TextView compared on every
  third frame of five legacy titles (identical numbers), plus a snapshot.
- `pnpm check` passes (lint, typecheck of every package including apps/web,
  all tests).
- Not verified: the render smoke and the frame-hash comparison. A worker image
  of the base commit was built, but the frame-hash run in it produced no frame
  in 27 minutes on a heavily loaded host and was stopped; the after-run was not
  attempted. `packages/render/scripts/frame-hashes.ts` is in place to run
  before/after in CI or the worker image.
