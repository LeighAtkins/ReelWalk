# 71. Score retention, not style: render checks and a verification API

Date: 2026-10-22

## Context

The critic (ADR 0062) grades a checklist and misses what decides whether a
reel is watched. It flagged "add a shadow" on every boxed title (a box
paints its own background), offered a beat snap that moved cuts to
fractional frames (which the renderer drew as a black frame with the titles
still on it), and said nothing about dead air, a picture that does not
move, text held long after it is read, a cut rate drifting from the song, or
an opening that is empty at frame 0. Meanwhile the agents that build the
owner's reels verified every export blind: ffmpeg frame strips, offline
black-frame scans, contact sheets made outside the app. Every "verified"
line in `output/series/d*.md` cost ten to twenty minutes of outside tooling,
because the app had no way to hand back a frame or a fact about a render.

## Decision

**Three pure modules in core, one node library in the web app, two routes,
a gate, a view.** Nothing saved changes; no migration.

### Render checks (`packages/core/src/render-checks.ts`)

A render is read as a `FrameSeries`: small grey frames (72×128, the critic's
sample size) at reel times, dense from the file or sparse from the editor's
samples. `analyseSeries` measures the facts, `renderChecks` turns them into
checks with a level (`block` | `warn`) and an impact (`hook` | `hold` |
`finish`), and `postBlockReason` gives the Post button its line.

