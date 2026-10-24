# 0073 - The speed-ramp transition

Date: 2026-10-24

## Context

The popular "speed ramp" cut: the outgoing shot accelerates into the cut
(1× to about 4–5× over its last quarter second) with a directional motion blur
and a small push in, the cut lands at the peak of speed, and the incoming shot
starts fast and settles to 1× out of the blur. The app had the parts but not
the whole: per-clip speed ramps (ADR 0067, `ramp.ts`: a curve that keeps the
clip's length), the whip (ADR 0028, direction from the footage in ADR 0067) and
eased camera moves. Nothing combined them across the two clips of a cut.

The owner dislikes whooshes (ADR 0066), so the transition is silent: the auto
sound design places a whoosh under a whip and does nothing for a speed ramp.

## Decision

A new transition kind, `speedRamp`, on the incoming clip's `transitionIn`
(additive: `TRANSITIONS` gains a member, the clip gains an optional
`speedRamp` object; no saved reel has either). It is a cut with a ramp either
side, not an overlap: the reel does not get one frame longer or shorter.

### Parameters (`speed-ramp-params.ts`)

`durationMs` (200–800, default 500, split evenly: the outgoing tail and the
incoming head each take half, in whole frames, at least 2), `peak` (2–6,
default 4), `blur` (0–1, default 0.6), `push` (0–0.2 scale, default 0.08),
`direction` (`"auto"`, `left`/`right`/`up`/`down`, an angle in degrees, or
`"none"`). `auto` follows the clip's `whipDirection`, which `matchCuts` now
also sets for speed-ramp cuts (so "match the footage" works as it does for a
whip), and falls back to sideways. A hidden `auto: true` marks a ramp that
Pace placed (below). Presets: **Soft** 3× in 400 ms, **Punch** 5× in 300 ms; a
one-knob intensity (0–1) maps to peak 2–6 and duration 450–250 ms, with blur
and push following, and Soft and Punch sit on it at 0.25 and 0.75.

### The curves and the plan (`speed-ramp.ts`)

Per frame the speed multiple is `1 + (peak − 1)·i`, with `i = (k + 1)² / T²`
over the tail's `T` frames (builds slowly, the last frame before the cut is
exactly the peak) and the same curve run backwards over the head (its first
frame is exactly the peak). The same intensity `i` drives the blur strength
and the push. `planClipSpeed` simulates a clip's frames: for each of its
`durationInFrames` frames it gives the clip-frame it shows (`position`), the
speed, the blur (σ along x and y) and the push. Source time goes through the
same maths as ramps (`clipSourceFrame`, whole-frame `trimBefore`, one media
element asked for the mean rate since its first frame), so every frame lands on
an exact source frame: no fractional-frame cut and no frame without a picture.
`speedRampMediaWindow` is the counterpart of `mediaWindow`; a clip with no
plan goes through `mediaWindow` exactly as before.

### The source-handle rule

At 4–5× the outgoing tail reads more source than it takes screen time. A head
that starts at the peak at its in-point likewise runs ahead of where the clip
would otherwise be. The extra source is found by simulating the clip, and met
in this order, each step only when the one before is not enough. The cut's
report (`planSpeedRamps().cuts`) says which was used, and the transition sheet
shows it as a line under the controls.

1. **handles**: the asset's own footage beyond the out-point covers it
   (asset lengths are passed to the composition as `ReelAsset.durationMs`; the
   export payload, the worker and the editor all pass it, because preview and
   export must plan identically). The incoming head reads its **pre-roll**
   before the in-point as far as there is any, so it has settled to the
   clip's own timing when the ramp ends. Never under speech (a trimmed word
   must not show), and when the pre-roll is short the rest is read ahead from
   the in-point (`partial`).
2. **compensated**: otherwise the body of the clip plays slightly slower (a
   smooth bump, at most 40 % slower at its deepest) so the clip still ends on
   the source frame it always did. This is also the path when the asset's
   length is unknown.
3. **reduced**: if even that is not enough the peak is lowered (not below
   1.5×), with the slow-down held to 25 % so the two give a little each; the
   report says "asked for 4×".
