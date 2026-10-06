# Load test: a day of exports, compressed

Run on 2026-10-06 against the Docker Compose stack on a Windows 10 workstation
(24 logical cores, Docker Desktop with 10.7 GiB), three worker containers.
The harness is `e2e/load/day.mts`; its state, samples, log and report for this
run are in `.load/day-100b/` (not committed).

## What was done

- 100 exports planned through the real UI: a phone-sized browser opens the
  home screen, picks a vibe, taps **Auto-build a tour** on the ZInD sample
  home (26 room photos, floor plan), then **Export**. Each export is a
  20–46 s 1080×1920 reel with a moving floor-plan marker and music.
- Arrivals follow a daily curve (quiet night, lunch and evening peaks)
  compressed from 24 hours into 120 minutes: `1 0 1 0 0 0 1 6 9 6 5 5 6 9 6 3 4 5 6 9 6 3 7 2`
  per "hour". Seeded, so the schedule is reproducible (`LOAD_SEED`).
- Every 30 s the harness sampled job counts, queue depth, dead-letter and
  outbox counts, and worker CPU and memory. A failed export would have been
  retried from the UI once, as a user would.
- Chaos: at 55 % of the run, `docker kill` on a worker that was rendering.
- Unplanned: 46 minutes in, WSL (and with it Docker Desktop) restarted, taking
  every container down for about three minutes. ElasticMQ is in-memory, so
  the 10 queued and 3 in-flight messages were gone when it came back.
- At the end, every submitted reel was checked: exactly one job, status
  `SUCCEEDED`, one output row, the object in MinIO with the recorded size,
  and `ffprobe` on the downloaded file: h264 1080×1920 with a duration within
  1 s of the timeline. Outbox and dead-letter queue empty.

## Result

```
Reels submitted: 90 of 100 planned; succeeded: 90; problems: 0
Wall clock, first submit to last finish: 288.9 min; arrivals spread over 120 min
UI submit time (home -> export screen): p50 5.9s, p95 14.0s, max 17.0s
Queue wait (created -> claimed): p50 5125.5s, p95 9747.1s, max 10060.0s
Render time (claimed -> finished): p50 487.8s, p95 784.8s, max 926.2s
Video: 90 probed OK, duration 20.4-45.7 s, size 19.4-41.9 MB
Attempts: 91 over 90 finished jobs (1 redelivery); generations: 0 manual retries
Peak concurrent RUNNING: 4; peak queue visible: 59; peak outbox: 1
```

- **No data lost, no duplicate output, no wrong video.** Every job the system
  accepted was rendered exactly once to a correct file. No job failed, so
  the retry path was not exercised in this run (it is covered by the e2e
  suite).
- **10 of 100 submissions never reached the server**: all within the
  three-minute Docker outage (`ERR_EMPTY_RESPONSE`). A user would have seen an
  error and tapped again. Nothing half-written was left behind.
- **Killed worker**: its job was taken over by another worker as
  "attempt 2/3" after the heartbeat went stale and the message reappeared.
  It waited 61 minutes for that, because the redelivered message queued
  behind the backlog (ElasticMQ, like SQS, is not strictly FIFO but roughly
  so). The outbox fast path kept everything else flowing.
- **Docker outage**: the 13 jobs whose messages ElasticMQ dropped sat in
  `QUEUED`/`RUNNING` with nothing to deliver them. They were recovered by
  inserting an outbox row per job (`INSERT INTO "OutboxMessage" ... SELECT
  ... FROM "RenderJob" WHERE status IN ('QUEUED','RUNNING')`); the worker
  relay sent them within 5 s and all 13 rendered. SQS would not have lost
  them; the local emulator now persists to a volume (see fixes).
- **Capacity**: a render takes 150–260 s when a worker runs alone, 500–800 s
  with three rendering at once on this machine, so three workers gave about
  18 renders an hour, not 36. The queue peaked at 59 and the last job waited
  2 h 48 min. This is a single-workstation ceiling; in Kubernetes the worker
  count scales out across nodes. Each worker used up to 2.1 GiB.
- **Render time by vibe** (26 photos each, different pacing): Made for
  hosting 149–508 s, Blank canvas 204–515 s, The numbers 356–698 s, Work from
  home 391–606 s, Neutral 264–788 s, First keys 524–926 s.

## Things found and fixed

- **Dead-letter handler could fail a healthy render.** A duplicate message
  for a job another worker holds is deferred, but every deferral is a
  receive; after three it lands in the DLQ, whose handler marked any
  `RUNNING` job `FAILED`. With renders longer than 3 × the visibility
  timeout that would have cut off a render that was about to succeed. Now a
  deferred message is hidden for a full visibility period, and the DLQ
  handler spares a `RUNNING` job whose heartbeat is fresh
  (`shouldFailFromDeadLetter`, with tests).
- **Outbox relay timed out under load.** On a busy worker the relay's
  transaction waited for a pooled connection longer than Prisma's default
  2 s and logged `Unable to start a transaction in the given time` about 40
  times per worker. Harmless (nothing was waiting in the outbox) but noisy;
  the relay now allows 10 s.
- **ElasticMQ lost its messages on restart.** Compose now enables ElasticMQ's
  storage on a volume (`messages-storage`), and Postgres, MinIO and ElasticMQ
  carry `restart: unless-stopped` like web and worker, so a Docker Desktop
  restart brings the whole stack back.

## Things found and not fixed

- **nginx needed a restart** after the Docker daemon restart: its background
  DNS lookups for `minio` timed out and it returned empty responses until
  restarted. Compose only; nginx is not part of the Kubernetes deployment.
- **A stranded job has no automatic rescue** if the queue itself loses a
  message (which SQS does not do). A periodic sweeper that re-sends an outbox
  message for jobs `QUEUED` too long, or `RUNNING` with a very old heartbeat,
  would make the system independent of queue durability. It must not create
  duplicates for jobs that are merely waiting in a long queue.
- **Remotion re-bundles every render**: the worker logs `EACCES ... mkdir
  node_modules/.cache` from webpack's cache because the image runs as `node`.
  Making that directory writable (or pointing the cache elsewhere) should
  shave time off each render.
- **`docker kill` is a manual stop to Docker**, so `restart: unless-stopped`
  did not bring the killed worker back; it was started by hand. Kubernetes
  restarts a killed pod, which is the environment this matters in.

## Running it

```bash
docker compose up -d --scale worker=3
DATABASE_URL=postgresql://reelwalk:reelwalk@localhost:5432/reelwalk \
LOAD_TOTAL=100 LOAD_MINUTES=120 LOAD_CHAOS=1 \
  apps/worker/node_modules/.bin/tsx e2e/load/day.mts

# Re-check a run later (also waits for a still-draining queue):
LOAD_RUN=<run> LOAD_VERIFY_ONLY=1 apps/worker/node_modules/.bin/tsx e2e/load/day.mts
```

Smaller runs work too: `LOAD_TOTAL=2 LOAD_MINUTES=1 LOAD_CHAOS=0`.
