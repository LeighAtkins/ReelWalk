# 0094 - Our own renders on the owner's PC; Fargate Spot for everyone else

Date: 2026-10-29

## Context

October's ECS Fargate bill was $12.83. The workers are 2 vCPU / 8 GB tasks, started on demand by the web app
(`apps/web/lib/render-capacity.ts`, ADR 0015). Each task exits after `WORKER_IDLE_EXIT_SECONDS` = 240 s without work.

Most of that bill is our own experiments. In the 30 days to 2026-10-29, 1,050 of the 1,233 render jobs in production
came from the owner's @reelwalking workspace (`cmuy51nnw000h01adf9ks11xo`), read-only query. The owner (29 Oct):

> ECS Fargate is high — couldn't we just render locally for the savings? If we get users it'll go up but it'll be for
> real users. Just change that for our local renders, it'll probably be way quicker too. Make sure it works like that
> for my account leigh.atkins1@gmail.com too.

The owner's PC is shared. The Last Mile game and other agents use it for heavy work, and they agree on one lock:
`C:\dev\lm\.heavy.lock`. You take it with `mkdir`, write an `owner.txt`, refresh that file while you hold it, never
steal the lock, and wait 60 s before taking it again.

## Decision

### 1. Route by workspace, at enqueue time, through the outbox

The web app asks `renderRouteFor(workspaceId)` which queue a new job belongs on, and stores the answer as the job's `route`. `queueRenderJob` follows it. It writes the
message to the outbox under topic `render-jobs` (the cloud queue, unchanged) or `render-jobs-local` (new). The route
goes back to the caller, and `ensureWorkerRunning(route)` starts no Fargate task for a local job. The relays send
each topic to its own queue:

- the web app's `flushOutbox` relays both topics;
- a cloud worker relays both topics;
- a local worker relays only `render-jobs-local`.

A local message relayed after the policy was switched off goes to the cloud queue.

Only render jobs are routed: exports, previews and story cuts. The following stay on Fargate, because they need
Google credentials only the task role federates, and they spend most of their time waiting on an API, not the CPU:

- durable AI steps (ADR 0049);
- Veo generations, polled from the database;
- the nightly backup.

**Who is local:** the workspaces listed in `LOCAL_RENDER_WORKSPACES`, and nothing else. The production value is a
Terraform variable with a default, so `ship.sh` applies it with no tfvars edit:

- `local_render_workspace_ids` = the @reelwalking studio and Last Mile (`cmvny3ai60000bkuumm4q6nha`), the two
  workspaces leigh.atkins1@gmail.com owns. They were resolved read-only from the production database.

The same list scopes what the PC's IAM user may write (`local/<id>/*`, section 3). Routing and permissions therefore
cannot disagree, and a new studio of ours is added to the list.

Before review round 2, the list also took owner emails (`LOCAL_RENDER_EMAILS`): every workspace a listed person
owned, looked up per enqueue with a bounded, cached query. That was dropped, for two reasons:

- IAM cannot follow an email, so a workspace routed by email would have been one the PC could not write for;
- the cache could hand out a stale answer after an ownership change.

**The route is decided once and stored on the job.** The web app decides it before the transaction that writes the
job, as a list check with no lookup, so it cannot fail or slow an export, and nothing is cached that could go stale.
It is written to the job's new `route` column. Everything after that follows the stored route, never the current
list: the outbox topic, the fallback, and the PC worker's hand-off.

**Why environment variables decide who is local, not a DB flag or SSM.**

- **A DB flag** needs a migration. `ship.sh` does not apply migrations, so the new code would read a column that does
  not exist until someone applies it by hand, and that failure would sit on the export path. A flag would also make
  "who renders where" an admin write with no review trail.
- **SSM read at runtime** adds IAM, caching and a failure mode on every enqueue.
- **Environment variables** fail safe: unset means everything goes to the cloud. Changes go through review and a
  Terraform apply, and the list changes perhaps once a year.

### 2. Fallback: a stalled local job is re-issued on the cloud queue

On each `/api/ready` health check, at most once a minute per instance, the web app runs `rescueStalledLocalRenders`.
It finds jobs whose stored `route` is "local" and that are in either state:

