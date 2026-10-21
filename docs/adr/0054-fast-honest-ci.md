# 54. Fast, honest CI: flaky specs fixed at the cause, slow checks where they matter

Date: 2026-10-21

## Context

The 45 most recent CI runs (2026-10-20 14:26 to 2026-10-21 02:14 UTC, PRs
and main; 38 that were not cancelled) measured, per job, from
`gh run view --json jobs`:

| Job | n | Median | Range |
|---|---|---|---|
| Lint, typecheck, unit tests | 42 | 1.6 min | 1.2–1.8 |
| Dependency and config scan | 43 | 0.4 min | 0.3–0.6 |
| Build and scan web image | 41 | 2.9 min | 0.7–4.4 |
| Build and scan worker image | 40 | 7.6 min | 3.7–12.1 |
| End-to-end tests | 37 | 10.6 min | 6.0–11.7 |
| Whole run, first job start to last job end | 38 | 12.5 min | up to 24.5 |

The worker job roughly doubled when its smoke gained the acceptance render
(ADR 0053). The end-to-end job was the long pole, and it was not honest:
CI retries a failed test once and Playwright then reports the run green.
Reading every e2e log of those runs for the "flaky" list:

| Spec | Passed only on retry |
|---|---|
| `ten-asks.spec.ts:12` | 37 of 37 runs |
| `scheduled-posts.spec.ts:77` (the sound picker) | 32 of 37 |
| `password-reset.spec.ts:28` | 2 |
| `scheduled-posts.spec.ts:11`, `timeline.spec.ts:29` | 1 each |

A failure that costs five minutes before the retry (scheduled-posts hit the
5-minute test timeout every time) is most of the e2e job's time.

## Decision

### 1. Each flaky spec fixed at its cause

- **ten-asks: a product bug in the rule-based stand-in, not a race.** The
  test uploads the logo in the Logo sheet, which puts it on the reel, then
  asks "move the logo to the bottom left". The stand-in
  (`fakeAiEditPlan`, `packages/core/src/ai-edit.ts`) only looked for an
  *unused* logo image, and a logo on the reel is not unused, so it answered
  "Upload your logo first, then ask again", applied nothing, and the sheet
  stayed open; the test waited 30 s for a toast that never came while the
  previous ask's toast faded. The retry passed only because the first
  attempt's upload was by then an unused `logo.png` in the demo studio. It
  failed on a fresh stack every time. Fix (2 lines of product code): the
  stand-in moves the logo the reel already has, else takes an unused one.
  Unit test: "moves the logo the reel already has, even when no unused logo
  is left". The spec's `askFor` now waits for the AI job's answer
  (`/api/ai-jobs/<id>` with DONE or FAILED) and asserts its note and that
  something was applied, then that the sheet closed and the toast shows,
  so a refusal fails at once with the refusal in the message.
  *Not fixed here:* the real model's system prompt says the same thing
  ("op logo with assetId of an unused image"), so "move my logo" with the
  real model may also be refused when a logo is already on the reel. That
  is a prompt change for the AI-edit owner, recorded here rather than made.
- **scheduled-posts (and instagram-sound): shared studio-wide state.** All
  three Instagram tests connected the pretend Instagram account to the
  shared demo studio and disconnected it in `finally`. The two tests in
  `scheduled-posts.spec.ts` start together under `fullyParallel`; the short
  one finishes in about 9 s and its `finally` deleted the connection while
  the sound-picker test was mid-way, which then waited on a click (no action
  timeout) until the 5-minute test timeout; the error was reported on the
  `finally`'s own DELETE. The one failure of the short test was the mirror
  image (`post-to-instagram` did not show `@reelwalk.test`). While
  connected, the account also changed the Music sheet's default source and
  the AI's song list for every other demo-studio test. Fix: `auth.setup.ts`
  signs up a studio of its own for these tests once a run, connects the
  pretend account, and saves its session (`.auth/instagram.json`); the
  specs use it and never disconnect. A fresh studio is on the free plan,
  which does not post to Instagram, so the dev-only
  `POST /api/dev/instagram` (404 unless `DEV_FAKE_INSTAGRAM`) comps a plain
  free studio onto Agent, as the seed comps the demo studio onto Studio
  (1 line, dev-only). The scheduled-posts tests have a 90 s timeout
  (they take 10–15 s) and the sound-picker test ends on the cancelled row's
  state instead of the toast.
