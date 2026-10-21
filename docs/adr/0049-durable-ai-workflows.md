# 49. Durable AI workflows in the worker

Date: 2026-10-21

## Context

Long AI requests (Ask, the autopilot polish, Director reviews) were started
by `startAiJob` (ADR 0021): the route wrote an `AiJob` row and ran the work
in an unawaited promise inside the Next.js process. The Director route
duplicated that with its own request identity and payload hash (ADR 0034).
A deploy or crash of the web process lost the work silently; polling then
called a five-minute-old job "failed" without cancelling it or writing the
transition, so the paid request could still finish afterwards. The
Director's "make it for me" loop (ADR 0037) kept its round, credit tally and
stop flag in a component ref, so closing or reloading the tab ended the run
and lost its position. The 2026-10-21 review ranked this second in the web
app; its first milestone was "one Director review survives a web restart
with no duplicate submission".

The render worker already has the machinery this needs (ADR 0045): an
outbox-fed queue, attempts as leases, conditional publish, stale-heartbeat
reclaim and a dead-letter path.

## Decision

**Persisted runs and steps.** `WorkflowRun` is what the studio asked for
(one Ask, one autopilot polish, one Director review, or a whole Director
run); `WorkflowStep` is a unit the worker executes. Request identity (the
browser's request id plus a SHA-256 of the stable-stringified payload)
belongs to the run and each step, and is separate from execution attempts:
the same id and payload resume, the same id with a changed payload is
refused (409). States are QUEUED → RUNNING (lease) → SUCCEEDED | FAILED |
UNRESOLVED. The run has a persisted cancel flag, baseline generations,
approval time and budget fields (`budgetCredits`, `spentCredits`,
`reservedCredits`; `reservedCredits` is reserved for a later step and
unused today), and the Director loop position (`round`, `maxRounds`). Steps
are indexed by (kind, status) for the sheet's pending list and by (status,
updatedAt) for the reaper. The migration is additive.

**The invariant: a submitted paid request is never retried
automatically.** Right before every real provider fetch (`structuredAnswer`
for OpenAI and Claude, which covers room labels, the edit plan and the Opus
review), a provider gate (`lib/provider-gate.ts`, AsyncLocalStorage around
the step) writes `submittedAt` under the step's lease; if the lease was lost
or the run was stopped it throws and nothing is sent. Every response, even
an error status, counts as an answer. Then:

- step code may not resend inside the gate: `askForChange`'s one transient
  retry is skipped when `insideProviderGate()` (it still applies in-process);
- failure before any submission: ordinary retry with backoff, then FAILED;
- failure after submission with every request answered (the answer was
  refused afterwards): FAILED, definite;
- failure while a submitted request is unanswered (timeout, connection drop,
  attempt deadline), a stale lease on a submitted step, or a dead letter for
  one: UNRESOLVED. The claim query itself excludes `submittedAt IS NOT NULL`,
  so no code path can run such a step again. Only the studio can ask again,
  which is a new request id. Step code that turns a lost answer into a polite
  `{ ok: false }` (as `askForChange` does) is settled UNRESOLVED too while a
  sent request is unanswered.
- the attempt deadline aborts the gate's `AbortSignal`: requests in flight
  are cancelled (their fetch signal is combined with it) and no new paid
  request can start, so a step given up cannot keep spending.

The rules are pure functions in `packages/core/src/workflow.ts`
(`decideAiStepDelivery`, `decideAiStepFailure`, `decideAiStepDeadLetter`,
`canWorkflowTransition`, `decideRequestIdentity`) and are tested there.

**Execution in the worker.** A new message type
`{ type: "ai-step", stepId, generation }` travels on the render queue
through the same outbox. `handler.ts` gains only a dispatch branch;
`apps/worker/src/ai-jobs.ts` claims, heartbeats, runs, publishes and
settles with the same lease shape as renders (step, generation, attempt,
RUNNING), and handles AI dead letters. It uses the attempt lifecycle of ADR
0050: the attempt number comes from the claim (a per-step counter), the
step runs under `createAttemptScope` + `runAttempt`, the deadline
(`abortAfter`) and SIGTERM (`linkAbort` on the worker's shutdown signal)
abort the scope, whose signal is the provider gate's (in-flight requests are
cancelled, no new one starts). On shutdown a step that sent nothing is
requeued and handed back (`delivery.handBack`, no delivery spent); a step
that sent a request is never handed back: unanswered it is UNRESOLVED. Stale leases are reclaimed by the
existing redelivery path (visibility timeout + stale heartbeat), not by
polling. The step logic is not copied: `apps/web/lib/ai-steps.ts` is the one
implementation; the legacy in-process path and the worker both call it. The
worker imports it through `@/*` → `../web/*` in its tsconfig; that module
tree is kept free of Next.js (`mediaScope` moved to `lib/media-scope.ts`
for that). The image copies `apps/web/lib` and links its `node_modules` to
the worker's, which now also lists `sharp` and the SES client.