- QUEUED, last updated more than `LOCAL_RENDER_FALLBACK_SECONDS` (600) ago: nobody claimed it, because the PC is off
  or the worker is stopped;
- RUNNING, with a heartbeat that old: the PC slept or was switched off mid-render.

It moves each one with one conditional write. The write flips `route` to "cloud", keeps the job QUEUED (or puts it
back to QUEUED), bumps its `generation`, and adds a cloud-topic outbox message for the new generation. Then it flushes
the outbox and reconciles Fargate (`atLeastOne`).

Selecting by the stored route has two consequences:

- **A moved job is a cloud job and is never moved again,** however long it then waits for a Fargate task. Before the
  route was stored, it was moved again every 10 minutes.
- **The rescue does not depend on the policy.** It moves a job sent to the PC even if the lists, or the workspace's
  owner, changed while the PC was off. It runs on every web instance whether or not the policy is set.

Bumping the generation is what makes the move safe without touching the local queue:

- the message still sitting there names an old generation, and whichever worker later receives it discards it
  (`decideDelivery`);
- a render still running on a PC that has just woken cannot publish, because its lease no longer matches. Its next
  heartbeat sees that and stops the render (`AttemptStopped`). It also publishes nothing it already made:
  - a preview's rendition and frame thumbnail go to keys of that run's own
    (`previews/<ws>/<asset>-<job>-g<generation>a<attempt>.mp4`);
  - the asset is pointed at them only inside `store.succeed`'s lease-checked transaction, together with the job's
    success.

  Before this, a preview run overwrote the shared preview key and updated the asset before its lease was checked;
- a local worker that claims the job in the same instant wins the race: the conditional write matches nothing and
  nothing moves.

A fallback that peeked at the local queue instead would count every peek as an SQS receive, and receives drive the
dead-letter redrive.

### 3. The local worker

The worker gains `WORKER_MODE=local`, which:

- consumes `SQS_QUEUE_URL` (the local queue) and its DLQ;
- does not run the AI video loop or the AI step reaper;
- relays only local outbox messages;
- never exits for idleness.

**It renders only for its own workspaces, and writes only under them.**

- Every key a PC run writes goes under `local/<workspaceId>/` (`localKeyFor`): the export with its checks and
  audio, a preview, a frame thumbnail, a re-encoded render source. Its IAM user may write nowhere else. Readers follow
  the keys stored on the rows, so the cloud's key layout is unchanged.
- A job of a workspace not on its `LOCAL_RENDER_WORKSPACES` (the list changed after the job was queued) is handed to
  the cloud at once, unclaimed.
- Render sources: the PC reads the shared `render-sources/<asset>.mp4` cache when it exists, and otherwise makes its
  own under its prefix.

**Every object a run uploads is recorded before the upload** (`RenderArtifact`, kind "run"; render sources are
"cache"). Recording a key again makes its record new, because an export's key repeats when a failed job is retried.
Once a minute the web app sweeps the records:

- a record more than `RENDER_ARTIFACT_GRACE_HOURS` (24) old whose key nothing references (no asset's preview or
  thumbnail, no render output) is the file of a run that lost its job or died. The record is deleted first, and only
  if it is still old; then the object, with an export's checks and audio, is deleted from storage;
- a referenced record is simply dropped.

Account deletion also deletes every recorded object of the workspaces it removes, render-source caches included.

With `HEAVY_LOCK_DIR` set, it takes the shared lock before it claims each job (`apps/worker/src/local-delivery.ts`,
`heavy-lock.ts`):

- **taking it:** `mkdir`, then writes `owner.txt` and reads it back in the same step. The line is
  `reelwalk-local-worker <ISO time> render <job> container=<id> pid=<pid> start=<start time> boot=<kernel boot> #<token>`;
- **holding it:** rewrites `owner.txt` every 4 min;
- **releasing it:** after the handler returns, when the attempt's scope has closed and Chrome and ffmpeg have gone. It
  is removed only if `owner.txt` still carries our token;
- **after release:** waits 60 s before taking it again.