- **password-reset: the test raced the sign-out.** It clicked Sign out and
  immediately went to `/login`; when the sign-out server action had not
  landed, the browser was still signed in, `/login` redirected home, and
  the Email field never appeared. It now waits for the `/login` URL the
  sign-out ends on, as the same test already does earlier.
- **Every spec:** `actionTimeout: 30_000`. A click on something that never
  appears fails in 30 s naming its locator, instead of hanging to the test
  timeout and blaming the next line.

Nothing is quarantined: no step was found to be nondeterministic in the
product.

### 2. The end-to-end suite runs when a PR touches what it drives

A "What changed" job reads the PR's file list (`gh api
repos/…/pulls/<n>/files`, renamed files under both names). The suite runs
when the PR touches `apps/web/`, `packages/core/`, `packages/db/`, `e2e/`,
the stack it starts (`docker-compose.yml`, `docker-compose.override.yml`,
`infra/nginx/`), `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the root
`package.json`, or `.github/workflows/ci.yml`. Docs, ADRs, `apps/worker`-
only and `packages/render`-only PRs skip it; the worker image's render
smoke still renders. Pushes to main always run it, and so does a PR whose
file list cannot be read.

The job is not skipped as a whole: its steps are, after one step that says
so in the job summary. So "End-to-end tests" always concludes SUCCESS when
nothing failed. `.tools/ship.sh` stops on any check whose conclusion is
FAILURE and waits until none is pending; `infra/deploy.sh` (ReelWalk-ops)
waits for the main run's images and re-runs a failed main run. Neither
treats a skipped check as failed, and with this design there is no skipped
check to treat. `main` has no branch protection today; a required "End-to-
end tests" check would also be satisfied.

`packages/render` is a dependency of the web app (the preview uses the
same composition), so a renderer-only PR can change the editor's preview
without running the suite. That was the owner's call: the worker smoke
with its acceptance checks covers the renderer, and main runs everything
before anything is deployed.

### 3. The acceptance render where it can catch something

The worker smoke's acceptance checks (`SMOKE_COMPARE=1`, ADR 0053) run on
every push to main and on PRs that touch `packages/render/` or
`packages/core/`, with the 25-minute step limit. Other PRs run the plain
smoke under 10 minutes. The `skip-acceptance` label and the
`SKIP_ACCEPTANCE` variable still turn the checks off.

### 4. Retries stay, but are not silent

Playwright keeps one retry in CI. A JSON report
(`e2e/test-results/results.json`) feeds `e2e/report-flaky.mjs`, which
writes `flaky: <spec>:<line> <title>` to the job summary and a warning
annotation per test, so a pass on the retry shows on the PR. Had this been
there, ten-asks would have said "flaky" 37 times.

## Consequences

- A docs or worker-only PR no longer waits about 11 minutes for the suite.
- A flaky test is visible on the PR the first time it happens.
- The Instagram tests sign up one studio per run. The signup limit is ten
  an hour from one address; a run now uses four (accounts ×2,
  password-reset, Instagram), so a local stack fits two full runs an hour.
- A shared, studio-wide setting is a test hazard under `fullyParallel`.
  A test that changes one belongs in a studio of its own.

## How to keep it fast

- Before adding to the e2e suite, ask whether a unit test can say it. The
  suite is for flows across the browser, the app and the worker.
- Never change studio-wide state (connections, plan, settings) in the demo
  studio; use a studio of its own as the Instagram tests do.
- Wait for state, not for a transient message: a response, a
  `data-status`, a URL. A toast is checked only after the state it reports.
- No action may wait forever; the config's `actionTimeout` makes sure.
- A test that needs more than 90 s is a sign it waits on the render queue;
  share one export across assertions instead of starting another.
- Read the "flaky:" lines in the e2e job summary. A flaky test is a bug in
  the test or the product, never noise; fix it the week it shows up.
- New top-level paths the suite depends on go into the "What changed"
  pattern in `ci.yml`.

## What was verified

- `pnpm check` (lint, typecheck, unit tests) passes locally, including the
  new core test; `actionlint` (with shellcheck) passes on `ci.yml`.
- `playwright test --list` lists the suite (37 tests in 15 files) with the
  new setup step; the e2e package typechecks.
- `report-flaky.mjs` was run on a hand-made report with one flaky test
  (summary line and annotation written), on an empty report, and on a
  missing file.
- Playwright was not run locally (Docker port forwarding is broken on this
  machine); this PR's own CI run is the proof. Measured durations from it
  are below.

### Measured on this PR

To be filled from this PR's CI run.

