# 47. One frame-and-coordinate contract for placement tools

Date: 2026-10-21

## Context

Text x/y, surfaces, pins, posts, cut-outs and taps are stored as fractions
of the 9:16 reel frame, and the composition draws them there. The tools
that produce and show them each did their own geometry (rewrite review
2026-10-21, Sol A #3; post-mortem slips 60, 66, 69–73):

- Surface detection and tracking drew the whole source video stretched
  over the analysis canvas (`frame-analysis.ts` `grayFrame`) and then read
  the result as frame fractions. That is only right for 9:16 footage at
  zoom 1 with no camera move; landscape footage under Fill is cropped and
  under Fit is letterboxed, so a detected or tracked corner landed in the
  wrong place.
- The loupe found "the footage" by taking the first loaded `<video>` in the
  stage's DOM and rebuilt centred-cover geometry itself, ignoring Fit,
  zoom and the camera move.
- Handles turned pointer positions into fractions of the stage box. The
  Player contain-fits 9:16 into that box, so any box that is not 9:16
  (full screen on a phone) put every handle off the picture (slip 60).
- Displayed↔stored conversions (the plane's motion, rounding, the text's
  line width) were repeated in preview, sheets and editor callbacks.
- Track captured its inputs, awaited a multi-second analysis and wrote the
  result back even if the corners or the shot had changed meanwhile.

## Decision

**`packages/core/src/view.ts`** is the contract. It names four spaces —
source px, composition fraction, viewport px, plane-local — and every
function says which it takes and returns:

- `fitRects` (moved from render; `presentation.ts` re-exports it, same
  function, behaviour unchanged and tested against the old code).
- `clipPicture(clip, sourceSize, moment)`: fit plus zoom and camera move at
  a moment, with `sourceToComposition` / `compositionToSource` and
  `pictureCanvasTransform` (the composition's CSS transform as a canvas
  matrix). `clipMomentAtSource` and `onScreenAt` compute the moment the way
  `clipPresentation` does; `onScreenAt.mediaMs` is the time the stage's
  media element is really at (Remotion trims on whole frames).
- `stageRect`, `viewportToComposition`, `compositionToViewport`,
  `compositionScale`: where the composition is on screen.
- `planeMotion` (stored first-frame ↔ displayed, for pinned planes),
  `planeFrame` (unit square ↔ quad), `mapPoints`, `storedFraction`.
- `placementVersion(timeline, textId)`: everything that decides a title's
  plane and what tracking would produce. Posts are excluded (they cut the
  title, they do not move its plane); the Pin sheet adds its unsaved lean.

It imports only core, so W1's `scene.ts` can import it.

**`apps/web/components/editor/frame-service.ts`** reads pixels as the
composition shows them: `drawPresented` draws a clip's media through its
fit (with the blurred backdrop under Fit), zoom, camera move and colour
filter; `FrameService.frameAt(target, sourceMs)` caches frames by clip
instance, presentation and time (six frames, two open sources);
`timelineFrames(timeline, assets).frameAt(clipId, sourceMs)` resolves a
clip instance by id with its frame-plan length. Drawing (`frame-draw.ts`) has two purposes:

- **analysis** (surface detection, and tracking's `grayFrame` for the clip
  the video was opened for): the picture alone, through fit, zoom and move,
  on flat grey, with no grade. Under Fit the composition's blurred backdrop
  moves about 3.9× faster than a 16:9 picture (and is black where canvas
  filters are missing, Safari), so points found on it bent the plane and
  differently per browser. The tracking orchestration itself is unchanged.
- **view** (the loupe): what the viewer sees, backdrop and grade included.

Videos are seeked to the middle of the composition frame (`midFrameMs`):
seeking to a frame's start rounded to the millisecond (33 ms < 33.33 ms)
lands on the frame before. The loupe reads the stage frame at `mediaMs`, so
it has no geometry of its own. It is mounted only while a point is held, so
frames are decoded only then; its requests are latest-wins per source
(superseded ones are dropped before they seek), and evicted canvases are
zeroed at once (iOS caps canvas memory and frees it lazily). Four frames
and two sources are kept.

iOS caveat: Remotion seeks the stage's own video to `time.toFixed(1)` on
iOS and re-seeks only when it is more than 0.01 s off, so on an iPhone the
stage can be a frame or two from the exact time; the loupe then shows the
exact frame, not the stage's.

**Placing screen layout.** The full-screen placing frame is sized to fit
the viewport at 9:16 with a 44 px gutter each side; the stage grid track
is pinned to the box. Before, the auto track grew to the frame's
height-derived width and the right-hand corners sat 6 px from a 412 px
screen's edge with 30 of their 44 px visible.
`findMatchingCut` still compares raw sources (it compares two clips'
footage, not placements).

**Handles live in `.stage-plane`**, an element laid exactly over the
composition (`stageRect` of the stage box). Pointer positions become
composition fractions through `viewportToComposition` on that element;
text targets, guides, corners, posts, cut-outs and taps all sit in it.

**Tracking is versioned and cancellable.** Track (placing screen and Pin
sheet) captures `placementVersion` when it starts; the result is applied
only if the version is unchanged when it arrives (checked again inside the
history update), otherwise it is discarded and the status says so. Leaving
the placing screen or closing the Pin sheet aborts it at the tracker's next
step (`pinTitle({ signal })`; the abort is raised from the progress
callback, so the tracker's code is untouched).

**Seam for the scene evaluator.** `displayedPlane` in `preview.tsx` is the
one place handles read the plane they sit on; it is marked to return W1's
evaluated `plane` once `scene.ts` lands.

## Consequences

- Saved reels are untouched: nothing stored is reinterpreted, and the
  composition did not change (render only re-exports `fitRects`). Footage
  that is 9:16, zoom 1, no move analyses exactly as before.
- New detections and tracks on landscape, zoomed or moving clips are in
  composition space, and include the clip's camera move. Tracks made
  before this change on such clips stay as they were (stretched-space);
  re-tracking fixes them.
- A title's line width is measured in one place (`title-metrics.ts`).
- The tracker rotated a plane on a pure horizontal pan in the e2e below
  (handles and title agree with each other; the plane itself drifts).
  That is the tracking algorithm (W7's), not the frame contract.

Follow-ups: cancelling a track is "ignored at the next step", not an
abort (the video load and first seek cannot be interrupted); lens
softness is not drawn in the loupe; the backdrop blur is drawn at 48 px
where the effective blur after the 1.25 scale is 60 px.

## What was verified

- `packages/core/tests/view.test.ts` (20 tests): `fitRects` identical to
  the old render implementation over many sizes and render re-exports the
  same function; source↔composition against an independent model of the
  CSS for 6 source shapes × Fill/Fit × 3 zooms × every camera move × 3
  progresses, round trips, known values for landscape under Fill and Fit;
  the canvas matrix lands every pixel where `sourceToComposition` says;
  the stage rect in a 352×743 phone box (the old fractions were 7.9% off at
  the top edge); plane motion, plane frames; moments match the
  composition's frame plan; `placementVersion` changes on corner, fit and
  trim edits and ignores what tracking writes back.
- `e2e/tests/placement-frames.spec.ts` on the suite's Pixel 7 (412×915,
  touch via DevTools touch events) against a dev server of this branch,
  with landscape 1280×720 panning footage (`landscape-pan.mp4`, generated
  by `make-landscape-pan.mjs`). Results of the run:
  - Fill, corner held on the first frame: loupe vs stage patches differ by
    2.2/255; against the stage 14 px aside 35.9.
  - Track: "Good track", 41 keyframes. At ½ the handles moved −88 px with
    the panel; with overlays hidden, the title's pixels (found by hiding the
    title element in the composition and differencing) lie inside the
    handles' quad and span most of it.
  - A corner dragged at ½ stays under the finger (<1.5 px) and the rendered
    title is still inside the new quad.
  - Fit, corner held: loupe vs stage 7.1; shifted 67.3.
- Review round (same e2e, the frame now fits the screen): placing frame
  x 44–368 of 412, every corner put on its frame corner is whole on screen
  (≥44×44, topmost at four inset points); Fill loupe 2.4 vs 37.6; Fit loupe
  6.6 vs 85.1; Fit track "Good" (18 points), top edge turned 1.0° at ½,
  title inside the handles. Under Fill the tracker still turns the plane on
  the pure pan (as on main).
- `packages/core/tests/frame-draw.test.ts`: a Fit frame drawn for analysis
  has one draw (the picture), no filter, and zero gradient outside the
  picture; the backdrop and grade are drawn only for viewing and only where
  canvas filters exist. `midFrameMs` lands inside the frame on rounded
  boundaries.
- `pnpm check` passes.

Not verified: the e2e stage was 9:16 in this layout, so the band offset of
a non-9:16 stage is covered by unit tests only; iOS Safari (no canvas
`filter`: the Fit backdrop is drawn black there for analysis and loupe).