**The wait is bounded.** The job stays QUEUED while the worker waits, with its message kept hidden. After
`HEAVY_LOCK_WAIT_SECONDS` (480, under the 10-minute fallback), the worker hands the job to the cloud with
`handOffLocalRender`, the same conditional local→cloud move the fallback uses, and deletes its local message. The job
was never claimed and the cloud message starts a fresh receive count, so no attempt is spent. A shutdown while waiting
hands the message back to the local queue.

Before this, the worker claimed the job first and then waited for the lock, with no bound. It heartbeated all the
while, so the fallback took it for healthy. A lock left by a dead worker therefore stranded the job: attempts burned
without rendering.

**It never steals another holder's lock, and removes one of its own only on proof of death.** `owner.txt` records
the holder as `container=<full id> pid=<pid> start=<process start time> boot=<kernel boot id>`, read from `/proc`
inside the container. A worker may remove a lock only when all of these hold:

- it names our owner and this same container;
- it is not this very process;
- the recorded process provably no longer exists. From inside the same container, `/proc/<pid>` is gone, or now
  belongs to a process with another start time, or the kernel has booted since.

Anything it cannot read or prove leaves the lock alone:

- an unreadable `/proc`;
- another container, whose processes it cannot see;
- a missing identity (a worker not in a container never removes anything).

Before review round 2 a different random boot token counted as proof, and it was not: a second live process in the
same container lost its lock.

On the host, `start.sh` removes a lock that names our worker and a full container id only on positive evidence:
`docker inspect` reports it not running, or "No such object". Any other Docker error leaves the lock. Before round 2,
a failed `docker ps` read as "container gone".

**Removal itself cannot take a live lock.** The cleaner first takes a sibling `.cleanup` directory, which serialises
our cleaners. It then renames the lock to a tombstone, which is atomic, and checks that the tombstone holds exactly
the `owner.txt` it judged dead. If not, someone took the lock in between, and it is renamed back. Acquisition is the
atomic `mkdir`, so a cleanup and an acquisition never both succeed on the same lock.

`infra/local-worker/start.sh` is the one-command setup:

- it runs the image of the live `reelwalk-worker` task definition, so the worker matches the production schema;
- its plain settings come from the same task definition;
- the worker runs as its own IAM user, `reelwalk-local-worker`, not reelwalk-app. `start.sh key` writes that user's
  key to `~/.reelwalk/aws-credentials` without printing it, and is safe to run again:
  - runs are serialised by a guard directory;
  - it keeps a key the PC already holds;
  - it refuses to mint a second key while IAM holds one the PC lacks, unless given `--replace`, which deletes those;
  - it writes to a temp file, checks it, and moves it into place, so a failed AWS call installs nothing and blocks no
    retry;
- `DATABASE_URL` goes from SSM straight into `~/.reelwalk/database-url`;
- both files are mounted read-only and read by the container (`AWS_SHARED_CREDENTIALS_FILE`, and `cat` in its
  command), so neither is in its environment for `docker inspect` to show;
- the heavy lock is mounted from `C:\dev\lm`;
- it refuses to start against a deployed image that predates this ADR;
- `stop`, `status` and `logs` need no settings and work from a fresh shell.

The dev stack gets the same pieces: a `render-jobs-local` ElasticMQ queue and a `worker-local` service under the
`local-render` profile.

### 4. Everyone else: Fargate Spot, shorter idle

`startWorkerTasks` launches with capacity provider `FARGATE_SPOT`, then launches on-demand `FARGATE` for whatever Spot
did not place: a `failures` entry such as "Capacity is unavailable", or an outright refusal such as a cluster without
the provider. `ECS_SPOT=false` (`worker_spot`) turns Spot off. The cluster gets both providers
(`aws_ecs_cluster_capacity_providers`). The nightly backup keeps `launch_type = "FARGATE"`.

