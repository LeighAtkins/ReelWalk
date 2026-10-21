# 50. Propagated cancellation in the render worker

Date: 2026-10-21

## Context

The render handler raced each attempt against the job deadline with
`Promise.race`. When the deadline won, the attempt was marked failed and
re-queued, but nothing told the render to stop: headless Chrome (through
Remotion), its compositor, ffmpeg children and S3 transfers kept running
and kept the task's CPU and memory. The retry, on this worker or another,
started while the old attempt was still going. SIGTERM (an ECS task stop,
which kills the task 30 s later) only stopped the poll loop and hoped the
current render would finish in time; it never does. ffmpeg calls had their
own 15-minute timeout (review of 2026-10-20), on a separate code path.
Attempt-scoped output keys and the lease-guarded publish (ADR 0045) already
made a late attempt harmless to the data; this is about the resources.

## Decision

- **One scope per attempt** (`apps/worker/src/lifecycle.ts`). An
  `AttemptScope` carries an `AbortSignal` and a registry of owned
  resources (temp dirs, child processes, anything with a release function).
  `runAttempt(scope, work)` settles only after the scope is closed: on
  success it closes the scope and returns; on abort it gives the work
  `graceMs` to unwind through its own `finally` blocks, then releases
  whatever is still held and throws the stop reason, whether or not the
  work ever settles. Work that finishes during the grace keeps its result.
  `close()` releases newest first within one shared budget of `graceMs`
  (each release is told what is left); releases still waiting when it runs
  out are started without being awaited, so each still sends its kill. A
  stopped attempt is therefore reported within 2 x grace.
- **One abort path.** The job deadline (`abortAfter`), SIGTERM
  (`linkAbort` on the worker's shutdown signal) and a tool's own timeout all
  end in the same place. The first two abort the scope with an
  `AttemptStopped` whose `why` is `deadline` or `shutdown`; `run()` treats
  its timeout and its attempt's abort the same way (kill the process group,
  settle once the process has exited).
- **The signal reaches every long step.** `renderJob` takes the scope.
  S3 `GetObject`/`PutObject`/`HeadObject` get `abortSignal` and the download
  pipeline gets `signal`; every `run(...)` (ffmpeg, ffprobe, loudness,
  thumbnail, transcript audio) gets the scope, spawns its child in its own
  process group, registers it with the scope, and SIGKILLs the group on
  abort. `preflightReel`, `renderReel` and `renderStubReel` accept an
  optional `signal` (defaults unchanged) that drives Remotion's
  `makeCancelSignal`, which stops the compositor and stitcher and closes
  the browser Remotion opened. Steps that deliberately swallow their errors
  (thumbnail, transcript, render-source copy) re-throw the stop reason.
- **A backstop for Chrome.** Remotion closes its browser fire-and-forget,
  so the render path also registers a release that finds this process's
  descendants whose command matches Chrome, `headless_shell` or Remotion's
  binaries (via `/proc`), SIGTERMs the whole set at once, waits half its
  budget, SIGKILLs what is left and waits the other half. Zombies count as
  gone. It is a no-op where there is no `/proc`.
- **Reporting waits for cleanup.** The handler writes `requeue`/`fail`/
  `succeed` and changes the message's visibility only after `runAttempt`
  has settled, so neither the lease nor the message is handed on while the
  old attempt still holds anything. The heartbeat keeps running during the
  grace, so the job does not look stale meanwhile, and stops before the
  report, so a late tick cannot re-hide a message just handed on.
- **SIGTERM hands the job back without spending an attempt.** A render
  stopped by shutdown is re-queued in the database and its message is
  replaced by a fresh copy with the same generation (`Delivery.handBack`:
  SendMessage, then DeleteMessage), whose SQS receive count starts at 1, so
  rolling deploys cannot push a healthy job past the redrive limit (3) into
  the dead-letter queue. The outcome is the new `interrupted`. If the
  hand-back fails the message is made visible again instead (which does
  spend a receive).
- **The attempt is a claim counter.** Because a handed-back message's
  receive count restarts, the lease attempt (and so the output key
  `renders/<job>-<attempt>.mp4`) can no longer be the receive count: the
  claim increments `RenderJob.attempt` and the lease carries that. Retry
  limits and backoff still use the receive count, so only real failures
  count against `RENDER_MAX_ATTEMPTS`.
