# 53. An acceptance harness that looks at the pictures

Date: 2026-10-21

## Context

Seventy-six slips across two typography rounds (post-mortems of 2026-10-19
and 2026-10-20) were found by the owner on a phone, not by CI. Both
reviews of 2026-10-21 named the same gap, which no rewrite closes by
itself: the render smoke (ADR 0042) builds its fixture from ffmpeg test
patterns and asserts that streams exist and the duration is right;
preflight proves that chosen frames draw, not that they draw the right
thing. Nothing compared what the composition draws as a still (what the
editor's preview is built on) with what the export encodes, nothing
checked that a tracked title stays on its plane, and nothing measured the
placing screen at phone size.

## Decision

Measure pixels, with no new dependency: ffmpeg decodes and encodes, the
metrics are written in `packages/render/scripts/acceptance/`.

1. **Frame comparison** (`packages/render/scripts/compare-frames.ts`).
   Exact frames of an MP4 by index (one ffmpeg `select` pass), scaled to
   270×480, against reference PNGs (`frame-<n>.png`). Two scores: mean
   SSIM on luma (8×8 windows, stride 4) and the worst 16-px block's mean
   colour difference. SSIM averages a small local change away; the worst
   block does not, so a title missing from one picture shows even when it
   is small. A frame fails below the SSIM floor or above the block
   ceiling. `--update` writes references; `--sheet` writes a contact sheet
   (first, ¼, ½, ¾, last of each shot, one row per shot, like the owner's
   five-frame strips). `FFMPEG` / `FFPROBE` name the binaries; the worker
   uses `ffmpeg` and `ffprobe` from PATH, and so does the harness by default.
2. **Preview matches export.** `renderReelStills` (render-reel.ts) draws
   chosen frames with the composition and the same props as `renderReel`.
   The smoke, with `SMOKE_COMPARE=1`, compares five frames of every
   exported shot with stills of those frames: SSIM ≥ 0.90 and worst block
   ≤ 24.
3. **Motion attachment.** For every planar title (pinned or surfaced) the
   smoke takes five frames of its life on its plane and draws each twice:
   with a *probe* of the title (the same title in solid magenta, without
   the surface blend or shadow, so its letters stand out from any footage)
   and without it. The difference is the glyph mask. The plane on that
   frame comes from the timeline, read the way `TextView` reads it
   (`planeFromPath`, behind the swappable `PlaneEvaluator` type, to be
   replaced by the shared scene evaluator once it lands). Glyph pixels are
   carried back through the plane's homography into the plane's own
   rectangle. A title passes when no more than 0.5% of its pixels lie
   more than 4 px (at 540 wide) off the plane (off the rectangle for a
   surfaced title, which is clipped; above or below it for one that may
   overflow sideways, which must also stay centred), and its box in the
   rectangle drifts no more than 4 px across the frames. A built-in control
   re-judges the same glyphs against a plane that slides 1.5% of the frame
   further on each frame; if that passes, the check is blind and fails.
4. **Real footage.** `packages/render/fixtures/reader.mp4`: four seconds of
   a woman reading by a fire under a window (Pexels 6984912, 540×960,
   290 KB, see `fixtures/SOURCE.md`) is the smoke's walking shot, so the
   person matte has a person and a new pinned title (`s2`, "BY THE FIRE")
   sits on a real window. Without the file the smoke falls back to the
   test pattern and says so.
5. **Baseline.** `packages/render/fixtures/baseline/` holds the first
   references (the export's ten frames, made on Windows). The smoke
   compares against them in `SMOKE_BASELINE=report` mode (default),
   `strict` fails on a difference, `update` rewrites them. CI reports only,
   because Chrome and fonts differ between Windows and the Linux image.
6. **Phone-size placing, in pixels** (`e2e/tests/phone-placing.spec.ts`).
   At 412×915 with touch, it opens the full-screen corner placing and
   reads screenshots, each region taken with and without one element (a
   stylesheet hides it), so the difference is exactly what that element
   paints: every corner handle paints at least 44×44 px; while a corner is
   dragged the loupe's disc matches the clean stage under the finger
   (mean difference < 28) and matches it better than the stage half a loupe
   to either side; nothing is drawn over the middle of the stage while
   placing, and the paused editor's play badge stays out of the centre.
7. **CI.** The worker image's smoke step runs with `SMOKE_COMPARE=1`
   and uploads the stills, the MP4, the contact sheets and
   `acceptance.json` as the `render-acceptance` artefact. The label
   `skip-acceptance` on a PR (seen on the next push) or the repository
   variable `SKIP_ACCEPTANCE=true` turns the comparison off. The phone
   spec runs in the existing e2e job.

## Consequences

A title that walks off its wall, a preview frame the export does not
reproduce, or a placing screen that is too small to use now fails a check
instead of waiting for the owner's phone. The smoke takes longer: about 40
more stills (two per attachment frame, plus the comparison frames),
roughly three to five minutes on a laptop; the CI step's limit rises to 25
minutes.

What it does not cover, said plainly:

- **The editor's Player is not the renderer.** In the editor
  `ReelComposition` plays footage through `<Html5Video>`; stills and the
  export use `@remotion/media` (`useRemotionEnvironment().isRendering`).
  "Preview matches export" here compares the composition's stills with
  the encoded export, which catches anything that differs between a single
  frame and a sequential render (mounts, mattes, pins on a cut), not
  differences between the browser's video decoding and the renderer's.
  A browser-side capture of the Player at the same frames is the next step.
- **Attachment measures the composition, not the tracker.** The fixture's
  keyframes are written by hand; the check proves the title follows its
  keyframes, not that the keyframes follow the wall. A tracker benchmark
  on real pans (review B3) is separate work.
- **Baselines are per platform.** Until CI's own frames replace the
  Windows references, the baseline comparison only reports in CI.

## What was verified

On Windows 10 with Remotion 4.0.534's Chrome Headless Shell, host ffmpeg
7.1 (`FFMPEG`) and Remotion's ffprobe on PATH:

- `SMOKE_COMPARE=1 pnpm smoke` three times. Preview against export: all
  ten frames SSIM 0.980–0.993, worst block 6–15 (limits 0.90 / 24).
  Baseline, second run against the first: shot 2 identical (SSIM 1.0000),
  shot 1 (real footage with the person matte) SSIM ≥ 0.997, worst block
  ≤ 3.1.
- Attachment, with the probe: "BY THE FIRE" (on the window), "OCEAN VIEWS"
  (pinned, overflowing its plane, fading out) and "STEP OUT" (surfaced, with
  posts) drift 0.5–1.1 px with no glyph pixel off the plane; the faded last
  frame of "OCEAN VIEWS" is recognised as faded. The first version
  measured the titles as drawn (white, hard-light) and read a 5 px drift
  on "STEP OUT" that was the letters vanishing into a pale background, not
  movement; the probe fixed the measurement.
- The controls caught a sliding plane every time (drift 10.5–22.8 px
  against the 4 px tolerance). The third run passed end to end in 289 s.
- `compare-frames.ts` from the command line against the baseline: ok, and
  exit 1 for a frame with no reference or a tolerance too tight. Against
  stills of the wrong frames (18 frames apart in one shot, across a cut)
  it fails them: SSIM 0.35–0.73, worst block 49–230.
- 13 vitest cases for the metrics, the attachment judge (including a title
  that stays put while its plane moves) and the placement reader.
- The phone spec type-checks; it has **not run** locally: Docker
  Desktop's port forwarding on this machine accepted and closed every
  published port (5432, 8080, 8081, 3000), so no stack was reachable. Its
  first run is CI's e2e job.