**Behind a flag.** With `AI_JOBS_DURABLE=1`, new jobs from the Ask,
autopilot and Director routes go through the durable path; responses keep
their shapes (`{ ok, jobId }`, the job id is the step id). Without it
nothing changes, and in-flight `AiJob` rows finish as before. Turn the flag
on only after the worker with this code is deployed and has the AI keys.

**The reaper.** A step whose message is gone (dropped by an older worker
image, deleted) would otherwise wait forever. Every worker runs
`reapAbandoned` from its outbox loop at most once a minute, starting five
minutes after it boots (messages waiting for it are delivered first). The
outbox row is deleted once relayed, so an empty outbox does not mean the
message is lost: a QUEUED step may be waiting in SQS behind long renders.
So a never-sent QUEUED step untouched for `AI_STEP_REAP_SECONDS` (default
30 min) gets a fresh message (the claim is conditional, so a duplicate is
discarded) and its clock restarts; it is FAILED only once it is older than
the queue's retention (`AI_STEP_QUEUE_RETENTION_SECONDS`, default 4 days as
in `queue.tf`), when no message for it can exist. A RUNNING step whose
heartbeat has been silent that long is FAILED if never sent and UNRESOLVED
if sent. Every write is conditional on the row not having changed since it
was read. A dead letter for a step a live worker holds is no longer deleted
("wait"): it reappears and settles the step if that worker dies.

