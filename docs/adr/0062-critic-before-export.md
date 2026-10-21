# 62. A critic before export

Date: 2026-10-21

## Context

The export check (`instagramIssues`) knows the hard limits: length,
caption, hashtags, a title's centre in Instagram's dead zones, a title
under the details card. It knows nothing about what makes a reel get
watched: whether anything happens in the first second and a half, whether
a shot sits still for three seconds, whether a white title is on a white
wall, whether a speaking presenter's face is big enough to hold her eyes
and mouth, whether the loop jumps, whether the cuts are on the beat. The
studio finds these out after posting. Each one has a fix the editor
already knows how to make (reorder, trim, speed, move a title, a shadow,
the beat snap), so the useful thing is to point at the moment and offer
that fix, once, when Export is tapped (pro-editing area 4).

## Decision

**A pure critic in core.** `packages/core/src/critic.ts`:

- `criticSamples(timeline)` names the moments whose pixels the checks
  read, highest priority first, capped at 72: the opening every 0.5 s to
  1.5 s, the last frame and candidate loop ends, each title's middle, the
  opening pair of each later clip (to find a livelier first shot), then
  every 0.5 s of each still-camera video over 2 s, a clip's grid taken
  whole or not at all.
- `critique({ timeline, frames, faces, titleFont, measure, headline,
  sourceDurationsMs })` runs seven checks and returns findings, each with
  a severity, one plain-English line, the moment (reel ms, clip, source
  ms) for a thumbnail, the title's box when it is about a title, and fixes.
  A check that needs a frame that was not read is skipped, never guessed.
- Every fix is a document command (ADR 0048) and is tried against the
  timeline before it is offered: a fix that is rejected or changes nothing
  is dropped. Two kinds of fix are not commands: a new AI take costs a
  credit, so the face fix opens the AI sheet on that shot; and a title on a
  surface or tracked plane is reported without a move (its corners decide
  where it is), with "Show me"; so is a pinned point-tracked title, whose
  tracked path is offsets from its x/y, so moving x/y would drag it off the
  object it follows.

The checks and their thresholds (`CRITIC`, one place to tune):

| Check | Decides on | Fix (command) | Fix all |
| --- | --- | --- | --- |
| Hook | no cut, title or hook starting, and no camera move, in the first 1.5 s; for a video, the four opening frames differ by ≤ 0.02 mean luma | the liveliest later shot first (`moveClip` to 0), or the reel's name as a headline at 0.15–2.4 s (`addText`) | no |
| Safe zones | the title's box from the scene evaluator (ADR 0046), at its first, middle and last frames, reaching more than 24 px into `INSTAGRAM.safeZonePx` | centre moved so the box fits, or centred in the safe area if wider (`updateText` x/y); not for surface or pinned titles | yes |
| Dead air | a run over 2 s inside one clip with no motion (photo without a camera move, or video frames 0.5 s apart differing by ≤ 0.02) and no title starting or ending | trim the still part to 1.5 s at the clip's start or end (`trimClip`), or the next speed that brings it under 2 s (`setSpeed`) | no |
| Faces | the gate's measured face height × the clip's zoom under the floor the gate recorded for the take (`minFacePx` on each check: 165 px speaking, 120 otherwise; high), a speaking take between that floor and 220 px (low, advice only), the gate's eyes-and-mouth flag false, or its score under 0.7 | open the AI sheet on that shot (none for the advice) | no |
| Legibility | contrast of the title's colour with the frame behind its box (WCAG ratio): mean under 2 is decided bad, the brightest (or darkest) tenth at 3 or more is decided fine; 1.3× stricter for a title painted on a surface. Size: font under 14 CSS px on a 412 px phone | `updateText` shadow "strong", or blend "plain" for a painted title; size up to 14 px, moved in at the same time if the bigger box would reach a zone | yes |
| Loop | last frame vs first differ by over 0.12 mean luma, or the reel ends more than 60 ms off a bar of the song | trim the last clip (`trimClip`) to the bar line (or, with no tempo, the 0.5 s step) in its last 3 s whose frame is most like the opening | no |
| Beat | any cut more than 50 ms from the song's beat | `snapToBeat` | yes |

Label, sticker and outline titles bring their own contrast and are not
judged; a strong shadow or extrusion is already the fix. Room labels
(`room-…`) are skipped: the editor redraws them on every cut change, so a
fix to one would not last.

**Model use, minimal.** Pixels decide everything they can. A legibility
call between the two bars (a busy background, mostly dark with bright
patches) is shown as a low-severity "may be hard to read" with its fix,
and marked `undecided`. `settleUndecided(findings, judge)` sends only those
to a judge, one call each, and drops the finding if the judge reads it as
readable. The editor does not wire a judge yet; the seam is tested with a
mock. Face judgements reuse what the identity gate already recorded
(ADR 0056 and its amendment): no new model call.

**Commands.** `updateText` (a title's look or place; not a cut change, so
nothing is retimed; a missing id throws), `addText` (a duplicate id, or a
text with no time left in the reel, throws) and `batch` (steps in order,
one result, rejected whole if any step fails) join the command union.
"Fix all" is `fixAllCommand(findings)`: the first safe fix of each
finding, every change to one title merged into one `updateText` (a resize,
which places the box at its new size, applied over a move), then the snap,
as one batch: one history entry, one undo, and the critic run again
afterwards finds nothing safe left to fix.