- **Drain before stopping**: `RENDER_SHUTDOWN_DRAIN_SECONDS` (default 0)
  lets the current render run that long after SIGTERM before it is stopped.
  `RENDER_STOP_TIMEOUT_SECONDS` (default 30, ECS's default `stopTimeout`)
  states how long the platform waits before SIGKILL, and the worker refuses
  to start unless drain + 2 x `RENDER_ABORT_GRACE_SECONDS` (default 10) + 5
  fits in it. The Helm chart sets 270 / 300 to match the worker's
  `terminationGracePeriodSeconds: 300`, so a Kubernetes rollout lets most
  renders finish. On ECS the task definition should state `stopTimeout = 30`
  explicitly (it is the default today; see the PR for the Terraform line).
- Attempt-scoped publish (`store.ts`) is unchanged.

## Consequences

A timed-out or stopped attempt costs at most twice the grace before its
job is retried, and the retry no longer shares the task with a zombie
render. On ECS, SIGTERM stops the current render rather than letting it be
killed mid-way 30 s later; on Kubernetes the drain lets it finish first.
`RenderJob.attempt` now counts claims within a generation; a manual retry
resets it to 0 (web), so output keys can repeat across generations, as they
already could with the receive count. A changed `stopTimeout` must be
mirrored in `RENDER_STOP_TIMEOUT_SECONDS`. The webpack
bundle step and in-process transcription (onnxruntime) cannot be
interrupted; they are bounded and leave no processes, and the attempt is
reported after the grace regardless. W4 and later job kinds can reuse
`createAttemptScope`, `runAttempt`, `ownChild` and `run({ scope })`.

## What was verified

- `pnpm check` (lint, typecheck, all unit tests) passes.
- Hand-back (`cancellation.test.ts`): three shutdowns in a row leave the job
  QUEUED each time, each fresh message has receive count 1 and none is made
  visible again, and the fourth delivery succeeds; the attempts were 1, 2,
  3, 4 with four distinct output keys. A render that finishes within the
  drain is published; one still running when the drain ends is stopped. No
  heartbeat extend lands after the hand-back.
- `lifecycle.test.ts`: four hanging releases close within one grace and
  all start; work that finishes during the grace keeps its result; the
  delayed `linkAbort` and its cancel. `config.test.ts`: the stop-timeout
  check.
- `apps/worker/tests/cancellation.test.ts`, against the real handler with a
  recording job store: a render that hangs and ignores its signal while
  holding a fake browser, a real child process and a real temp dir is
  aborted at the deadline; the child has exited, the temp dir is gone and
  nothing is held at the moment `requeue` runs; `requeue` and the
  visibility change come after the browser release and the child's exit; a
  cooperative render is reported promptly without waiting out the grace;
  an abort of the shutdown signal mid-render releases everything and leaves
  the job QUEUED with the message visible again and not deleted; a
  successful attempt is never aborted and releases what it held before
  `succeed`.
- `apps/worker/tests/lifecycle.test.ts`: `run()` kills its child on abort
  and on its own timeout and settles after the exit; the grace and
  release ordering of `runAttempt`; a hung release cannot hold an attempt;
  the `/proc` walk.
- `apps/worker/scripts/cancel-smoke.ts` in the worker image
  (`reelwalk-ai-worker:local` with this branch's worker sources and
  `render-reel.ts` copied in), deadline 6 s counted from the first render
  progress, grace 5 s. Just before the deadline the tree under the worker
  held headless Chrome and five helpers, Remotion's compositor ffmpeg and
  the script's own ffmpeg. The attempt settled 2.6 s after the deadline;
  afterwards only the two in-process esbuild services (tsx and the
  bundler) remained, plus Remotion's ffmpeg as a zombie (`Z`, exited, not
  yet reaped by Node), and the temp dir was gone. Earlier runs found two
  bugs fixed here: `execFile` ignores `detached`, so `run()` now uses
  `spawn` (checked in the image: a shell's two grandchildren die with it on
  abort); and the backstop counted zombies as alive and sent its SIGKILL
  after its release window had closed, leaving a Chrome behind once when
  Chrome failed to connect under load.
- Not exercised for real: SIGTERM to a running worker container (covered by
  the handler test only) and an S3 transfer interrupted mid-flight.
