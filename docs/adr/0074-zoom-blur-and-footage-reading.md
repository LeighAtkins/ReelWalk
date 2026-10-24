# 0074 - Zoom blur for the speed ramp, and reading the footage properly

Date: 2026-10-24

## Context

The first showcase reel of the speed-ramp transition (ADR 0073;
`output/series/ramp-reel-v1.md`) showed two defects.

1. **A forward move got a sideways smear.** Cut 4's outgoing dining-room shot
   is a dolly in; the planner chose a horizontal blur, which reads as a
   sideways smear on a shot whose picture streams outward from a point. Cut 6's
   outgoing side was the same.
2. **"Auto" had nothing to go on.** `direction: "auto"` follows the incoming
   clip's `whipDirection`, which `matchCuts` sets from the outgoing shot's end
   motion (`motion.ts`, 48 px wide frames, whole-pixel block matching, one
   dominant shift). Slow stock (0.05–0.2 frame widths a second, 2–10 px/s at
   48 px) sits under the 5 px/s still threshold, and a dolly has no dominant
   shift at all (the picture expands), so both read as "still" and auto fell
   back to horizontal. The showcase agent measured optical flow itself and set
   the directions by hand.

## Decision

### The reading (`motion-kind.ts`)

A pure module that classifies the camera at a cut into one of `pan-x`,
`pan-y`, `zoom-in`, `zoom-out`, `rotate`, `still`.

- **Method.** One affine flow is fitted to the whole frame by gradient-based
  alignment (Lucas–Kanade, Gauss–Newton, a pyramid down to 24 px, Tukey weights
  from the median residual so a person walking through the shot does not pull
  the camera): `flow(p) = t + A·p`, with `div = (A00 + A11)/2` (expansion),
  `curl = (A10 − A01)/2` (roll) and `t` (translation), in frame widths. It is
  exact to a fraction of a pixel on textured footage, which is what makes a
  drift of 0.05 frame widths a second readable.
- **Longer gap, finer search.** The window is the last 500 ms of the outgoing
  clip (tail) and the first 500 ms of the incoming clip (head), three frames
  each (`edgeSampleTimes`), at 96×170 (twice the old frames). The estimate is
  over the whole window (first to last frame, the longest gap) and is started
  from the sum of the steps between neighbouring frames, so a fast pan still
  converges. Rates are per second.
- **Thresholds.** Edge speeds in frame widths a second: pan `|t|`, zoom
  `|div|·½`, roll `|curl|·½`. Under 0.02 (`STILL_FW_PER_S`: a fifth of the
  slowest drift worth following, and under half the slowest case in the brief)
  on all three it is `still`. A zoom wins over a pan up to 1.33× ahead (a
  dolly with the vanishing point off-centre also slides the picture, and
  `|t| ≤ |zoom|·½` whenever the focus is in the frame), a roll must lead both.
  A zoom's focus is where the flow is zero, `0.5 − t/zoom` (clamped to
  0.2–0.8); it is the point the picture really streams from, which with a
  dolly plus a slight yaw is not the room's vanishing point but where the
  streaks must start from.
- **Confidence.** None for a frame with no detail (a blank wall), rising with
  texture and with how much of the frame agrees on one flow; no detail reads as
  `still`.
- **Maps to blur kinds.** zoom-in / zoom-out → `zoom`, pan-x → horizontal,
  pan-y → vertical, rotate / still → the existing default (whip direction, else
  horizontal). The two sides are read and mapped separately and may differ.

`ClipMotion` gains optional `startRead` / `endRead` (the readings of the head
and tail), and `withReads` replaces the older `start` / `end` vectors by the
readings' pans (so `whipDirectionFor` and `matchCutScore` see slow pans:
a reading says whether the shot pans at all, so a 0.05 frame-width drift now
gives a whip direction and a push gives none; a push carries into a push, a
push into a pull scores badly). Motion measured the old way keeps its old
thresholds.

### The zoom blur (`zoom-blur.ts`, `ReelComposition.tsx`)

`direction: "zoom"` (a new member of `SPEED_RAMP_DIRECTIONS`) streaks radially
from a focus: the frame's middle, or the read's focus when the footage is a
push or a pull. The spread (how much larger the outermost copy is) is
`blur × i × 0.2` with `i` the same speed curve as the axis blur's, so it is
nothing at the start of the ramp and strongest on the cut frame; a saved reel
and a plan with no zoom render exactly as before (`plan.zoom` is all zero).

