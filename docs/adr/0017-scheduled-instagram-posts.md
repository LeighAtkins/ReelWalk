# ADR 0017: Scheduled Instagram posts

Status: accepted (2026-10-13)

## Context

A finished export can already be posted to Instagram with one tap: the export
screen creates a Graph API media container from the video's public URL, polls
it from the browser until Instagram has processed it, then publishes it. The
@reelwalking account posts daily, and studios want the same thing: pick a time,
close the app, and have the Reel go out then. That needs something on the
server that wakes up at the right time, and it has to work on the cheap AWS
deployment (ADR 0015), the kind cluster and Docker Compose alike.

Three facts shape the design:

- The web app runs on App Runner with `min_size = 1`, so an instance always
  exists. But App Runner bills idle instances for memory only and throttles
  their CPU until a request arrives. A `setInterval` in the server process
  cannot be trusted to fire on time there, or at all, between requests.
- Instagram takes from a few seconds to several minutes to process a video,
  and publishing before the container is `FINISHED` fails.
- App Runner can run several instances (up to `web_max_instances`), and Compose
  and kind can too, so two processes may try the same post at the same moment.

## Decision

A `ScheduledPost` table, a publisher that advances posts one step per tick,
and two triggers for the tick.

**Data.** `ScheduledPost` holds the workspace, the render job, a copy of the
caption, the cover offset (`coverMs`, the same 700 ms `thumb_offset` as the
post-now flow), `publishAt` in UTC, status (`SCHEDULED`, `PUBLISHING`,
`PUBLISHED`, `FAILED`, `CANCELLED`), attempts, error, and the Instagram ids
(`containerId`, `mediaId`, `permalink`). The form sends the wall-clock time
and the browser's IANA zone; the server converts with `zonedLocalToUtc` in
`@reelwalk/core`, which handles DST gaps and repeated hours.

**Claim.** A tick (`runScheduledPosts` in `packages/db/src/scheduled-posts.ts`)
selects due rows: `SCHEDULED` with `publishAt <= now`, or `PUBLISHING` with
`nextCheckAt <= now`. It claims each one with a single conditional
`updateMany` that sets `status = PUBLISHING`, a fresh random `claimToken` and
`nextCheckAt = now + 15 min`, guarded on the status and token it read. In
Postgres the second of two racing updates re-reads the row after the first
commits, no longer matches, and updates nothing. Every later write is
conditional on the token, so an instance whose claim was taken over cannot
overwrite the new owner's work.

**Step.** A claimed post moves one step and is released:

1. No container yet: check the plan gate, the connection and the export,
   create the container with the cover offset, store `containerId`, look again
   in 20 s.
2. Container `IN_PROGRESS`: store a later `nextCheckAt` (half the time spent
   so far, 20 s to 5 min) and return. No tick ever waits on Instagram.
3. `FINISHED`: publish, store `mediaId`, `permalink` and `PUBLISHED`.
4. `ERROR` or `EXPIRED`, or still processing after 30 min: drop the container
   and retry with a new one.

Transient failures (network errors, 5xx, 429, Graph's transient codes and
`is_transient`) are retried three times, 1, 2 and 4 minutes apart; a
permanent one (bad token, plan lapsed, export deleted) or a fourth failure
marks the post `FAILED` with a readable error, and the studio owner gets an
email through `sendEmail`. The email is sent after the status is written, and
its errors are logged and swallowed. A process that dies mid-step leaves
`nextCheckAt` 15 minutes ahead, so the post is picked up again then.

After a failed publish call the container is kept. If the call actually went
through, the next check finds the container `PUBLISHED` and the post is marked
done. Publish is only called for a container Instagram reports as `FINISHED`,
and one container can be published only once, so a post cannot appear twice. A post first picked up more than a day late (the publisher was
down, or Instagram was switched off) fails instead of appearing unannounced.

**Triggers.** Both call the same tick. The claim makes running both safe.

- *In-process loop.* `apps/web/instrumentation.ts` starts a 60 s loop once per
  server process (Node runtime only, not during `next build`, never
  overlapping itself). This is enough for Compose and kind, where processes
  keep their CPU. `SCHEDULED_POSTS_LOOP=off` disables it.
- *EventBridge on AWS.* A scheduled EventBridge rule (`rate(1 minute)`) calls
  an API destination that POSTs to `/api/scheduled-posts/run` on the App
  Runner URL with `Authorization: Bearer <SCHEDULER_SECRET>`. The request
  gives the instance CPU for the tick. Terraform generates the secret
  (`random_password`) and passes it to both the EventBridge connection and the
  app's Parameter Store settings. Without the secret, the endpoint returns 404.
  A CloudWatch alarm fires if invocations fail for 15 minutes.

EventBridge Scheduler, which runs the nightly backup, has no HTTPS target. It
can only call AWS APIs. A scheduled rule with an API destination is the
native way to hit an HTTP endpoint on a timer, so it is used here instead.

## Why not the alternatives

- *Only the in-process loop:* simplest, but on App Runner it depends on CPU the
  platform does not promise to idle instances.
- *Only EventBridge:* the local stacks would need their own cron, and a missed
  minute on AWS would have no fallback.
- *EventBridge Scheduler, one schedule per post, at its exact time:* exact
  timing, but schedules then have to be created, updated and deleted with
  every change. Processing still takes several ticks, so a poller is needed
  anyway.
- *Run it in the render worker:* workers are Fargate tasks started on demand
  and exit when idle (`WORKER_IDLE_EXIT_SECONDS`), so nothing would be running
  at 09:00 on a quiet morning.
- *Lambda on a schedule:* a second deployable with its own build, database
  connection and Instagram code, to do what one request to the existing app
  already does.
- *`SELECT ... FOR UPDATE SKIP LOCKED`, as the outbox does:* the outbox holds
  its row lock across one quick SQS call. A post spans minutes of Instagram
  processing across several ticks, so the claim has to outlive any one
  transaction, and a stored token does that.

## Consequences

- A post goes out within about a minute of its time on AWS (the rule's
  rate), plus Instagram's processing time.
- Each tick wakes an App Runner instance for a moment, about 43,000 short
  requests a month. API destination calls cost about $0.01 a month. The
  connection's credential sits in a Secrets Manager secret, which may add
  about $0.40 a month. App Runner bills active vCPU only while a request runs.
  Watch the first month's bill, and slow `scheduled_posts_rate` if it shows.
- Two instances never publish the same post at once. One that stalls for
  15 minutes may find its claim taken over. Its writes are then refused, and
  the container check keeps the post from being published twice.
- The caption is copied when the post is scheduled, so editing the reel later
  does not change a post already in the queue.
- Disconnecting Instagram does not cancel queued posts. If it is reconnected
  before their time they go out; otherwise they fail with an email.
- The claim tests need a real Postgres, like the outbox tests; CI provides
  one. On the local stack, `DEV_FAKE_INSTAGRAM=true` connects a pretend
  account so the end-to-end suite can schedule and cancel posts without a Meta
  app. Nothing is sent to Instagram from it.
