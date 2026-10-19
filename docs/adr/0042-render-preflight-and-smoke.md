# 42. Render preflight and a render smoke test

Date: 2026-10-20

## Context

Two exports of the second typography reel failed on bugs that only the
headless renderer could show: a hook called after an early return in the
title view (React error 300) and a person matte that waited for a `seeked`
event that never fires at a take's first frame. Unit tests do not mount
Remotion, the editor preview runs the Player, and typecheck cannot see
either. Each miss cost a six-minute render to find and a twenty-minute
deploy to fix. Two lint failures reached CI the same evening because the
push went out before `pnpm lint` ran.

## Decision

1. **Preflight before every export.** The worker draws the first and last
   frame of every shot as stills (`preflightReel`, `reelCheckpoints` in
   `packages/render/src/render-reel.ts`) before `renderMedia`. A frame that
   errors or hangs fails the job within seconds with a message that names
   the shot ("Shot 3 could not be drawn at its first frame: …"). Set
   `RENDER_PREFLIGHT=0` to skip it.
2. **A render smoke test in CI.** `packages/render/scripts/render-smoke.ts`
   builds a reel that uses every feature at once (words behind a person,
   a whole-shot planar pin that overlaps the next cut and fades, surface
   blend, typewriter, drift, whip, photo motion, a hook, a logo, details,
   music) from ffmpeg-made media served over local HTTP, and runs the
   preflight on it. CI runs it inside the freshly built worker image, so
   it uses the exact Chrome, ffmpeg and bundle that production will.
   `pnpm smoke [dir]` runs it locally and can keep the stills.
3. **A check before every push.** `pnpm check` runs lint, typecheck and
   unit tests. `.githooks/pre-push` runs it (enable with
   `git config core.hooksPath .githooks`; `SKIP_CHECK=1` to bypass), and
   the ship script runs it on the branch it is about to merge.

## Consequences

Exports start about 10–25 s later (a still per shot edge). A render-only
regression now fails CI on the PR, and a bad timeline fails fast with the
shot named. The smoke fixture must grow with the composition: a new
feature that is not in `smokeTimeline()` is not covered.