**Technique.** A zoom blur is the picture averaged over copies scaled about the
focus. SVG has no scale primitive, but `feDisplacementMap` moves each pixel by
an amount read from a map, and a map whose red and green ramp linearly with x
and y moves each pixel in proportion to its distance from where they read 0.5:
that is a scale about the focus. The ramp is one 54×96 PNG generated in JS
(`encodePng`, stored deflate, memoised by focus) read through `feImage`. The
stack is built by **doubling**, as a box blur is: a stage averages its input
with a copy of itself magnified by `spread·2^s/(2^S − 1)`, so S stages (1 to
3, by spread) make 2^S equally spaced copies (8 at the full spread, gaps of
about 9 px at the frame edge) for S displacements and S averages
(`feComposite arithmetic`). All copies are *magnified* (the sample point moves
toward the focus), so none reads outside the frame and the border never goes
clear. The average therefore sits `spread/2` larger than the sharp frame, in
the push's own direction.

**Push-in.** The push grows about the zoom blur's focus
(`translate(f) scale(1+push·i) translate(−f)`), so the streaks and the growth
radiate from the same place and reinforce each other; with the focus at the
middle it is the old `scale(…)` string unchanged. An axis blur on the other
side of a cut keeps the old push.

**What was tried first, and why it is built this way.** The first version drew
the ramp map from two SVG-gradient `feImage`s: 200 ms a copy against 35 ms
with the PNG. A single filter with the doubling stages cost 2^S evaluations
of the source (Skia does not share a filter node that two primitives read), 3
to 4 s a frame at 3 stages: so each stage is its own filter and the CSS
`filter` chains them (`url(#a-z0) url(#a-z1) …`, `speedBlurFilter`), each
reading the one before as a finished layer, which is linear: about 0.4 s a
stage at 1080×1920 in software GL. A stack of copies as DOM elements was
rejected: it would mount extra `<video>` elements for a third of a second
(decoder limits on phones, and the black-frame class of bug ADR 0067 fixed).
The matte layers carry the filter as they carry the whip's (the `whip` style).

### Storing the reading, and the cut report

A speed-ramp clip gains optional `rampFootage: { after, out, in }` (the kind
and, for a zoom, the focus, of each side). `after` is the id of the clip the
outgoing read was taken from; a read of some other clip (the reel was
reordered) is ignored. `planSpeedRamps` resolves each side with
`resolveStreak(direction, whipDirection, read)` (`auto` by the read; `zoom`
always zoom; an axis or angle as asked; `none` none) and the cut's report
says which kind each side used and why:

> Cut 4: speed ramp to 5×; … Blur: outgoing forward move → zoom; incoming
> sideways pan → horizontal.

The report is the line under the Transition sheet's controls and
`report.blur.{out,in}` = `{ kind, why }`.

### API and UI

- `setTransition { transition: { kind: "speedRamp", direction: "zoom" } }` (or
  `speedRamp: { direction: "zoom" }`) is validated by the same
  `speedRampSchema`; a bad direction is refused with the reason; it works in a
  batch and with `dryRun`. Whips are unchanged.
- `matchCuts` takes readings in the motion it is sent (`startRead`, `endRead`;
  a malformed one is refused) and, for every speed-ramp cut with a reading,
  stores `rampFootage` (`ramps: false` turns that off; `whips`, `reorder` as
  before). Agents send readings measured their own way or with
  `readMotion` (exported from `@reelwalk/core`).
- The Transition sheet's blur chips are Follow the footage / Sideways / Up and
  down / **Zoom** / No blur, and the speed ramp's **Match the footage** reads
  the last half second of the shot before and the first of this one (about 12
  seeks on a phone) and stores what each did. Its note says what was found
  ("Before the cut: forward move. After it: sideways pan.") above the cut
  report.

## Consequences

- Saved reels render exactly as before: `rampFootage`, `plan.zoom`,
  `startRead` / `endRead` and the `"zoom"` direction are additive and absent
  from every saved reel. The incoming side of an old cut resolves with no read
  to the same axis as before. No migration.