4. **none**: below that the cut stays a plain cut and says why (a clip too
   short to ramp, under 5 frames, or hard against both ends of its file).

A clip gives at most 40 % of its length to one side. Both sides of a cut run
the same peak (the lower of what the two can play), so speed is continuous at
the cut; a clip between two speed-ramp cuts keeps the earlier cut's peak when
the later one gives way. No frame is ever frozen: every frame advances the
source by at least 0.6 of the clip's own rate, and a test sweeps lengths,
speeds, handles and peaks for it. (A clip playing under 1× at 30 fps shows
some source frames twice, as every slow-down in the app does; that is
sample-and-hold, never a stall, and the scan above counts it.) Photos have no source to read: they only
blur and push. A clip's own sound is faded by the existing `rampGain` where
the picture runs more than 25 % from its mean speed, as ADR 0067 does for
ramps (so the first ~⅓ s of a presenter's speech under a speed-ramp head is
silent: choose a plain cut there).

### Render: one composition for preview and export

`ReelComposition` plans the reel's speed-ramp cuts once (`planSpeedRamps`,
memoised on the timeline and assets) and attaches each plan to its clip
(`PlannedClip.speedPlan`, runtime only, never saved), so the media element, the
person and object mattes (`clipSourceSeconds`) and `clipPresentation` all read
the same frames. A reel with no speed-ramp cut takes no new code path.

**Blur technique.** An SVG `feGaussianBlur` with an anisotropic
`stdDeviation` ("x y"), the same device as the whip's blur: σ up to
`blur × 56 px` (at 1080 wide) along the chosen axis, edges duplicated, applied
to the whole clip frame (its mattes carry it too, as they carry the whip's).
It is deterministic (a pure function of the frame), cheap, and only on the
ramp frames (at most 2×12 frames a cut). An angle is rendered as its x and y
components, so a diagonal is a soft elliptical blur rather than a true diagonal
streak; the named axes are exact. The push is a `scale(1 + push·i)` ahead of
the clip's own zoom and camera in the same CSS transform. A whip on the same
frame wins (a clip too short for both).

### Commands and HTTP (ADR 0048, 0068)

`setTransition { clipId, transition: "speedRamp", speedRamp?: {...} }` or
`transition: { kind: "speedRamp", preset?: "soft"|"punch", peak?, durationMs?,
blur?, push?, direction? }`. Parameters not sent keep the clip's (or the
defaults); one out of range, an unknown preset, and the first shot (no cut
before it) are refused with the reason, so a batch holding one lands nowhere.
It goes through `POST /api/reels/:id/commands` unchanged (the route's accepted
types are the core registry; the parameters are validated by the same
`applyCommand` the editor uses) and works with `dryRun`. `pace` takes
`speedRamps: true` ("Speed-ramp the strong cuts", off by default, remembered
on `music.speedRamps`): cuts that land on a downbeat in the build or the drop,
between two shots that are not held and at least 0.6 s long, and never two in a
row, whose transition is a plain cut, become speed ramps marked `auto`; the
shot before then loses pacing's own `into-cut` ramp (the transition is the
acceleration). Every pace pass clears what an earlier one placed first, and
switching it off takes back only those. The Ask prompt lists `speedRamp` too.

### Where it appears (phone first)

Transition sheet (tap a clip, Transition): "Speed ramp" next to Whip pan.
Chosen, it shows **Soft · 3×** / **Punch · 5×**, a thumb-sized **Intensity**
slider ("4× in 450 ms"; one drag is one undo step, through the command's
gesture key), the blur direction (Follow the footage / Sideways / Up and down /
No blur) with the whip's "Match the footage" button, **Play the cut** (loops
the cut, 0.9 s either side, on the stage while the sheet is open) and the
plan's note for this cut. Music: "Speed-ramp the strong cuts" under Ramp into
cuts.

### Critic and checks

The retention critic's dead-air, beat and cut-rate checks read cut times and
motion energy, none of which a ramp moves; a speed-ramp cut counts as a
transform for the stock check (it already scored any non-cut transition). The
ramped frames are blurred but lit, so they are not black, flash or frozen
(`analyseSeries`); tests assert each on a synthetic series.