**A reclaimed Spot task loses no job.** Fargate sends SIGTERM two minutes before reclaiming. The worker task now has
`stopTimeout` = 120 s (ECS's longest) and `RENDER_SHUTDOWN_DRAIN_SECONDS` = 90, so most renders finish before they
are stopped. A render still running then is stopped, the job set back to QUEUED, and its message handed back as a
fresh copy. That is the ADR 0050 shutdown path, and the hand-back does not spend one of the job's attempts. The next
reconcile, from the ready check within a minute, sees the message and starts another task.

**Reclaims cannot restart a job for ever.** Each hand-back is counted on the job (`interruptions`):

- **after one,** while any QUEUED or RUNNING cloud job has been interrupted, the launcher starts on-demand Fargate,
  not Spot (`interruptedJobWaiting`). If it cannot count, it also launches on-demand;
- **after `RENDER_MAX_INTERRUPTIONS` (3),** a shutdown counts as an ordinary failed attempt, so the job ends in
  FAILED and the dead-letter queue like any job that keeps failing.

A new generation (a manual retry, or a move to the cloud) starts its budget at 0.

If the task dies without the signal, the message reappears after its 120 s visibility timeout. The job's heartbeat
is stale by then, so the next worker reclaims it (ADR 0001/0003).

`WORKER_IDLE_EXIT_SECONDS` drops from 240 to 90. A warm task still catches an export queued within 90 s of the last
one. Past that, keeping the task alive costs more than a cold start.

### Infrastructure

`infra/terraform`:

- queues `reelwalk-render-jobs-local` and `-local-dlq`, with the same lease, retention and 3-receive redrive as the
  cloud queue;
- both queue ARNs in the `reelwalk-app` policy, for the web role and the cloud workers, which relay to the local queue;
- the IAM user `reelwalk-local-worker` (`local_worker_iam.tf`). It may:
  - receive, delete, change visibility on and send to the local queue and its DLQ;
  - get any object in the media bucket;
  - put (and abort multipart uploads) only under `local/<id>/`, for each id in `local_render_workspace_ids`.

  It may not touch the customers' queue or objects, list the bucket, or delete anything. Its read reach is no wider than the
  database URL it needs anyway. Its key is made by hand, so it never enters Terraform state;
- the worker task's `stopTimeout` = 120 s, with `RENDER_SHUTDOWN_DRAIN_SECONDS` = 90 and
  `RENDER_STOP_TIMEOUT_SECONDS` = 120;
- `LOCAL_RENDER_QUEUE_URL` for web and worker;
- `LOCAL_RENDER_WORKSPACES` for web and worker, and `LOCAL_RENDER_FALLBACK_SECONDS` for web;
- `ECS_SPOT` for web;
- the cluster's capacity providers;
- outputs for the new queue URLs.

## Consequences

- **What it should save.** Our own renders (about 85% of October's jobs) no longer start Fargate tasks. The rest run
  on Spot, which costs about 70% less than on-demand Fargate, and each task's idle tail shrinks from 240 s to 90 s.
  That should bring the render bill to a dollar or two a month until real users arrive.
- **Our renders are faster when the PC is on:** no 60–70 s cold start, and more cores than a 2-vCPU task.
- **When the PC is off, our renders wait 10 minutes,** then run on Fargate as before.
- **A render waits while Last Mile holds the heavy lock.** That is the trade the lock exists for.
- **There is a migration, and it must run BEFORE the new code deploys.** It is
  `20261030010000_render_job_route`:
  - `RenderJob.route` and `interruptions`, and an index on `(route, status)`;
  - the `RenderArtifact` table.

  It is additive with defaults, and the old code ignores the new columns and table, so applying it early is safe. The
  new Prisma client reads both columns on every render-job query, so the new code cannot work without it.
  `ship.sh` does not apply migrations.

  RenderJob is about 2.6 MB in production, so the plain `CREATE INDEX` takes a moment. The script sets a
  transaction-scoped `SET LOCAL lock_timeout = '5s'` (never a session setting) so it fails fast, and can be run again,
  rather than queue exports behind a long lock. Run it through the 5432 session pooler.
- **Shipping changes the worker's environment** (`LOCAL_RENDER_QUEUE_URL`, `WORKER_IDLE_EXIT_SECONDS`, the drain and
  stop timeout), so `infra/deploy.sh` and `ship.sh` need `ALLOW_WORKER_ENV_CHANGE=1` for this deploy.
- **Before the first start,** run `start.sh key` once, after the apply has created the IAM user.
- **A new studio of ours renders locally only once its id is added** to `local_render_workspace_ids` and applied.
  The email expansion is gone.
- **The local worker only matches production while it runs the deployed image.** Re-run `start.sh` after each deploy.
- **To retire it:** empty the lists and apply. New jobs go to the cloud. The fallback moves any job still routed to
  the PC after 10 minutes, whatever the lists say.

## Verified

- Unit tests:
  - `apps/web/lib/render-capacity.test.ts`:
    - Spot first;
    - on-demand for what Spot could not place, and when Spot is refused;
    - Spot off;
    - no launch for a local job, a Spot launch for a cloud job;
    - the rescue moves, flushes and launches.
  - `apps/worker/tests/heavy-lock.test.ts`:
    - the `owner.txt` format;
    - waiting out a lock with an old `owner.txt` (never stealing);
    - abort while waiting;
    - never removing someone else's lock;
    - refresh;
    - the cooldown;
    - a missing mount.
  - `apps/worker/tests/config.test.ts`: the local mode.
- Postgres tests, `packages/db/tests/local-render.test.ts`:
  - home and owned workspaces are local, EDITOR seats and customers are not;
  - only stalled local jobs move, under a new generation, on the cloud topic, and not again on the next sweep;
  - a claim racing the move wins.
- End to end on the dev stack (ElasticMQ, MinIO, Postgres, the worker image built from this branch), with the real
  heavy lock mounted. The run is recorded in the PR.
- A read-only `terraform plan` against production state: 5 to add (2 queues, a redrive allow policy, the capacity
  providers, the task definition's replacement), 5 to change (the app policy, the web role policy, App Runner, the
  backup schedule and its role for the new task definition). Not applied.

### Review round 1 (GPT Sol, 2026-10-30): seven findings, all fixed

The review found seven problems:

1. an unbounded lock wait after the claim;
2. previews published past a lost lease;
3. a fallback that followed current ownership and could move a job twice;
4. Spot reclaims that could restart a job for ever;
5. an owner lookup inside the enqueue transaction;
6. `start.sh stop` and `status` failing in a fresh shell;
7. the PC running as reelwalk-app.

The decisions above describe the fixes. Each has a test that fails on the reviewed head (612a96b6). Against the old
sources, the new tests failed:

- 12 of 14 in `packages/db/tests/local-render.test.ts`;
- 8 of 30 in the worker's store, handler and heavy-lock tests;
- 5 of 12 in `apps/web/lib/render-capacity.test.ts`.

The behavioural ones failed for the reasons the review gave:

- the heartbeat never stopped a moved render (the test timed out);
- interruptions were not counted;
- the preview asset was written outside the lease;
- a moved job was moved again.

**The new tests:**

- `packages/db/tests/local-render.test.ts`:
  - the router answers "cloud" on a failed or slow lookup, and caches;
  - the fallback selects by stored route, never moves a job twice, and rescues a job whose workspace left the lists;
  - `handOffLocalRender` spends no attempt and moves a job once.
- `apps/worker/tests/store.test.ts` (Postgres): run-specific preview keys; no asset update and a false heartbeat
  after a move; the cloud run's keys are published; interruptions are counted.
- `apps/worker/tests/handler.test.ts`: lease loss stops the render and publishes nothing; the asset update goes only
  through success; the interruption budget.
- `apps/worker/tests/local-delivery.test.ts`: the lock is taken before the claim; a timeout hands off without
  claiming; a shutdown while waiting hands the message back.
- `apps/worker/tests/heavy-lock.test.ts`: `host=` and `boot=` in `owner.txt`; a dead predecessor's lock is removed;
  another container's or another owner's lock never is.
- `apps/web/lib/render-capacity.test.ts`: on-demand after an interruption, or when the count fails; the rescue runs
  without a policy.

**End to end again on the dev stack,** with the worker image rebuilt from this branch. `worker-local` used a scratch
lock so a held lock could be staged, and `heavy.sh` held the real lock around each render:

- **An export from our workspace:** `route=local`, rendered by `worker-local`.
- **A preview:** rendered locally to `previews/<ws>/<asset>-<job>-g1a1.mp4`. The asset's `previewKey` and `thumbKey`
  pointed at those run keys only after the success.
- **An export from the customer:** `route=cloud`, rendered by the cloud worker.
- **The lock held by another owner:** the worker waited 40 s and logged `heavy lock not free after 40s; handed the
  job to the cloud queue`. The job went to `route=cloud`, generation 2, and the cloud worker rendered it at
  `attempt=1`. The other holder's `owner.txt` was untouched.
- **A lock naming this container with another `boot`:** the worker removed it (`removed the lock this container's
  previous process left`), took the lock with its own `boot=`, rendered, and released it.
- **Both workers stopped:**
  - the first rescue moved the job, from local generation 1 to cloud generation 2;
  - a second rescue after another window moved nothing;
  - once restarted, the cloud worker rendered the job, and `worker-local` discarded the stale local message.
- **`start.sh status` and `stop`** work with `REELWALK_WORKER_IMAGE` unset; the old script failed with "required
  variable REELWALK_WORKER_IMAGE is missing".
- **The host-side `clear_dead_lock`,** run on a scratch lock: our lock naming a missing container was removed. A live
  container's lock, another owner's lock and an ownerless lock were all kept.

**A read-only `terraform plan`** against production state: 8 to add (now also the `reelwalk-local-worker` user, its
policy and the attachment), 5 to change, and 1 to destroy (the replaced task definition). Not applied.

### Review round 2 (GPT Sol, 2026-10-30): five findings, all fixed

Round 2 confirmed three round-1 fixes: per-job route (#3), Spot loops (#4) and `start.sh` (#6). #2 was fixed for new
workers, and the migration's defaults are fine for old code. Five items remained; each fix has a test for the
interleaving named.

- **F1. The PC's key could overwrite customer objects** under `renders/` and the other prefixes.
  - PC writes now all go under `local/<workspace>/`, and IAM allows only those of the listed workspaces.
  - The PC hands off a job of any other workspace (`local-delivery.test.ts`).
  - Routing is the same explicit list, so it cannot route a workspace the PC may not write for.
- **F2. Lock cleanup removed a live holder,** with a non-atomic check, and failed open on Docker errors.
  - The fix is positive proof of death from `/proc` (container, PID, start time, kernel boot), atomic
    rename-and-verify, a cleanup guard, and `docker inspect` failing closed.
  - Tests:
    - a live holder in the same container is kept;
    - dead, reused-PID and rebooted holders are removed;
    - unreadable, other-container, other-owner and identity-less holders are kept;
    - a lock that changes hands mid-removal is put back;
    - another cleaner's guard is respected;
    - in bash: Docker stopped or gone means removed; running or an error means kept; a race puts it back.
- **F3. Losing preview runs left orphaned objects.** The fix is the `RenderArtifact` manifest, the 24 h sweep and
  account deletion.
  - Tests:
    - the loser's preview and thumbnail are deleted after the grace and the winner's kept;
    - a dead export goes with its checks and audio;
    - a retry re-recording the same key is never swept;
    - caches stay until the workspace goes, and are listed for deletion.
- **F4. A stale cache could keep routing after an ownership change.** The cache is gone with the email expansion, and
  routing is a list check.
- **F5. Key creation was not atomic.** It is now serialised, reconciled with IAM's key ids, written to a temp file,
  checked and moved into place. Tests, in bash with `aws` stubbed:
  - one complete key is made;
  - an already-held key is left alone;
  - a second key is refused without `--replace`, and `--replace` deletes then creates;
  - a failed create installs nothing and the retry succeeds;
  - a concurrent run is refused.

Against d7c78f0's sources, 14 of the new tests fail: 12 of 28 in the worker's heavy-lock, start.sh and local-delivery
tests, and 2 of 10 in db routing. The reviewer's two exact reproductions cannot be replayed against the new code,
because the decisions they exploited are gone: the old lock had only `host=` and `boot=`, and the old script used
`docker ps`.
