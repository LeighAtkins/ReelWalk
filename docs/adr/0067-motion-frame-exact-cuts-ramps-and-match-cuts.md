# 0067 - Motion: frame-exact cuts, speed ramps, eased camera moves and match cuts

Date: 2026-10-22

## Context

Wave 3's direction is retention, and retention lives on motion. The reels
the agents built this week (`output/series`, 2026-10-21/22) show the gap:
stock clips that are static or slow pans, the only motion tools a linear
Ken Burns zoom and the whip transition, and no way to make a cut land on
the fast part of a move or to carry a camera move across a cut.

Under all of it, a renderer bug every agent had to work around: a cut
20–30 ms off a frame boundary (3025 ms, 11333 ms, 22167 ms in D1, D3 and
D4) rendered one black frame, titles still drawn, just before the cut. The
agents snapped every cut to a 100 ms grid (`frame-grid.js`), which fights
the beat grid: the critic's "snap to the beat" fix was left unapplied on D5
because it would bring the black frame back.

### The black frame

`framePlan` (timeline.ts) gives each clip's `Sequence` a rounded `from`
and a rounded length, `round(end) − round(start)` in reel frames. The
media inside trimmed itself on its own rounding of the clip's *source*
window: `trimBefore = round(sourceStartMs)`, `trimAfter =
round(sourceEndMs)`. The two roundings do not agree. A clip 1020–4045 ms at
1× is 3025 ms, 91 frames as a sequence (0–90.75 rounds to 91), but 31–121
as a media window, 90 frames. `@remotion/media`'s `getTimeInSeconds`
returns no frame once the sequence time reaches `(trimAfter −
trimBefore) / fps`, so frame 90 of the sequence, the last before the cut,
asks for a picture the window does not have. When no picture arrives the
media's canvas is simply not redrawn: a page that already drew an earlier
frame of the shot keeps it, a page meeting the shot for the first time
(a fresh mount, a decode path that draws nothing) shows the black
background. The titles are separate sequences, so they still drew.

