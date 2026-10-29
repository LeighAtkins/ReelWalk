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

`queueRenderJob` asks `renderRouteFor(tx, policy, job.workspaceId)` which queue the job belongs on. It writes the
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

**Who is local.** A workspace is local if either:

- it is listed in `LOCAL_RENDER_WORKSPACES`; or
- its owner is listed in `LOCAL_RENDER_EMAILS`. This covers the person's home workspace and every workspace where
  they hold an OWNER membership, so a studio the owner creates later is covered without a change. An EDITOR seat in
  someone else's studio does not count: a customer who invites us keeps rendering on Fargate.

The production values are Terraform variables with defaults, so `ship.sh` applies them with no tfvars edit:

- `local_render_workspace_ids` = the @reelwalking studio and Last Mile (`cmvny3ai60000bkuumm4q6nha`);
- `local_render_emails` = `leigh.atkins1@gmail.com`.

These values were resolved read-only from the production database. Neither is secret: the email is already in the
repository's commit history and in ADR 0079.

**Why environment variables, not a DB flag or SSM.**

- **A DB flag** needs a migration. `ship.sh` does not apply migrations, so the new code would read a column that does
  not exist until someone applies it by hand, and that failure would sit on the export path. A flag would also make
  "who renders where" an admin write with no review trail.
- **SSM read at runtime** adds IAM, caching and a failure mode on every enqueue.
- **Environment variables** fail safe: unset means everything goes to the cloud. Changes go through review and a
  Terraform apply, and the list changes perhaps once a year.

### 2. Fallback: a stalled local job is re-issued on the cloud queue

On each `/api/ready` health check, at most once a minute per instance, the web app runs `rescueStalledLocalRenders`.
It finds render jobs in local workspaces that are in either state:

- QUEUED, last updated more than `LOCAL_RENDER_FALLBACK_SECONDS` (600) ago: nobody claimed it, because the PC is off
  or the worker is stopped;
- RUNNING, with a heartbeat that old: the PC slept or was switched off mid-render.

It moves each one with a conditional write. The write keeps the job QUEUED (or puts it back to QUEUED), bumps its
`generation`, and adds a cloud-topic outbox message for the new generation. Then it flushes the outbox and reconciles
Fargate (`atLeastOne`).

Bumping the generation is what makes the move safe without touching the local queue:

- the message still sitting there names an old generation, and whichever worker later receives it discards it
  (`decideDelivery`);
- a render still finishing on a PC that has just woken cannot publish, because its lease no longer matches
  (`store.succeed`);
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

With `HEAVY_LOCK_DIR` set, it takes the shared lock around each render (`apps/worker/src/heavy-lock.ts`):

- **taking it:** `mkdir`, then writes `owner.txt` (`reelwalk-local-worker <ISO time> render <job> #<token>`) and reads
  it back in the same step;
- **holding it:** rewrites `owner.txt` every 4 min;
- **releasing it:** the lock is owned by the attempt's scope (ADR 0050), so it is released after Chrome and ffmpeg
  have gone, however the attempt ends. It is removed only if `owner.txt` still carries our token;
- **after release:** waits 60 s before taking it again.

It never steals. From inside a container the worker cannot see whether the holder's process is alive, which the
protocol's stale rule needs, so a held lock is simply waited out. The job shows RUNNING at 0% with a fresh heartbeat,
so the fallback leaves it alone. The attempt's 45-minute deadline still bounds the wait.

`infra/local-worker/start.sh` is the one-command setup:

- it runs the image of the live `reelwalk-worker` task definition, so the worker matches the production schema;
- its plain settings come from the same task definition;
- `DATABASE_URL` comes from SSM;
- the reelwalk-app key comes from `.env.aws`;
- the heavy lock is mounted from `C:\dev\lm`;
- it refuses to start against a deployed image that predates this ADR.

The dev stack gets the same pieces: a `render-jobs-local` ElasticMQ queue and a `worker-local` service under the
`local-render` profile.

### 4. Everyone else: Fargate Spot, shorter idle

`startWorkerTasks` launches with capacity provider `FARGATE_SPOT`, then launches on-demand `FARGATE` for whatever Spot
did not place: a `failures` entry such as "Capacity is unavailable", or an outright refusal such as a cluster without
the provider. `ECS_SPOT=false` (`worker_spot`) turns Spot off. The cluster gets both providers
(`aws_ecs_cluster_capacity_providers`). The nightly backup keeps `launch_type = "FARGATE"`.

**A reclaimed Spot task loses no job.** Fargate sends SIGTERM two minutes before reclaiming. The worker stops the
render at once (`RENDER_SHUTDOWN_DRAIN_SECONDS` = 0), sets the job back to QUEUED and hands its message back as a fresh
copy. That is the ADR 0050 shutdown path, covered by `cancellation.test.ts` and `handler.test.ts`, and the hand-back
does not spend one of the job's attempts. The next reconcile, from the ready check within a minute, sees the message
and starts another task.

If the task dies without the signal, the message reappears after its 120 s visibility timeout. The job's heartbeat
is stale by then, so the next worker reclaims it (ADR 0001/0003).

`WORKER_IDLE_EXIT_SECONDS` drops from 240 to 90. A warm task still catches an export queued within 90 s of the last
one. Past that, keeping the task alive costs more than a cold start.

### Infrastructure

`infra/terraform`:

- queues `reelwalk-render-jobs-local` and `-local-dlq`, with the same lease, retention and 3-receive redrive as the
  cloud queue;
- both queue ARNs in the `reelwalk-app` policy. That one policy is attached to the reelwalk-app user (the local
  worker), the web instance role and the worker task role;
- `LOCAL_RENDER_QUEUE_URL` for web and worker;
- `LOCAL_RENDER_WORKSPACES`, `_EMAILS` and `_FALLBACK_SECONDS` for web;
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
- **Shipping changes the worker's environment** (`LOCAL_RENDER_QUEUE_URL` and `WORKER_IDLE_EXIT_SECONDS`), so
  `infra/deploy.sh` and `ship.sh` need `ALLOW_WORKER_ENV_CHANGE=1` for this deploy.
- **The local worker only matches production while it runs the deployed image.** Re-run `start.sh` after each deploy.
- **To retire it:** empty the lists, apply, and wait for the local queue to drain. While the lists are empty the
  fallback does not look at those workspaces, so jobs already queued locally wait for the PC.

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