- A zoom blur costs more to export than the Gaussian (below). It applies only
  to the frames of a ramp whose blur reaches 0.4 % spread, 1 to 3 stages by
  strength.
- The Inspect loupe and critic sample frames the plain-cut way, as in ADR 0073.
- `REELWALK_RENDER_GL` (a Remotion `gl` value, e.g. `swangle`) is a new
  switch, unset by default, read by `renderReel` and `renderReelStills`.
- The reading's thresholds are on synthetic flows and one real shot; they will
  want tuning on more footage.

## What was verified

- `pnpm check` (lint, typecheck, every package's tests), `pnpm --filter
  @reelwalk/web build`, and the worker entry import under tsx (`OK`).
- `packages/core/tests/motion-kind.test.ts` (16 tests): synthetic flows of a
  smooth textured scene sampled analytically (no resampling blur), 96×170,
  noise of 2–3 grey levels: translation recovered (0.3, −0.1 frame widths a
  second to the first decimal); pan-x, pan-y, push in, pull out and roll in
  both signs; **slow versions at 0.05, 0.1 and 0.2 frame widths a second for
  each, read as moving, not still**; the 0.05 drift's rate recovered as
  0.0499; a still shot with noise (six seeds) and a 0.006 wobble read as
  still; a 0.9 frame-widths-a-second pan over a five-frame window; a dolly's
  focus found (0.329, 0.400 for a true 0.333, 0.4); a zoom with an off-centre
  focus is a zoom; a pan that slides far more than it expands is a pan; a
  bright block crossing the frame does not change a push's reading; too few
  frames, mismatched sizes, a window under 50 ms: null; a frame with no
  detail: still, confidence 0.
- `packages/core/tests/speed-ramp-zoom.test.ts` (19): `resolveStreak`'s whole
  matrix; the two sides of a cut planned from different reads; the zoom curve
  against the axis curve frame by frame (same ratio, push, positions and rates
  untouched); a stale outgoing read ignored; no reading is exactly the old
  plan; `matchCuts` stores the footage, refuses a malformed read, can be told
  not to; whip directions from slow pans; match scores for pushes and slow
  pans; the reading window; the command with `direction: "zoom"`.
  `speed-ramp-route.test.ts` adds the real route: `zoom` through a batch and a
  dry run, a bad direction answered 400, readings through `matchCuts`.
- `packages/render/tests/zoom-blur.test.ts` (13): the stages, copies and
  weights; the map's ramps (0.5 at the focus, in range for any focus, equal
  slope on both axes); the PNG against `zlib.inflateSync`, chunk by chunk; the
  chained filter string; the frames of a push-then-pan cut (a zoom blur with
  its focus out, an axis blur in, the push about the focus, nothing far from
  the cut); the same cut with no reading draws the old horizontal blur.
- **The showcase defect reproduced** with `scripts/zoom-vs-axis.ts`
  (real Remotion, Chrome Headless Shell). The sources were not downloaded (the
  reel's assets need a session); instead the **dining-room dolly** (5.700–7.400
  s) and the start of the next shot (7.900–8.900 s) were cut from the showcase
  export itself (`ramp-reel-v1.mp4`, real footage; the camera push the reel
  baked in is in the file). The script read them the way the editor does: the
  dining tail **zoom-in** (zoom +0.304/s, translation −0.075 frame widths a
  second, focus 0.75, 0.49, confidence 0.96) and the next shot's head also
  reads as a push (+0.345/s). Before, the same cut with no reading: *outgoing
  horizontal (the footage was not read)*; after: *outgoing forward move → zoom*.
  `assets/0074-zoom-vs-axis.png`: top row before (the sideways smear), bottom
  row after (streaks radiating from the focus; the lamp's streaks fan out),
  frames 45–56 around the cut at 51, 270 px wide each. The files are short, so
  the planner lowers this Punch cut to 2.42× (the shots have little source
  past their ends); that is the same in both rows.
- **Export time** (this Windows machine, Remotion 4.0.534, Chrome Headless
  Shell, other agents also running so ±10 %; one run each unless noted):

  | reel | GL | axis blur | zoom blur |
  |---|---|---|---|
  | ADR 0073's 225-frame fixture, both cuts zoomed (32 blurred frames) | Chrome default | 1.13× | **1.84×** |
  | same | `REELWALK_RENDER_GL=swangle` | 1.12× | **1.24×** |
  | the real 81-frame reel above (one cut, about 10 blurred frames) | default | 1.06× | **1.81×** |
  | same | swangle | 1.15× | **1.30×** |

  So the budget of about 1.3× is met only with `swangle`; with Chrome's default
  GL the zoom blur is about 1.8× on these ramp-dense reels (14 % and 12 % of
  frames blurred). The cost is a fixed extra per blurred frame (about 0.5 s on
  a strong one in default GL, 0.15 s under swangle), so the ratio falls with a
  reel's base cost per frame. These are laptop frames (about 0.07–0.1 s each);
  the worker's were about 0.8 s a frame in the showcase export (400 frames in
  about 5 min), where the same extra would be of the order of 10–20 %, but that
  is an estimate, **not measured**. In a browser with GPU filters (the editor's
  preview on a phone) displacement maps should not be the expensive path; I did not measure it
  either. Outside the table: the first designs measured 2.27–2.66× on the
  same reels (see above).

- **Not verified:** the Transition sheet and Match the footage on a phone (no
  browser session was run: the web build and types pass, nothing was clicked);
  the preview's playing frames under Safari (`feImage` with a PNG data URI and
  `feDisplacementMap` through a CSS `filter: url(#…) url(#…)` chain); the Linux
  worker (the default-GL cost, and whether `swangle` launches there: the switch
  is off by default for that reason); the reading on more footage than the
  synthetic scenes and the one real shot (the reel's other seven shots were not
  re-read, and its edges carry the previous export's ramps); a person or object
  matte under a zoom blur (the matte layers use the same filter style, tested
  as style strings only); a photo (no source to read, so `auto` has no read and
  keeps the whip direction).

## Follow-up (2026-10-24): Match the footage on one cut, and a shared focus

**The bug.** The Transition sheet's Match the footage sent `matchCuts` the motion of the two shots around one cut. `matchCuts`
then wrote `rampFootage` for *every* speed-ramp cut that had a reading on either side, and wrote it whole. The shot before
(cut N-1's incoming clip) has a head reading but no shot before it in the request, so cut N-1 was rewritten with `in` only
and lost its `out`; the shot after (cut N+1) has a tail reading from the selected shot, so cut N+1 was rewritten with `out`
only and lost its `in`. It set the neighbours' whip directions the same way. So cuts after the first could not be completed
one by one (the v1b reel needed one batch with all eight shots).

**The fix.**
- `matchCuts` takes `cuts?: string[]` (clip ids; each names the cut into that clip). Only those cuts get a whip direction and
  a footage reading; absent, every cut with a measurement, as before. The sheet sends `cuts: [selected clip]`.
- A fresh reading is laid over the stored one by `mergeRampFootage`: a side the reading has replaces that side (with the
  `after` that goes with `out`), a side it lacks is kept. So even a whole-reel run with a partly measured reel never wipes a
  cut's other side.
- The stale rule is unchanged (an `out` whose `after` is not the clip before is ignored) and a cut-local update does not
  revive stale readings on the cuts beside it.

**A shared focus.** `speedRamp.shareFocus` (optional boolean; absent or true = shared). When both sides of a cut are zoom blurs
the burst is centred on one point through the cut: the middle of the two vanishing points when both shots were read as a push
or a pull, the one that was read when only one was, and the frame's middle when neither. False keeps each side's own focus.
`setTransition` accepts it; there is no sheet control for it (the default is what the showcase wanted). A reel saved before
has no `shareFocus`, so a zoom-to-zoom cut with two different read focuses now renders from the shared one: the one
deliberate change to a saved reel's look, confined to cuts whose two sides were both read as zooms.

**Verified.** `packages/core/tests/match-cuts-local.test.ts` (12): on a 7-cut fixture, cut 2 then 4 then 6 leave the
earlier cuts' readings, whip directions and resolved blur kinds unchanged and the unrun cuts empty; a re-run of cut 4 with a
different answer changes only cut 4; cut by cut (forwards or backwards) equals one batch; a reorder makes the stale
readings ignored and a cut-local update re-reads only its own cut; the same tests fail with the old command (4 of 12
fail with `cuts` and the merge switched off). Focus: shared by default, off with `shareFocus: false`, the read one when
only one side has it, untouched when a side is not a zoom.
