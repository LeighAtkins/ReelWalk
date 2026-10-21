# 52. A surface tracker that says when it cannot follow

Date: 2026-10-21

## Context

Pinned titles (ADR 0039, 0043, 0044) are tracked in the browser by
`trackTextPath` in `apps/web/components/editor/frame-analysis.ts`. The
2026-10-21 rewrite review (Sol B #3) and the typography post-mortems
found the tracker confidently wrong in ways that matter:

- `planePoints` (`packages/core/src/motion.ts`) samples a grid over the
  quad's **bounding box** without testing that a point is inside the
  quad, so a perspective surface took features from whatever lay in the
  box's corners.
- When a surface had little detail, the orchestration **borrowed
  features** from a box 8%, then 30%, then 100% larger, then from the
  whole frame (slip 44's "track a bare wall by the motion around it").
  Those features agree with each other very well, on a different depth
  plane: the title slides off its wall ("surface moved off its wall";
  titles drifting or thinning while stretched).
- The grade summarised point counts and held steps, not whether the
  plane stayed attached to the surface the author chose, so a wrong
  track was graded "good".
- `trackPlane` gated per-step scale and rotation but not shear, aspect,
  degenerate point layouts or accumulated drift; there was no correction
  against the first frame, and a refused step tracked from a frame its
  points did not belong to.

## Decision

A new pure module, `packages/core/src/track.ts`, replaces the
orchestration. `trackSurface(frames, anchors, options)` runs:

1. **Support region.** Features (Shi–Tomasi corner strength) are taken
   strictly **inside** the quad, at least a window's width from every
   edge, binned in the quad's own coordinates so they spread by area.
   Nothing outside is used unless the caller passes an explicit,
   author-chosen `support` quad. A blank wall is refused, not borrowed.
2. **Pyramidal Lucas–Kanade** (three levels, 11×11 window), seeded with
   a constant-velocity guess from the previous step.
3. **Forward–backward check**: a point tracked back that misses its
   start by more than 0.7 px is dropped (occluder edges, sliding
   patches).
4. **Model selection per step**: similarity, affine and homography are
   each fitted independently and each judged on its own inliers (enough of
   them, enough spread for that model, a step inside the degeneracy gates:
   per-step scale, rotation, shear ≤ 4°, aspect ≤ 10%, a sane convex
   quad). Of the candidates that pass, a richer one wins only when it
   explains clearly more points, or the same points clearly better by more
   than noise. A failing similarity does not block a valid affine (a 4%
   stretch leaves only a line of points agreeing with any similarity). If
   a richer model would have won but is refused by the shape gates, the
   step is refused as **degenerate** rather than falling back to a simpler
   model that explains a subset. A model explaining under half the
   followed points is refused. The accumulated plane must also stay sane
   and within 2× of the placed aspect (titles no longer thin while
   stretched). Registration uses the same selector.
5. **Drift correction**: every 4 steps, and after any refused step, the
   frame is warped back into the reference frame by the predicted plane
   and the reference features are re-registered against it; the residual
   homography is composed in. This also **re-acquires** a lost surface
   when an occluder passes or the camera comes back.
6. **Scoring per frame**: `attachment` = coverage of the quad's visible
   4×4 cells by agreeing features × exp(−(e/tol)²) where e is the 75th
   percentile reprojection error of *all* forward–backward survivors (not
   only inliers); `confidence` = attachment × visibility; plus a corner
   `uncertaintyPx`. Held and lost frames have confidence 0.

**Rejection.** The result is either the frames or
`{ ok: false, reason, frame, message }` with reason
`too-few-features` (at the anchor), `plane-lost` (at frame k) or
`degenerate-motion`; messages start "Could not follow this surface: …".
A plane lost part-way is reported with `lostAt` and a reason.

**Manual correction keyframes.** `anchors` are author quads at frame
indices. Each anchor tracks forward to the next and backward to the
previous; between two anchors the two runs are blended by distance,
weighted by confidence, so a correction at frame k pulls the track onto
the surface around k. `trackTextPath` accepts optional
`corrections: { atMs, quad }[]` for the editor's "edit on any frame,
then Track"; the UI that sends them is not part of this change.

**What gets saved** (`smoothTrack` then `trackPath`, both pure, in core):

- *Smoothing that cannot lie.* A centred 1-2-1 average over the corners,
  two passes, only inside runs of measured frames (held and lost frames
  break runs, run ends stay put). Each frame's corners may then sit at
  most its own `uncertaintyPx` from the measurement, and anchors do not
  move. A confident measurement of a real camera jolt stays a jolt (the
  review's case: raw error 0.00007 px, unbounded smoothing 6.25 px with
  confidence still 1; now under 0.2 px).
- *Nothing stale is drawn.* Lost frames are saved with o = 0 and carry the
  corners of the nearest measured frame on their side of the gap (the last
  one before the loss for the first half, the re-found one after), so the
  fade out runs at the last measured corners and the fade in at the
  re-found ones, each over one sample interval. Measured frames are
  opaque. (Previously lost frames kept the last quad and opacity rose
  before re-acquisition: frame 18 of the heavy-occluder run was drawn at
  60% with 12.69 px error.) Held frames inside a track take corners
  interpolated between the measured frames either side.
- *Timing matches the pin.* The editor samples evenly from the pin's
  `fromMs` to its true `toMs` (≤ 63 samples, ≤ `stepMs` apart), and `t` is
  normalised over that interval, which is the interval `pinnedProgress`
  plays the path over; a held end point at t = 1 is appended if the last
  sample falls short. (Previously a 250 ms window sampled at 0/100/200 ms
  saved t = 0/0.5/1 against `toMs` = 250, so every keyframe played late.)

**Editor.** `frame-analysis.ts`'s tracking section samples the shot, runs
`trackSurfaceAsync`, and saves `trackPath(smoothTrack(frames))`; the
region-borrowing cascade is gone. `trackSurfaceAsync` is the same
generator as `trackSurface` driven with a macrotask yield every two frame
steps, so progress paints (identical result; tested). On a desktop Node
run of 61 frames at 360 × 640 the whole track takes about 1.5 s and the
longest uninterrupted stretch is 76 ms (the first step: reference
pyramid, support points and a registration); phones will be slower. A
Web Worker would take the work off the main thread entirely; it was not
done here because its bundling could not be verified without a browser.
`trackTextPath` keeps its signature (null on failure);
`trackTextPathDetailed` returns the refusal reason, and `pinTitle` shows
it. Path keyframes keep today's `t/x/y/s/r/q/o` shape, so saved reels and
the renderer are untouched; per-keyframe confidence is returned beside
the path (`confidence[]`) and summarised in `TrackQuality.confidence`,
not stored in the timeline. `motion.ts` is unchanged: `planePoints` and
`trackPlane` stay exported (the benchmark's legacy run uses them).

## Benchmark

`packages/core/tests/track-bench/`: synthetic sequences with known
homographies (`synth.ts`): a textured wall plane moving by a known
homography in front of a textured background moving by another (parallax),
σ = 2 grey-level noise, 30 frames at the editor's 360 × 640 tracking size.
Cases: pan with parallax, push-in, orbit (perspective change), handheld
jitter, a narrow occluder sweeping across, a heavy occluder covering ~80%
of the surface for a third of the shot, a cut mid-shot, a fast pan that
takes the surface half out of frame, and a blank wall.

Both trackers are scored on **the path they save**, not raw output. New:
`smoothTrack` then `trackPath`, exactly as the editor does, with corners
read back from the saved `q` fractions and opacity from `o`. Legacy: the
old loop ported to a pure function (`legacy.ts`), its keyframes with its
fade through `smoothKeyframes` over the whole path, as main stores them.
The port fades over 2.5 samples, i.e. main's 250 ms at the benchmark's
100 ms sampling; an earlier version of the port faded over 10% of the
frames (3 samples here), which differed slightly from main.

Every keyframe drawn at all (o > 0) counts, partially transparent ones
included: mean error is weighted by opacity; "confident" means drawn and
presented as attached (legacy: grade "good", the only signal it had; new:
per-keyframe confidence ≥ 0.5); wrong means mean corner error > 3 px at
360 wide (≈ 9 output px); keyframes after the cut are wrong wherever they
are; "shown wrong" counts drawn keyframes that are wrong, whatever was
claimed.

| scenario | tracker | outcome | drawn | mean err px (opacity-weighted) | max err px | confident | false-confident | shown wrong |
|---|---|---|---|---|---|---|---|---|
| pan (parallax) | legacy | good | 29/29 | 0.42 | 0.60 | 29 | 0 | 0 |
| pan (parallax) | new | tracked | 29/29 | 0.34 | 0.55 | 29 | 0 | 0 |
| push-in | legacy | good | 29/29 | 0.66 | 0.92 | 29 | 0 | 0 |
| push-in | new | tracked | 29/29 | 0.55 | 0.73 | 29 | 0 | 0 |
| orbit (perspective) | legacy | good | 29/29 | 3.17 | 6.00 | 29 | 15 | 15 |
| orbit (perspective) | new | tracked | 29/29 | 0.57 | 1.28 | 29 | 0 | 0 |
| handheld | legacy | good | 29/29 | 0.64 | 1.09 | 29 | 0 | 0 |
| handheld | new | tracked | 29/29 | 0.47 | 0.78 | 29 | 0 | 0 |
| occluded pan | legacy | good | 29/29 | 0.61 | 1.06 | 29 | 0 | 0 |
| occluded pan | new | tracked | 29/29 | 0.18 | 0.34 | 25 | 0 | 0 |
| heavy occluder | legacy | good | 29/29 | 6.81 | 12.10 | 29 | 19 | 19 |
| heavy occluder | new | lost @9, found again @19 | 19/29 | 0.44 | 0.68 | 19 | 0 | 0 |
| cut mid-shot | legacy | good | 29/29 | 0.73 | 7.18 | 29 | 16 | 16 |
| cut mid-shot | new | lost @15 (plane-lost) | 14/29 | 0.01 | 0.02 | 14 | 0 | 0 |
| leaves frame | legacy | good | 29/29 | 0.30 | 0.55 | 29 | 0 | 0 |
| leaves frame | new | tracked | 29/29 | 0.01 | 0.02 | 29 | 0 | 0 |
| blank wall | legacy | good | 29/29 | 25.46 | 49.31 | 29 | 28 | 28 |
| blank wall | new | refused: too-few-features @0 | 0/29 | – | – | 0 | 0 | 0 |
| **all** | legacy | | | 1.67 (textured, mean of scenarios) | | 261/261 | **78/261 (29.9%)** | 78/261 |
| **all** | new | | | 0.32 (textured, mean of scenarios) | | 203/261 | **0/261 (0.0%)** | 0/261 |

Errors are px at 360 wide (× 3 for 1080 output px). Read honestly:

- The big wins are the failure modes: the blank wall (legacy tracked the
  background at 25 px mean error, graded "good"), the orbit (legacy's
  affine-only steps drift up to 6 px under perspective change), heavy
  occlusion (legacy followed the occluder) and the cut (legacy carried on
  for the rest of the shot). The new tracker refused, lost and re-found, or
  stopped at the cut instead.
- On easy textured motion the improvement is modest (0.4–0.7 → 0.2–0.6 px),
  and the ≈ 0.01 px rows (cut, leaves frame) are pure integer-pixel
  translations, which flatter any LK tracker.
- The new tracker draws fewer keyframes (203 vs 261): it hides frames it
  cannot vouch for, which is the intended trade.
- History, for honesty: the first version of this table scored raw
  tracker output and full-opacity frames only. A review found that the
  saved path could still be wrong (unbounded smoothing, stale corners
  fading back in, late timing); the table above is after those fixes and
  scores the saved path. One intermediate run had 1 false-confident frame
  (4.07 px) from smoothing across a re-acquisition.

The full run (`TRACK_BENCH=1 pnpm --filter @reelwalk/core exec vitest run
tests/track.benchmark.test.ts`, about two minutes) asserts these claims:
nothing drawn on the blank wall, zero false-confident and zero shown-wrong
keyframes, fewer false-confident keyframes and a lower mean error than
legacy, mean error under 0.6 px. A 144 × 256, 16-frame version runs in
`pnpm check` and asserts nothing drawn on the blank wall, no more false
confidence than legacy (and under 5%), and sub-threshold error on the
textured pans.

## Consequences

- A bare wall is now refused with a reason instead of being tracked by
  its surroundings. That is the point, and it is a regression for the
  slip-44 workflow that relied on borrowing: the author must pick a
  surface with some detail, or (once the UI exists) widen the support
  region on purpose via `support`. No UI for widening ships here.
- A track that loses its surface disappears rather than sliding; with
  re-acquisition it can come back in the same shot. The fade is now one
  sample interval (100 ms or more, depending on shot length) rather than
  a fixed 250 ms.
- Smoothing is limited to each frame's uncertainty, so a track with large
  uncertainty keeps more of its jitter than before; that jitter is what
  the measurement supports.
- Memory: frames are held for the whole run instead of streamed. Derived
  from the code (a measurement in Node was inconclusive because forced GC
  does not release ArrayBuffers synchronously): 63 frames × 360 × 640
  float32 = 58.1 MB; each pyramid adds gradients at level 0 and data plus
  gradients at levels 1–2, 2.7 MB; the cache holds at most 5 pyramids
  plus the run's reference pyramid (16.3 MB); a registration adds a
  warped frame and its pyramid (3.6 MB) transiently. Peak ≈ 78 MB of
  typed arrays, plus small JS objects, the canvas's 0.9 MB RGBA read per
  frame, and whatever garbage the browser has not yet collected.
- The numbers above are synthetic. They show the failure modes are
  closed (wrong depth plane, blank wall, cut, occlusion, perspective
  drift) but not real-footage accuracy: rolling shutter, motion blur,
  exposure changes, compression and specular walls are not modelled.
  The corner-strength floor (8) and residual ceiling (20 grey levels)
  are tuned on synthetic texture and may need adjusting on real shots.
- Object taps still inherit the wall's homography (ObjectMatte, out of
  scope here).

## Verified

- `pnpm check` (eslint, every package's typecheck, every package's tests):
  exit 0; `@reelwalk/core` 43 files, 421 passed + 1 skipped (the full
  benchmark, env-gated). The fresh worktree first needed
  `pnpm --filter @reelwalk/db db:generate` for the Prisma client;
  unrelated to this change.
- `packages/core/tests/track.test.ts`, 39 tests: pyramid (sizes, flat
  stays flat, stops small), corner score (blank, edge, texture), support
  points (inside-with-margin under a perspective quad with texture all
  around, coverage > 0.9, none on a blank surface, deterministic), LK
  (sub-pixel shift < 0.1 px on a band-limited picture, a 9,6 px shift that
  three levels follow and one level misses, guesses, failure on blank),
  forward–backward rejection of a half-replaced picture, model selection
  (similarity for a pan, homography only with spread support, collinear
  and sheared steps refused as degenerate, too few points, and the 4%
  stretch regression taking an affine with all 56 points), quad sanity,
  drift correction (warp round trip; a 1.5 px drifted prediction
  re-registered to < 0.25 px; the 4% stretch re-registered from an
  unstretched prediction to < 0.3 px; a 24-frame push-in ends < 1 px off
  with > 3 corrections), scoring (coverage not count; visible half),
  confidence drops while a heavy occluder covers the surface and every
  confident frame is right, all three rejection reasons with frames and
  messages, correction anchors (track both ways from frame k; a 3 px
  wrong start pulled onto the truth by a later anchor), smoothing (the
  [0,0,0,10,0,0,0] px jolt regression stays under 0.2 px after smoothing;
  anchors never move; held frames break runs; displacement bounded by
  uncertainty), the saved path (lost frames o = 0 at the nearest measured
  corners and the re-found frame opaque; held frames interpolated; a
  250 ms pin sampled at 0/100/200 ms saves t = 0/0.4/0.8/1), async
  tracking identical to sync with a yield per step, and identical JSON
  output for identical input.
- `packages/core/tests/track-editor.test.ts`, 2 tests through
  `trackTextPathDetailed` with a stand-in `<video>`/`<canvas>`: a 250 ms
  window seeks 0/83/167/250 ms, saves pin 0–250 with t = 0/0.3333/0.6667/1,
  and every keyframe's corner is within 0.5 px of the surface at that time;
  a degenerate sliver is refused with `too-few-features` and a "Could not
  follow this surface" message.
- Full benchmark at 360 × 640, 30 frames (table above), via
  `TRACK_BENCH=1`, assertions passing, about two minutes (the legacy
  brute-force matcher is most of it).
- Responsiveness: a one-off Node timing of 61 frames at 360 × 640 (not a
  committed test): 1.5 s total either way, longest stretch between yields
  76 ms.
- Not verified: the editor in a real browser (no Chrome in this run),
  real footage, phones, or the `corrections` path from the UI (no UI
  sends it yet).