That mismatch is certain (the unit test shows the old window one frame
short at the owner's cuts). Whether it is the *only* way the owner's
exports got their black frame is not: on this machine the old trimming,
rendered as stills with both decode paths (WebCodecs, and the
OffthreadVideo fallback forced with MPEG-4 Part 2 media), still drew the
frame before the cut, because the still had an earlier frame of the shot
on its canvas. The worker (Linux, no GPU, concurrency) is where it showed.
The fix removes the mismatch at its source; the regression script below
is the check to run on the worker's path, and the first re-export of a
series reel with its cuts on the beat grid (no 100 ms snap) is the proof
that matters.

## Decision

### Frame-exact cuts: round in one place (`packages/core/src/frames.ts`)

`mediaWindow(clip, frame, durationInFrames, fps)` is the one place a
clip's source window becomes what the media element is asked to play. The
window is derived from the sequence's length, never from the end time:
`trimBefore = round(sourceStartMs)`, `trimAfter = trimBefore +
durationInFrames × speed + 1`. `(trimAfter − trimBefore) / playbackRate ≥
durationInFrames` always holds (`windowShortOfSequence` is the test's
check), so no frame of a sequence is ever without a picture, at any speed,
whatever the cut's millisecond. `clipSourceFrame` is the matching formula
for *which* source frame a sequence frame shows; the mattes' clock
(`clipSourceSeconds`, occluder.ts) and the editor's loupe
(`onScreenAt`, view.ts) read the same maths, so a frame named by one is
the frame drawn by the other.

Cuts need no grid any more. The agents' `frame-grid.js` workaround and the
critic's "snap to the beat" caveat can go.

### Speed ramps (`packages/core/src/ramp.ts`)

A clip's `ramp` (additive, nullable) is a curve of relative speed over its
on-screen time `p` 0..1: 2–12 keys `{ p, v }`, linear between keys. The
curve is normalised, so the clip still plays `sourceStartMs..sourceEndMs`
in `clipDurationMs` at a mean of `clip.speed`: every length, start and
beat the editor knows stays exact; only *where* the clip is at a given
frame changes. `rampWarp(ramp, p)` is the integral (source fraction at
`p`), `rampUnwarp` its inverse, `rampSpeedAt` the relative speed. Presets:
`slow-in`, `slow-out`, `into-cut` (hold, then the last 40 % races so the
cut lands on the fast part), `hold-snap` (hold, snap to 3× over 4 % of the
clip, stay fast), `hit` (fast on frame 0, settling by a third in).

The composition plays a ramped clip through `mediaWindow`: the rate at
frame `f` is the mean rate from the clip's first frame to `f`, because a
media element reads its time as `trimBefore + frame × rate`; that lands
every rendered frame exactly on `clipSourceFrame`. In the editor's playing
preview the element runs at that rate and the player's drift check pulls
it back onto the curve; paused frames are exact. A clip's own sound is
faded by `rampGain` where the picture runs more than 25 % from its mean
speed, to silence at 75 %: a ramp never plays chipmunk or dragging audio,
and the browser's pitch preservation handles the rest. Splitting a ramped
clip gives each piece the part of the curve it played (`sliceRamp`).

The pacing engine (ADR 0059) takes `ramps`: a video in the build or the
drop (or anywhere, with no sections, from Steady up) that has no ramp of
its own gets `into-cut`, so beat-cuts land on the fast part. Held clips and
the hero are left alone. "Ramp into cuts" is remembered on the music
(`music.ramps`, additive) so later Energy changes keep it; switching it off
takes back the `into-cut` ramps.

### Eased camera moves (`packages/core/src/camera.ts`)

A clip's `camera` (additive, nullable) is keyframed scale and position:
2–8 keys `{ p, scale ≤ 2, x, y (± 20 % of the frame), ease }` with
`linear`, `in`, `out`, `in-out` and `snap` easing into each key.
`cameraKeysAt` is the one function the composition, the editor's frame
service (`clipPicture`, now with a vertical shift) and the mattes read.
Presets: `push` (slow, even), `push-settle` (fast in, overshoot, settle),
`drift` (lateral across a closer picture), `snap` (closer over the first
tenth, on the beat the cut is on, then hold). When a clip has a `camera`,
its Ken Burns `motion` is not read; a saved reel without one renders
byte-for-byte as before (`cameraMoveAt` is unchanged).

**Motion on frame 0.** The opening shot is marked `opening` through the
composition; a move that would ease out of a standstill
(`cameraStillAtStart`) is read from a tenth of the way in
(`openingProgress`), so the first frame already moves. The presets all
move from frame 0 by themselves and are not shifted.

### Match cuts (`packages/core/src/match-cut.ts`)

`summariseMotion(frames)` turns the five small grey frames the editor
already samples per clip (motion.ts, ADR 0034/0052) into a `ClipMotion`:
camera velocity at the start and the end of the shot, the moving subject's
position (what changed after the camera's own shift is taken out), and the
energy pacing uses. `matchCutScore(a, b)` (−1..1) is the cosine between
a's final and b's opening motion, weighted by how much both move, plus a
little for the subject sitting in the same place; a shot that moves into a
still one scores against. `suggestMatchCuts(timeline, motion)` gives the
pairs that cut well, a greedy chain from the opening shot (held clips keep
their slots), and the whips whose direction should follow the footage.
`cutsWellAfter` is the Add media chip: after which shots a library video's
opening carries on the move.

**Whip only when motion matches.** A whip's direction names the camera's
pan; content travels the other way, so content leaving to the left is a
camera panning right (`whipDirectionFor`). A shot that barely moves gives
no direction, and the editor says a plain cut will read better.

### Commands and HTTP

New commands (ADR 0048): `setRamp { clipId, ramp: preset | keys | null }`,
`setCamera { clipId, camera: preset | keys | null }`, `setTransition
{ clipId, transition, whipDirection? }`, `matchCuts { motion, reorder?,
whips?, heldClipIds? }`, and `pace` takes `ramps`. A command for a clip or
a preset that is not there is refused, so a batch holding it is all or
nothing; a command type this build does not know is refused rather than
passed as "nothing changed".

`POST /api/reels/:id/commands` runs `{ commands: Command[], revision?,
dryRun? }` against the saved reel as one batch (or `{ command }` for one,
the ADR 0068 shape; both go through the same route and `applyReelCommand`),
with the library's source lengths and transcripts, and saves the result the
way autosave does (the reel's current revision when none is sent; 409 on a
conflict, 400 with the reason when a command is refused). `dryRun: true`
answers with the result and saves nothing, so an agent can ask `matchCuts`
for its suggestion first. The
clips' motion is measured in the browser (`clip-energy.ts`,
`measureClipMotion`); an agent that builds reels from a script measures
with the same `summariseMotion` on frames of its own.

### Where it appears (phone first)

- **Speed sheet** (tap a clip, Speed): the ramp presets under the speed,
  with a thumb-sized graph of the speed across the clip.
- **Camera motion sheet**: an "Eased move" row (Off, Slow push, Push then
  settle, Drift, Snap zoom) above the simple moves; choosing a simple move
  switches the eased one off.
- **Transition sheet**, on a whip: "Match the footage" reads the shot
  before and turns the whip its way, or says the shot barely moves.
- **Timing sheet**: "Cut on the motion" measures every video and runs
  `matchCuts` (shots with speech or the presenter keep their place).
- **Music**, under Energy and On the beat: "Ramp into cuts".
- **Add media**: a video whose opening carries on the motion of shot 3 is
  chipped "after 3"; the reel and the library's videos are measured in the
  background while the sheet is open.

## Consequences

- Saved reels render as before: `ramp`, `camera` and `music.ramps` are
  additive and absent on every existing reel; `motion`, `speed` and the
  Ken Burns maths are unchanged. The only rendering change for an old reel
  is the one it needed: the frame before an off-grid cut now has its
  picture.
- `mediaWindow` asks the media for one frame past the sequence; a clip cut
  at the very end of its source asks for a frame the file does not have.
  `@remotion/media` holds the last decoded frame there, as before for
  clips at the end of a file.
- A ramp's playing preview is only as exact as the player's drift check;
  the exported frames and every paused frame are exact.
- Measuring motion reads five frames of every video (at most 16 in the
  reel, 12 library candidates), the same cost Energy already paid. The Add
  media chips wait for it in the background.
- The frames the pacing engine measures now also carry direction, so
  `clipEnergies` is derived from `clipMotion` and no second measurement is
  made.

## What was verified

- `pnpm check` (lint, typecheck of every package, every package's tests)
  passes. New tests in `packages/core/tests/motion-tools.test.ts`: the
  media window is never short of the sequence at the owner's cuts (3025,
  11333, 22167 ms) at 1×, 2×, 0.5× and 1.5×, and the old rounding was one
  frame short on such a cut; every ramp preset warps 0→0 and 1→1, rises
  monotonically, has a mean speed of 1 and inverts; the composition's
  per-frame rate lands every frame on the curve; the mattes' clock agrees;
  audio gain; split pieces keep their part of the curve; eased keys and
  the opening-shot phase; the view contract carries the vertical shift
  both ways; Ken Burns presets unchanged; match-cut direction, score,
  whip direction and the chain from synthetic flows; the commands,
  batches and refusals; pacing's ramps on the build and the drop with
  every cut still on the beat, and "Ramp into cuts" remembered and taken
  back. `packages/render/tests/black-frame.test.ts` checks the render
  fixture's cuts are off the frame grid and every checked frame is inside
  a media window.
- `packages/render/scripts/black-frame.ts` draws, with the real renderer,
  the two frames before and after each of the three cuts and every shot's
  first and last frame (14 frames, the first shot ramped `into-cut`, the
  second on `push-settle`, the third whipping in), and with `--export`
  encodes the reel and scans every frame of the MP4 the way the agents'
  `flashscan.sh` did. Run on this machine (Windows, Remotion 4.0.534,
  ffmpeg from imageio): all 14 frames drew with mean luma 105–140 on H.264
  media through WebCodecs, the same through the OffthreadVideo fallback
  (`--codec mpeg4`), and the 725-frame export scanned with 0 flash frames.
- The same script with the old trimming put back (temporarily, on the same
  fixture) also drew every frame as a still, on both decode paths: a still
  carries an earlier frame of the shot on the media canvas, so the
  shortfall cannot show there. The regression is therefore proven at the
  maths (unit tests) and the fix at the renderer, but the black frame
  itself was not reproduced on this machine. The first worker export of a
  series reel with cuts on the beat grid, scanned with `flashscan.sh`, is
  the proof that matters; if it still flashes, the cause is elsewhere and
  the script here is where to look next.
- Not verified here: the editor on a phone (no browser run in this
  worktree), the `commands` route against a running app (its pieces,
  `applyCommand` with `batch` and `saveReelFor`, are the tested ones), and
  a reel with real footage ramped and exported through the worker.