## Consequences

- Saved reels are untouched: the new field, the new enum member and
  `music.speedRamps` are additive; `mediaWindow`, the ramps and the whip are
  unchanged and a reel with no speed-ramp cut plans nothing.
- `ReelAsset.durationMs` and the export payload's `durationMs` are new
  optional fields. An export queued before this lands has none and plans with
  "no source beyond the out-point" (the compensated path), while the editor, which
  knows the length, may plan with handles: the two can differ for such a job's
  ramp frames only.
- The Inspect loupe and the critic's sampled frames read the frame plain
  cuts show (`onScreenAt` has no asset lengths), so on the ~8 frames either
  side of a speed-ramp cut they can name a frame up to about a third of a
  second off what the stage draws. The stage and the export agree.
- A pre-rolled head shows footage the studio trimmed away, for up to ~⅓ s at
  speed and blurred; that is the point of the pre-roll, and it is never done
  under speech.
- The preview's playing media element is asked for the mean rate since the
  clip's first frame, capped by the plan at 16×; a hard ramp under a fast clip
  speed lowers the peak rather than exceed that.

## What was verified

See the PR for commands and numbers; summarised:

- `pnpm check` (lint, typecheck of every package, every package's tests).
- `packages/core/tests/speed-ramp.test.ts`: parameter bounds, presets and
  intensity; the curve (builds slowly, ends on the peak); the peak on the cut
  frame on both sides; the length and frame plan unchanged against plain cuts;
  every frame's exact mapping through the media window (trim whole, rate =
  mean since the first frame, never past the window or before the file);
  handles, compensated, reduced and plain-cut paths with their reports; head
  with no pre-roll, partial pre-roll, speech; a shared peak across a cut; a
  clip between two cuts; photos; composition with a clip's own ramp; a sweep
  of lengths × speeds × handles × peaks for no frozen frame; blur axes and
  push; commands (merge, `{kind}` form, presets, refusals, batch
  all-or-nothing, matchCuts follows the footage); Pace on/off/remembered/only
  its own; the critic and render checks on a ramped series.
- `packages/core/tests/speed-ramp-route.test.ts`: the real
  `/api/reels/:id/commands` route and save path (database and session
  stood in for): accepts, saves at the next revision, dry run saves nothing,
  refuses with the reason, 409, 401.
- `packages/render/tests/speed-ramp.test.ts`: the fixture takes both source
  paths, never plays a frame the file lacks or repeats one, blurs and pushes
  the frames next to the cut only, and leaves a reel without a ramp alone.
- `packages/render/scripts/speed-ramp.ts` (real Remotion, Chrome Headless
  Shell, H.264 test media): every frame across a cut drawn and not dark, the
  strip in `assets/0073-speedramp-strip.png` (testsrc2's own frame counter
  and the bars show the source mapping), and `--export` for the MP4's flash
  and repeated-frame scan and the export time against the same reel with
  plain cuts. Results: on this machine (Windows, Remotion 4.0.534, Chrome Headless Shell, ffmpeg-static with libx264), the fixture's 20 frames across the first cut all drew (mean luma 105–149, none dark) and the 225-frame export of the two-cut fixture scanned with 0 flash frames and no stall (12 single repeated frames, longest run 1, all in the compensated body where the clip plays under 1× at 30 fps; the plain-cut export has none). The ramped export took 18.9 s against 16.0 s for the same reel with plain cuts (1.19×; three runs gave 1.02–1.19×, 32 of its 225 frames are blurred). That is a Windows desktop with no GPU contention measured once; the Linux worker's cost was not measured. The blur is the whip's SVG filter at a larger σ, so a worker that renders whips fine renders this, but a reel with a speed ramp on every cut will export visibly slower than plain cuts.
- Not verified: the editor on a phone (no browser session was run for the
  sheet and the loop), a real-footage reel through the worker, audio of a
  ramped clip with its own sound (only the gain function is tested), and
  Safari's playing preview of the mean-rate media element.