**Face facts.** `GET /api/ai/faces?assets=…` returns, for the session's
workspace only, `criticFaceFromGeneration(row)` for the generation rows of
those assets: whether the shot has a spoken line, the smallest face height
across the accepted attempt of each composed end, the gate's score and
whether the accepted checks saw both eyes and the mouth drawn. The editor
asks only when the reel has AI takes. The floor is the gate's own number,
as it recorded it on each check; the constants (`MIN_GATE_FACE_PX`,
`MIN_SPEAKING_FACE_PX`, `minFacePx`) moved from the worker into core's
`presenter.ts`, and the worker imports them from there. Checks from before
the gate recorded its floor fall back to the shot's spoken line. 220 px is
advice above that floor, with no credit-spending fix.

**In the editor.** `use-critic.ts` runs while the Export sheet is open.
The timeline-only checks answer at once; then the frames are drawn
72×128 through the frame service (ADR 0047, `view` purpose: what the
viewer sees, fit, zoom, camera move and grade included) and read back as
luma, and the pixel checks follow ("Looking at the frames…"). Reading is
`readCriticFrames` (`critic-frames.ts`): each frame has 8 s, a source that
fails once (unreadable, tainted, timed out) is skipped for the rest of the
run and for later runs while the sheet is open, and a cancelled run stops
drawing at once. A photo's load now times out after 20 s in the frame
service, as a video's did, so it cannot hold its source's queue. Frames and
their JPEG thumbnails are cached by clip presentation and source time, so
after a fix only new moments are read. Media that cannot be read back (no
CORS) skips the pixel checks. If the critic throws, the sheet is the old
one.

The sheet's title becomes "3 things to fix"; the first three findings
show (the rest behind "N more"), each with a thumbnail of the moment (the
title's box outlined), its line, and its fix as a 44 px button. "Fix
all (n)" appears when two or more safe fixes are offered. The export
button reads "Export anyway" whenever there are findings and is always
enabled unless a hard limit blocks it, as before. The export check's
centre-point "text-unsafe" warning is hidden while the critic's panel
shows (its box check supersedes it), except for room labels, which the
critic skips; with a blocking problem the panel is hidden and the warning
stays. Tapping a thumbnail closes the sheet on that
moment, with the title or clip selected.

## Consequences

- Saved reels are untouched: the critic reads the v1 timeline and writes
  only through existing or additive commands. No schema change, no
  migration.
- Preview and export still share one composition; the critic draws
  nothing into it.
- `critique()` takes about 30 ms on a desktop for a 30-clip, 50-title reel
  with every frame read (89 findings), and runs twice per change (before
  and after the frames); a phone may be several times slower. It stays on
  the main thread for now.
- Reading 72 small frames costs up to 72 seeks. On a phone that can take
  several seconds; the timeline-only findings show first and the sheet is
  usable throughout. The cap means a long reel's later still clips may go
  unjudged for dead air.
- Room labels sit at y 0.74, about 20 px into the caption zone; the export
  check flags them, the critic does not (it cannot fix them). A follow-up
  for `addRoomLabels`.
- The thresholds are first guesses from the house style and Instagram's
  UI, not from measured retention. They are in one table to tune.
- Title boxes use the DOM line measurement the composition uses, without
  the label/sticker padding, and ignore rotation.

## What was verified

- `packages/core/tests/critic.test.ts` (29 tests), each check on fixture
  timelines with synthetic frames: the hook flagged on a still opening
  with the reorder and title fixes, silent on a cut, a title, a hook or a
  camera move, and not guessed without pixels; titles in the header,
  under the caption and too wide for the safe area moved inside it, a
  surface title reported without a move, room labels skipped; dead air on
  a still photo, at a video's end (trim) and in its middle (1.5×), broken
  by a title change, unjudged without frames; faces under 220 px, zoom
  counted, silent shots exempt, a borderline score, the eyes-and-mouth
  flag, and the gate-record mapping; legibility on bright and dark frames,
  label styles exempt, the painted-title fix, size on a phone, and the
  judge called exactly once for the one undecided finding (never for a
  decided one); the loop trimmed to the frame most like the opening and
  to a bar line; off-beat cuts snapped. For each fix: the expected
  command, the changes limited to its subject (`diffTimelines`), and the
  finding gone after it. Fix all: the safe fixes only, one batch, the
  clips equal to the snap alone. A batch with a failing step changes
  nothing; a sample run never exceeds the cap and judges only clips whose
  grid is whole.
- `apps/web/components/editor/critic-flow.test.ts`: through the editor's
  document store, one fix is one history entry and Fix all is one entry,
  and one undo restores the reel exactly.
- `apps/web/components/editor/critic-panel.test.ts`: the Export sheet's
  server-rendered markup with findings ("3 things to fix", Export anyway,
  Fix all (2), thumbnails with the box), three shown with "2 more", the
  clear state, and a hard limit still blocking.
- A static render of the sheet with five findings and the app's CSS,
  screenshotted at 412×915 in headless Chromium: every fix and Fix all is
  44 px tall, thumbnails 54×96, three findings then "2 more", Export
  anyway below.
- `pnpm check` passes.
- Review round (Opus, PR #210): a pinned title gets no move and Fix all
  leaves it alone; a small title low in the frame is resized and moved in
  one `updateText`, and the critic run again finds nothing; faces read the
  gate's recorded floor (high under it, low advice to 220, nothing above);
  `updateText` on a missing id and an `addText` with no room reject the
  whole batch; `critic-frames.test.ts` covers a failed source tried once
  across runs, a draw that never answers timed out once, a tainted canvas,
  cancellation and the cache cap; `critic-faces-route.test.ts` covers the
  route's session check, workspace scope, de-duplicated ids and that only
  the face facts leave (not the prompt or locate boxes).
- Not verified: the critic in the running editor with real footage (the
  local Docker stack was down, so no database or dev server), the frame
  reads and timings on a phone, the faces route against a real database,
  and any live model call (none is made).
