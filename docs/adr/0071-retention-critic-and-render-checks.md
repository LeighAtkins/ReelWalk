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
| Title under the buttons | a title's drawn box (scene evaluator, ADR 0046; the wrapped lines plus the style's padding, see the amendment below) more than 24 px into Instagram's right column; the reason names the measured right edge and the column's | block |
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
- Title boxes on the server have no DOM to measure in: they sum the
  renderer's own faces' advance widths (`font-metrics.ts`, the amendment
  below), so a zone reach there can differ by a few px from the editor's.
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

## Amendment (2026-10-22): zone reach uses the title's drawn extent

The first live run blocked all five series reels with the same line: every
hook title "reaches 44 px under the like and share column", including
labels centred at x 0.5 whose box ends 30 px short of the column on the
render. Three causes, all in how a title's box was derived, none in the
frame facts.

- **The wrap column was taken for the box.** The renderer centres a
  sentence's words in a column 86 % of the frame wide (928.8 px, ADR 0046),
  and `titleGeometry` used `min(column, unwrapped width)` as the box: for
  any sentence wider than the column the box was the column, whose right
  edge at 1004.4 px is 44.4 px past the column of buttons at 960 px. So
  every centred sentence that wrapped was "under the buttons", always by
  44 px. The same box fed the critic's safe-zone check (ADR 0062), the hook
  rules' zones (ADR 0068) and this gate. Now `screenTitleExtent` wraps the
  words greedily at spaces with the measure (as the browser does, inside
  the column less the style's padding) and the box is the longest line plus
  the padding a label or sticker draws (`TITLE_PADDING_EM`, from look.ts).
  One case keeps the column, measured in Chromium with the renderer's own
  CSS: the words sit in a flex item of the column, as wide as its words
  until they wrap and then the column; a label or a sticker paints its
  background on that item, so a boxed sentence that wraps really draws a
  928.8 px label (76 px to 1004 px) and the gate keeps blocking it, with
  the edges in the reason.
- **The server's measure was 0.62 em a character for every face.** The
  serif the owner's reels use (Cormorant Garamond) is 0.45 em a lowercase
  letter, so the server saw one-line labels as two-line ones and sentences
  as wider than they are. `font-metrics.ts` now holds the advance width of
  each printable character for the renderer's three title faces at the
  weights and stretches look.ts uses, measured once in a headless Chromium
  from the same @fontsource files the composition loads
  (`packages/core/scripts/font-metrics.mjs`). `estimateLineWidth` sums them
  for a known family and falls back to 0.62 em otherwise; it does not apply
  kerning, so a line can read a few px wide of the drawn one, never narrow.
  Measured against Chromium's own layout of the owner's titles the sums are
  within 1 %; against the D4 render's label box, within 2 %.
- **A surface title was its whole plane.** The words on a surface are
  fitted to 94 % of its width or 92 % of its height, whichever binds, and
  centred; a wide, low strip (D1's snow quads reach x 0.95 and 0.99) drew
  words a third narrower than its corners. `surfaceTextQuad` maps the fitted
  text block through the plane's homography (clipped to the plane where a
  chosen surface clips the words) and that is the box.

The elegant face's own 0.06 em letter spacing is drawn but was not in the
`TitleFont` the measures saw (only a title's `tracking` was); the four
builders of that font (render, editor critic, web verify, worker verify)
now carry a style's spacing when the title has no tracking of its own
(`letterSpacingEm`).

The gate's reason says what it measured, so a wrong box is visible from the
Post button's line: "… reaches 32 px under the like and share column: its
right edge is at 992 px, the column starts at 960 px." `facts.zoneReach`
carries the box's four edges in px.

Verified: `packages/core/tests/scene.test.ts` (wrapping, the padding, the
clamp of a one-line title), `render-checks.test.ts` (D4's real label
records pass; the same label at x 0.9 still blocks, with the edges in the
reason; a header warning names its edge), the whole core suite; the five
series timelines as saved by the owner's scripts through the web verify
path: D4 clean, D1/D2/D3/D5 lose their 44 px blocks, and what remains is
within a few per cent of the zone edge, where the live timelines (edited
after the scripts were saved) and the renderer's own placement decide.
Not verified: the live routes against the deployed renders.
