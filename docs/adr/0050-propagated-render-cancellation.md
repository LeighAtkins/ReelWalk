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
  whatever is still held (newest first, each release bounded by the grace)
  and throws the stop reason, whether or not the work ever settles.
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
  binaries (via `/proc`), SIGTERMs the whole set at once, waits the grace,
  and SIGKILLs what is left. It is a no-op where there is no `/proc`.
- **Reporting waits for cleanup.** The handler writes `requeue`/`fail`/
  `succeed` and changes the message's visibility only after `runAttempt`
  has settled, so neither the lease nor the message is handed on while the
  old attempt still holds anything. The heartbeat keeps running during the
  grace, so the job does not look stale meanwhile.
- **SIGTERM hands the job back.** A render stopped by shutdown is
  re-queued with no backoff (`delivery.extend(0)`) and reported as the new
  outcome `interrupted`, not as a failed attempt.
- **Grace is configurable**: `RENDER_ABORT_GRACE_SECONDS`, default 10,
  which keeps unwind plus reporting inside the 30 s ECS stop timeout.
- Attempt-scoped publish (`store.ts`, the per-attempt output key) is
  unchanged.

## Consequences

A timed-out or stopped attempt costs at most the grace (plus up to one
grace per resource that refuses to release) before its job is retried, and
the retry no longer shares the task with a zombie render. SIGTERM now stops
the current render instead of letting it run: on Kubernetes, where the
worker's `terminationGracePeriodSeconds` is 300, a rollout interrupts and
re-queues an in-flight render that might have finished. SIGTERM on the
last allowed attempt still spends that SQS receive, so the next receive
dead-letters it; the receive count is not ours to give back. The webpack
bundle step and in-process transcription (onnxruntime) cannot be
interrupted; they are bounded and leave no processes, and the attempt is
reported after the grace regardless. W4 and later job kinds can reuse
`createAttemptScope`, `runAttempt`, `ownChild` and `run({ scope })`.

## What was verified

- `pnpm check` (lint, typecheck, all unit tests) passes.
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
