# 69. Directed presenter takes: framing, a take queue, auto-trim, direction, cutaways

Date: 2026-10-22

## Context

Wave 3, agent W3-D. Yesterday's series reels (`output/series/d2-split-the-villa.md`,
`d5-honest-listings.md` in the hybrid checkout) were built through the API with
the presenter kit cmvi0he2d000201admjnm9g4e and recorded five gaps:

1. Compose placed her thigh-up, so her face started at 150–200 px however the
   prompt was worded. The lever that worked on 2026-10-21 was a 1.6× tighter
   crop of the plate uploaded as its own asset (cmvi3jstp came back with a
   300+ px face and real eyes): the reference and the plate decide her size,
   not adjectives.
2. Two generations submitted within seconds failed at compose ("The start
   and end stills could not be composed"), and the hourly cap of ten rows
   counted those refunded failures, so one reel waited forty minutes.
3. Veo ignored tone: "deadpan and dry" came out smiling on every line. There
   was no blocking: she stood and smiled for the whole take.
4. Veo added a garbled tail after the line ("Send it, settle it, tune back
   into Hiker's List"); agents trimmed by whisper word timings by hand.
5. Nothing alternated line → b-roll → line, so a spoken take was the slowest
   picture in the reel.

## Decision

**Framing before compose.** `compose.framing` gains `close` and `tight`
(`PRESENTER_FRAMINGS` is now tight, close, medium, wide; `FRAMING_FACE_PX`
420 / 300 / 180 / 0). A spoken line defaults to close (`composeFraming`,
settled in `aiShotSchema`'s transform where the voice is known); a silent
one stays medium; a description that says "wide" stays wide. Close and
tight crop the plate before the image model sees it (`plateCropRect`, applied
in the worker's `frameArguments` for a scene only, never a reference and
never a frame Veo gets as-is): close is a 1.6× zoom (674×1200 of the
1080×1920 plate), tight 2.25× (480×852), centred and with the window's
centre at 56 % / 58 % of the height so the floor she stands on stays in.
The rule for perspective: a crop of the plate is the same camera with a
longer lens, so nothing in the picture changes shape; she is then composed
"about 2 m (1.5 m) from the camera, nearer than everything in the scene",
and the floor rule that pinned her feet to visible floor gives way to a
distance rule when her feet are out of frame (`feetInFrame`). A speaking end
is composed at least close (`speakingFraming`); after a face too small to
judge the retry is one framing closer (`escalateFraming`: wide and medium
to close, close to tight) and the plate is cropped again to match
(`recropScene`). The old `closer: 1 | 2` wording is gone; the framing text
carries the numbers. Every gate check now records the framing it was
composed at, and `GET /api/ai/generations` returns `faceHeightPx` and
`framing` from the check of the start frame Veo was given.

**A take queue, not a cap** (`packages/core/src/take-queue.ts`).
`reserveAiGeneration` no longer refuses past two in flight or ten rows an
hour; it refuses only a full queue (`AI_QUEUE_LIMIT` 12 waiting or
generating, since each holds its credits). `claimAiGeneration` locks up to
25 due rows (oldest first, skip-locked) and starts a queued take only when
`queueDecision` for its workspace says so: no other take of that workspace
composing under a live lease (status SUBMITTING, no `submitStartedAt`,
`leaseUntil` in the future), and fewer than `AI_HOURLY_SUBMISSIONS` (10)
rows with `submitStartedAt` in the last hour. Compose therefore runs one at
a time per workspace; a failure before Veo (compose, identity, a lost
claim) has no `submitStartedAt` and never counts; polling a running take is
always allowed. `queuePosition` gives each queued take its place and what
it waits for (turn, compose, hour, with the time the hour opens), returned
as `queue` on `/api/ai/generations` and shown in the AI panel
(`queueLabel`). Script mode puts every line into the queue at once; the
route's `paused: "busy"` now means a full queue, and `script-flow`'s limit is
the queue's. ADR 0049's durable AI jobs were not reused: the generation row
already is the durable record, and the queue needed only a claim rule.

**Auto-trim to the line** (`packages/core/src/take-trim.ts`). When a voiced
take arrives the worker already transcribes it with word timings
(`transcribe.ts`); now `lineTrim` aligns the line's words to the words heard
(semi-global word alignment, the heard words before and after the line
free, a word equal to another within one letter in four so "cosy" and
"cozy" agree) and stores on the asset's transcript a `take`: the line,
`startMs` = first word − 150 ms, `endMs` = last word + 250 ms (inside the
file), the words heard in that span, the normalised distance and
`wrongWords` when the distance is over 0.15. The tail Veo adds is outside
the span and so outside the trim; a pause before she speaks is skipped.
`insertPresenterTakes` places a take on its trim when it has one (the
editor passes `trim` from the asset's transcript), and the generations API
returns `take` so the panel says "Trimmed to her line: 0.15–1.90 s" or warns
"Wrong words: she said …". A take with no words heard is flagged, not
trimmed; a take made where transcription is not configured carries no
`take` and is placed whole, as before.

**Direction** (`packages/core/src/direction.ts`, `shot.direction`). Tone
(dry, warm, excited, hushed), energy (still, natural, animated), eye line
(lens, off-left, off-right), blocking (stand, walk-in-left, walk-in-right,
turn-to-object, lean-in, step-back-reveal, with an `object` for the last
two) and an optional performance reference (a clip window of at most 3 s
with a `description`). Each maps to two kinds of words: `directionStill`
goes into the composed still (the first frame fixes her expression and her
pose, which Veo continues from: "neutral and unsmiling, lips closed and
level"; "mid-stride at the left edge"; for moving blocking the last frame
gets a different pose), and `directionPrompt` goes last in the Veo prompt
as physical, repeatable instructions ("her face stays flat and unsmiling for
the whole take, lips level and closed between phrases, eyebrows still; she
never grins") rather than adjectives. `aiShotPrompt` appends it for ordinary
shots; Script mode carries one `direction` and one `framing` per script
(like the outfit) through `buildScriptShots`, and the Presenter sheet shows
Shot, Tone, Energy, Eyes and Blocking selects above the voice. `POST
/api/ai/performance` describes up to three frames of a reference clip
through the existing vision path (`structuredAnswer`) into the sentence the
prompt carries; the editor fills `direction.performance.description` with it.
What Veo honours was not measured here (see below); the mapping is the
hypothesis that physical descriptions and a still that already holds the
expression move Veo where "deadpan" alone did not.

**Cutaways** (`packages/core/src/cutaways.ts`, command `cutaways`). A clip
gains an optional `audio: { assetId, sourceStartMs, volume }` (a J-cut: the
sound under this clip is another asset from that source time at 1×, and the
clip's own sound is not played). `planCutaways(timeline, { everyMs })` cuts
every presenter take (a generated clip with its own sound) into pieces: her
picture for `everyMs`, then 1.5 s (`CUTAWAY_HOLD_MS`) of b-roll from the
reel's own footage (same room first, then nearest in the cut; never a take,
a generated clip or a 360 photo; a different window of the source each
time) with `audio` set to her take at the source time the cut happened,
then her picture again from after the hold. The reel's length is unchanged.
Ids are derived from the take's (`<take>-cut-1`, `<take>-after-1`), so
`removeCutaways` rejoins the pieces and the command is re-runnable with
another spacing or `everyMs: null` to remove them. The command goes through
`retimeTexts` like every cut change. The composition plays `audio` as a
Remotion `<Audio>` inside the clip's `Sequence` with the clip's own video
muted, in preview and export alike; `speechWindows` reads a cutaway's words
from the take under it so the music still ducks. The Presenter sheet shows
"Cutaways over her lines: none / every 3 / 4 / 5 s" once the reel has
takes. Agents: `applyCommand(timeline, { type: "cutaways", everyMs: 4000 },
{ generation })` and save through `/api/reels/:id/save`.

## Consequences

- No migration. `audio` on a clip, `take` on a transcript, `direction` on a
  shot and `framing` on frame sources are additive; every saved reel and
  generation row reads as before. A reel with `audio` on a clip rendered by
  an older composition would play the cutaway silent.
- Compose one at a time per workspace makes a four-line script four
  compose-and-gate rounds in series (a few minutes each) before the first
  Veo call is made; Veo polling overlaps. The queue cap of 12 bounds how
  many credits one workspace can hold waiting.
- The hour's cap now counts what it was meant to count. A refund path that
  reaches the fence (UNRESOLVED) still counts, since Veo may have been paid.
- Crop before compose means a close take's composite is made from 674×1200
  real pixels of the plate, upscaled to 1080×1920 before the image model
  sees it; the composite is re-synthesised at full size anyway, so sharpness
  of the backdrop was not a concern on cmvi3jstp, but a very soft plate will
  show it.
- `wordsMatch` forgives one letter in four, so a short wrong word of the
  same length ("skip" / "ship") passes; the threshold catches a different
  line, not a single near-homophone.
- Touches two files owned by other Wave 3 agents, minimally: `ducking.ts`
  (one branch reading a cutaway's words from its `audio`) and the
  composition (one `<Audio>` and a `muted` flag). W3-A owns mixing; this
  adds a source, not a mix rule.

## What was verified

- `pnpm check` (eslint, typecheck of every package, all tests): passes
  locally. Core 861 tests, worker 188, web 94.
- New unit tests: `direction.test.ts` (plate crop rectangles, even sizes,
  face targets, voiced default to close, speaking/escalation rules, the
  direction schema, prompt and still wording, and the prompt order);
  `take-trim.test.ts` (normalising, spelling drift, lead and tail, the villa
  take B tail dropped, the L5 pause skipped, wrong words and nothing heard,
  alignment inside a longer transcript, storage on the transcript);
  `take-queue.test.ts` (FIFO, one compose at a time with lapsed and fenced
  leases, failures before Veo not counting, the hour from `submitStartedAt`
  with the slot time, the queue bound, labels); `cutaways.test.ts` (take
  detection, b-roll choice and windows, the J-cut pieces and unchanged
  length, short takes left whole, remove and re-run, the command keeping a
  later title in place and the music ducking under the cutaway). Worker:
  the plate crop filter per framing and not for a Veo frame or a reference;
  compose at close for a speaking end; escalation wide → close and close →
  tight with the framing on record. Web: the script route queueing every
  take, the full-queue pause, and placement on the trim.
- Not verified: any live Gemini or Veo call. The live proof against
  reelwalking.com with kit cmvi0he2d000201admjnm9g4e (at most 6 credits) was
  not run: the deployed app runs the code before this change, and the only
  logged-in route to it is a browser session, which this worktree's brief
  forbids touching. So the measured face size at close and tight framing,
  and which direction words Veo honours, are untested hypotheses. The test
  plan when deployed: three 4 s voiced takes on one plate, (a) close +
  dry + lens + stand, (b) close + excited + walk-in-left, (c) tight +
  hushed + lean-in; read `faceHeightPx` and `framing` from
  `/api/ai/generations`, look at the `-first.jpg` composite, and watch the
  takes for the smile, the walk and the lean. Expect close ≥ 300 px and
  tight ≥ 420 px; record what Veo ignores in this ADR.
- Not verified: the Presenter sheet and AI panel in a browser at 412×915;
  the performance-reference route against a live model; a cutaway rendered
  by the worker (the composition change is read by both paths, unit-tested
  only through the pure planner).