**One request id per user action.** `runAiJob` gives each call (one tap) a
request id, keeps one the caller brought (the Director sheet's), and resends
a start that got no response or a 502–504 with the same id. The routes pass
it to the durable run and to the in-process `AiJob` (whose id becomes
`<kind>-<requestId>`), so a retried POST resumes instead of paying twice.

**Polling reports persisted state.** `/api/ai-jobs/<id>` answers a durable
step's state (QUEUED, RUNNING, DONE, FAILED, UNRESOLVED) and never judges by
age. An old in-process job past five minutes is reported as `RUNNING` with
`possiblyStale`, which the client shows with the old message, and nothing is
written. `DELETE /api/ai-jobs/<id>` sets the run's cancel flag.

**The Director run is persisted.** "Make it for me" with the flag on starts
a `director-run` (`POST /api/reels/<id>/director/runs`, consent and budget
recorded); each review is a step of it, added under a row lock that checks
the run is not stopped, not busy, within its rounds, and that the review
starts from the run's expected baseline, and at most one review per round
(reviews ≤ round + 1). A second tab refused with `busy` or `reviewed`
follows the run (re-reads it and waits for that review) instead of ending
it; a run's ending is recorded as what happened (SUCCEEDED only when the
loop decided it was done, FAILED otherwise, or stopped). Endings are
conditional writes: a stale tab's "finish" is refused (409, with the current
run) once the run was stopped, has ended, or has a review going. After the sheet applies a review
and starts its shot, `advance` records the round, the shot's credits
(quoted from the stored plan, never from the browser) and the generation it
waits for. The sheet reads all of this back, so after a reload or a web
restart it shows the run and continues it from the server's position;
re-approving the same review and shot reuses its generation (ADR 0034), so a
resumed run never pays twice. The credit ledger and the approval route's
budget check are unchanged. Frames are still sampled in the editor tab, so
the loop advances only while a tab drives it (ADR 0037's limit).

**Proposal contract (for W3's `applyProposal`).** Every successful Ask,
autopilot or Director result that proposes a timeline carries
`baselineGeneration: string`, `timelineGeneration(baseline)` from
`@reelwalk/core` (a 2×53-bit hash of the parsed, key-sorted timeline). The
Director result also carries `baseline` and `timeline`. A proposal may be
applied only when `baselineMatches(currentTimeline, result.baselineGeneration)`
holds; otherwise the editor refuses and asks again. Existing fields are
unchanged; `baselineGeneration` is additive.

## Before turning on AI_JOBS_DURABLE=1

1. **Worker AI settings (ops).** The worker task needs `AI_PROVIDER`,
   `ANTHROPIC_MODEL`, `OPENAI_MODEL` and the `ANTHROPIC_API_KEY` /
   `OPENAI_API_KEY` secrets; today only the web app has them, so a durable
   step would fail with "not set up on this deployment". The Terraform diff is
   prepared in PR #194's description (worker env and secrets, an
   `ai_jobs_durable` variable feeding the web app's `AI_JOBS_DURABLE`). It is
   not applied and not committed.
2. **Cold-start latency.** Workers are Fargate tasks started on demand
   (`RENDER_JOBS_PER_WORKER=1`, 2 vCPU, Chrome and Whisper in the image, idle
   exit after 240 s). An Ask with no worker up waits for a task start and
   bills at least the idle window, and it queues behind any render. Follow-up
   ADR: an always-warm, small AI-only consumer (its own queue or a
   `type` filter) or concurrency above one for AI steps. Until then expect
   Ask to start in tens of seconds rather than at once.
3. **Allowance on lost requests.** Every review creates its `AiEdit` row
   ("director-pending") before the Opus call, and Ask counts `AiEdit` rows,
   so a FAILED or UNRESOLVED step still uses one of the month's AI requests.
   There is no refund path; decide whether UNRESOLVED should refund the
   allowance (credits for Veo are separate and unaffected).
4. Deploy the worker with this code first: an older worker image cannot read
   `ai-step` messages (they go to its dead-letter path, and the reaper settles
   the steps later).

## Follow-ups

- Step code abandoned at the attempt deadline can still finish a database
  write it had started, such as `directReel` saving its `AiEdit` record just
  before the deadline, so a review can appear in the Director's history for a
  step that is FAILED or UNRESOLVED.
- The worker gate's own `beforeRequest` does not check the abort signal; only
  `beforeProviderRequest` (in front of every provider fetch) does. Equivalent
  today, since every paid request goes through `structuredAnswer`.
- `labelRooms` swallows its own errors, so a room-label request that was
  answered with a refusal still looks unanswered to the gate if a later
  `{ ok: false }` follows; the step is then UNRESOLVED rather than FAILED.
  Conservative, but it asks the studio to retry something that was definite.
- The eight Postgres-backed worker tests (`ai-jobs-store.test.ts`, including
  the reaper's SQL) are skipped without `DATABASE_URL`, which includes CI
  today; they were run by hand against Postgres 16.

## Consequences

- AI steps share the render queue and its one-job-per-pod worker, so an AI
  step can wait behind a render. A separate queue (or concurrency) is the
  next step if that matters.
- An UNRESOLVED step may in fact have been charged and answered; the
  Director's answer is still saved in `AiEdit` by `directReel` if it
  arrived, and shows in the sheet's history. We prefer that to paying twice.
- Ask and autopilot payloads are stored in the step; Director frame images
  are stored until the step ends, then removed (timestamps and hashes stay).
- The worker image grows by `sharp`, the SES client and `apps/web/lib`.
- Not done: a server-side Director loop (needs server-side frame sheets),
  `reservedCredits` holds, and a web UI to cancel an Ask in flight.

## What was verified

- `pnpm check` passes (lint, typecheck, all package tests).
- Core: `workflow.test.ts` (transitions, unresolved-never-retried, stale
  reclaim, dead letters, request identity, baseline mismatch, run budget and
  stop) and `provider-gate.test.ts` (the gate runs before the provider fetch,
  an error status counts as an answer, a dropped connection does not, a
  refusal sends nothing).
- Review fixes: `ask-gate.test.ts` runs the real `askForChange` inside the
  gate with a provider stub that drops after sending (one fetch, no resend;
  two fetches in-process; nothing sent once aborted);
  `ai-request-identity.test.ts` (one id per action, reused across a network
  error and a 502, passed by the Ask route to the run and the in-process job);
  `director-run-routes.test.ts` (endings recorded as failed/succeeded/stopped,
  a stale tab's ending refused, a review refused with its reason); the reaper
  in `workflow.test.ts` and against Postgres (a 45-minute-old queued step with
  an empty outbox is re-enqueued, not failed; past retention it is failed);
  the review cap per round; "may still be running" when no start got a
  response.
- Worker: `ai-jobs.test.ts` in the style of `handler.test.ts` (claim, defer,
  stale reclaim, unresolved on stale submitted, retry before submission,
  unresolved after an unanswered submission, failed after an answer, attempt
  deadline, Stop before and during, swallowed refusal, lost lease, dispatch
  from `handleDelivery`/`handleDeadLetter`), and `ai-jobs-store.test.ts`
  against a migrated Postgres (conditional claim, single submission, publish
  under the lease only, image stripping, reclaim, submitted never claimed,
  fresh leases untouched, requeue only unsubmitted, persisted Stop).
- Local run on an isolated Postgres and ElasticMQ with `DEV_FAKE_AI`:
  `scripts/durable-ai-demo.ts start` recorded an Ask and exited (a retried
  POST resumed the same step; a changed payload under the same id got 409);
  a fresh process polled `QUEUED`; the worker, started afterwards, ran it and
  a fresh process polled `DONE` with `baselineGeneration`. A step left
  RUNNING with a stale lease after submission was marked UNRESOLVED by the
  worker without being run. An invalid payload was retried twice and then
  FAILED, never submitted.
- Not verified: a live Opus review through the worker (no keys locally), the
  Director sheet's saved run in a browser, and the worker Docker image build.