| Fact | Decides on | Level |
| --- | --- | --- |
| Empty first frame | frame 0 near-black (mean ≤ 0.035, p95 ≤ 0.1) or one flat colour (std ≤ 0.015) | block |
| Black frame | a near-black run of ≤ 4 frames between lit frames (the renderer's glitch, not a fade) | block |
| Title under the buttons | a title's box (scene evaluator, ADR 0046) more than 24 px into Instagram's right column | block |
| Title in a dead zone | the same into the header, caption or edge | warn |
| Frozen picture | the same picture (difference ≤ 0.004) held over 1.5 s inside a video clip | warn |
| Opening title arrives slowly | the first title starting in the opening 300 ms is not fully in by 300 ms, by the hook planner's reading of the composition's entrances (`titleLegibleAtMs`, ADR 0068: a pop settles at 150 ms, a fade 600, a rise 500, the typewriter 14 characters a second) | warn |
| Loop jumps | last frame vs first differ by more than 0.12 | warn |
| Ends mid-bar | the end more than 60 ms off a bar of the song | warn |
| Sound | W3-A's audio-trace problems, folded in by `withAudioProblems` when that route answers | as given |

The facts also carry motion energy per second (the largest frame step in
each second, scaled to a 500 ms span), the per-title zone reach in px, the
opening title's legibility time and the frames measured. The decode is
ffmpeg's and is one argument list, `checkDecodeArgs`: the image2pipe muxer
with the rawvideo encoder, `-r 30`, and only the scale and format filters,
because the trimmed ffmpeg Remotion ships has neither the rawvideo muxer
nor the fps filter and an agent on a laptop should be able to run this with
it. `seriesFromGreyFrames` reads the bytes back. `judgeTimesMs` names the
Judge view's moments, opening on the hook planner's `HOOK_FRAME_MS`. `checksKeyFor` puts the result beside the export:
`renders/<job>.mp4` → `renders/<job>.checks.json`.

### Retention proxies (`packages/core/src/retention.ts`)

`retentionFindings` replaces the style checklist with what costs watch
time, computed from the timeline and, where it has them, the frames. Every
finding is a `CriticFinding` with an impact tag and a fix that is a document
command (ADR 0048), tried by `critique` before it is offered.

| Proxy | Rule (`RETENTION`) | Fix |
| --- | --- | --- |
| Dead air | over 1.2 s with no cut, no motion (≤ 0.02 over 500 ms, or a photo without a camera move), no speech (transcript words, or a voiced take) and no title starting or ending | trim to the still part, the next speed that ends it, or a slow push in (`updateClip`) |
| Reading time | words × 250 ms + 400 ms; a title gone before that is held longer (safe); one held over 3× that plus 2 s with nothing new arriving is shortened (not safe); tracked, counting and room titles are left alone | `updateText` endMs |
| Cut rate | the median shot length in each song section against the pacing engine's bands (ADR 0059); 2× too long drags, 2× too short races; spoken takes are left out | `pace` |
| Beat | cuts more than 50 ms off a beat | `frameExactSnap`: a batch of `trimClip`s to frame-exact beats, never within 60 ms of another cut, never under the minimum clip or past a source's end |
| Presenter | a presenter take (AI id, or listed) on screen over 6 s with no cutaway and no title arriving | open the media sheet on that shot |
| Opening | frame 0 empty (from the series, or W3-C's hook facts when given) is high; a title not readable by 300 ms is given a pop entrance, or, when it already pops, started earlier so it is in by 300 ms | `updateText` animation or startMs |
| Untouched stock | `transformScoreOf` (zoom, speed, camera move, grade, a window inside the file) under 0.2 on a clip over 1.5 s; W3-E's measured score replaces the guess | slow push in |

### The false positives

A box or tag title is never judged for contrast, whatever its shadow
setting and whatever is behind it. The beat fix is the frame-exact snap
above; the old `snapToBeat` command is no longer offered.

### Verification over HTTP (`apps/web/lib/render-verify.ts`)

For the signed-in studio's own exports:

- `GET /api/renders/:id/frames?t=0,0.5,1.5&w=270` — JPEGs at reel times
  (seconds, `1500ms`, a negative value counts from the end, `end` is the
  last frame; up to 24, snapped to the frame grid). One time answers a
  JPEG; several answer JSON with a data URL each; `&sheet=1` answers one
  JPEG with the frames side by side in the order asked. The times served
  are in `X-Frame-Times`.
- `GET /api/renders/:id/checks` — the `RenderChecks` the worker stored
  beside the export, or, with ffmpeg on the server, computed once for an
  older export and stored; `?fresh=1` recomputes. The response carries
  `source` (`stored` | `computed`), `gate` and the sound's problems from
  `GET /api/reels/:id/audio-trace` when that route exists (a feature check:
  anything but 200 means not available, and the checks say so).

The export is downloaded once to a cache under the OS temp dir, keyed by a
hash of its object key (immutable: a retry renders to a new key), and every
frame cut from it is kept there; entries untouched for six hours are swept.
ffmpeg is `FFMPEG_PATH` or `ffmpeg` on PATH; without one the frames route
answers 503 and the checks route serves what the worker stored. The web
image installs ffmpeg (one `apk add` line).

### After every export, and the gate

The worker runs `verifyRender` after the loudness pass of every REEL or
STORY export and stores the JSON at `checksKeyFor(objectKey)` with the
file; a failure there never fails the render (`RENDER_CHECKS=0` skips it).
The export screen shows the checks under the actions ("Checks", with the
impact tag on each, and "Run checks" for an older export). When a hard
check fails, `startInstagramPost` and `schedulePost` refuse with the reason
and `blocked`; the Post and Schedule buttons read the reasons from the page
(or from the refusal) and become "Post anyway" / "Schedule anyway", which
send `postAnyway` and are logged as one JSON line
(`{"event":"post-anyway",…}`) with the reasons. The gate reads stored
checks and, with ffmpeg, computes missing ones; a verification failure
never loses a post.

### Judge view (`/reels/:id/judge`)

The reel and its variants (ADR 0063), each as its opening (0, 0.5, 1,
1.5 s) and its last 1.5 s cut from the export itself through the frames
route, in a horizontal strip, with the checks underneath. Phone first: the
strip scrolls, every control is a 44 px button, nothing sits on the frames.

## Consequences

- No schema change. A render gains one sibling object in storage.
- The worker's export takes a few seconds longer (the decode of a 30 s reel
  is about two seconds; the checks under 50 ms).
- The web image gains ffmpeg (about 70 MB). Until it is deployed, the
  frames route answers 503 in production and the checks route serves only
  what the worker stored; older exports get checks the first time an agent
  or a tap asks with ffmpeg present.
- The retention thresholds are first guesses from the house style and the
  pacing engine, in one table to tune against measured retention.
- Title boxes on the server use the character-count measure (no DOM), so a
  zone reach there can differ by a few px from the editor's.
- The checks route makes one same-origin fetch to the audio-trace route
  with the caller's cookie; it is bounded by a 4 s timeout.

## What was verified

- `packages/core/tests/render-checks.test.ts` (16): per-frame facts on
  synthetic sequences (black and flash frames, an empty frame 0, frozen
  pictures, the loop seam, motion per second), the hard checks and the
  verdict, `postBlockReason`, the grey decode read back as frames with a
  partial tail dropped, the Judge moments on short and long reels, the
  checks key.
- `packages/core/tests/retention.test.ts` (17): reading time; dead air
  from the timeline alone and from frames (1.2 s let go, 1.3 s not, no
  frames no judgement); cut rate against the pacing bands with spoken takes
  left out; the snap frame-exact, clear of other cuts, within the clip
  minimum and the source; the presenter over 6 s; the opening from the
  series and from the hook planner's facts, and a late pop started earlier;
  the stock transform score; and
  the old false positives: a boxed or tag title never gets a shadow finding,
  and every snapped cut is on the frame grid.
- `packages/core/tests/critic.test.ts` (32): the existing checks with
  the retention findings and impact tags folded in.
- `apps/worker/tests/verify.test.ts` (2): the decode arguments, a black
  opening found and blocked from a synthetic stream, a clean render passed
  with its frames counted.
- `apps/web/lib/render-verify.test.ts` (13): `t=` and `w=` parsing, the
  frame arguments and the 10 ms early seek, cache names, the stored shape,
  the gate, stored-first / no-compute / no-ffmpeg paths, `fresh`, the
  post-anyway log line, the audio trace in either shape and its merge, the
  Judge `t=`.
- The five series renders (D1–D5), run through `computeChecks` and the
  Judge strip with Remotion's bundled ffmpeg
  (`apps/web/lib/render-verify.live.test.ts`, `VERIFY_RENDERS=…`): see the
  PR body for the findings per render and the strips.
- `pnpm check` passes.

Not verified: the routes and the Judge page in a running app (the local
Docker stack was down, so no database or dev server); the worker's
verification on a real export in ECS; the gate against a live Instagram
account; the audio-trace merge against W3-A's real route (its shape is read
defensively); ffmpeg in the web image (the Dockerfile line is added, not
built here).
