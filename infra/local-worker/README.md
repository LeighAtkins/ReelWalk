# Local render worker

Our own workspaces' renders run on the owner's PC instead of Fargate
(ADR 0094). The web app sends their render jobs to the SQS queue
`reelwalk-render-jobs-local` and records that route on each job. This worker
consumes only that queue. Every other workspace still renders on Fargate
(Spot first).

Which workspaces count is set in one Terraform list, `local_render_workspace_ids`:

- the @reelwalking studio
- Last Mile

These are leigh.atkins1@gmail.com's two. The same list decides what the PC may write (`local/<id>/`), so a new studio of ours is added there.

## Start

From any checkout, in Git Bash, with Docker Desktop running:

```bash
bash infra/local-worker/start.sh key   # once: makes the worker's own AWS key
bash infra/local-worker/start.sh       # starts it
```

`key` creates an access key for the IAM user `reelwalk-local-worker` and
writes it to `~/.reelwalk/aws-credentials`. The key is never printed and never
written inside a checkout.

Running `key` again is safe:

- runs are serialised;
- it keeps a key this PC already holds;
- it refuses to make a second key while IAM holds one this PC lacks, unless you run `key --replace`, which deletes
  those first;
- it writes a temp file, checks it, and moves it into place, so a failed AWS call installs nothing. That user may only:

- use the local queue and its dead-letter queue;
- read media;
- write under `local/<id>/` for our listed workspaces.

It cannot touch the customers' queue or objects, list the bucket or delete anything.

The start command:

1. reads the deployed worker image and its settings from the live ECS task
   definition, using the `reelwalk` profile;
2. writes the database URL from SSM straight into `~/.reelwalk/database-url`;
3. pulls the image from ECR if it is not already here;
4. starts the container `reelwalk-local-worker-worker-local-1`, with
   `~/.reelwalk` mounted read-only;
5. clears a heavy lock that a stopped worker container left behind (see below).

Neither secret is in the container's environment, so `docker inspect` does not
show them. They are files readable by the worker, and by anyone with
admin rights on this PC. Your user profile's permissions protect
`~/.reelwalk`, because `chmod` is mostly a no-op on Windows.

The container has `restart: unless-stopped`, so it comes back with Docker
Desktop. Run the start command again after each deploy to move to the new
image, so the worker always matches the production database.

These need no settings, so they work from a fresh shell:

- `start.sh logs` follows the log.
- `start.sh status` shows whether it is up and its last lines.
- `start.sh stop` stops it.

## What it does and doesn't do

- It renders exports, previews and story cuts from the local queue. AI video
  (Veo), AI steps and the nightly backup stay on Fargate.
- It waits for the shared-PC heavy lock `C:\dev\lm\.heavy.lock` before it
  claims a job. While it waits, the job stays queued and nothing looks busy
  that isn't.
  - It takes the lock with `mkdir` and writes `owner.txt` as
    `reelwalk-local-worker <time> render <job> container=<id> pid=<pid> start=<start time> boot=<kernel boot> #<token>`.
  - It refreshes `owner.txt` every 4 minutes and removes the lock once the
    render has ended (after Chrome and ffmpeg exit).
  - It waits 60 s before taking the lock again (`HEAVY_LOCK_COOLDOWN_SECONDS`).
- It never steals someone else's lock. If the lock is not free within 8 minutes
  (`HEAVY_LOCK_WAIT_SECONDS`), it hands the job to Fargate. The job was never
  claimed, so the hand-off spends no attempt.
- It removes a lock of its own only on proof that its holder is dead, and nothing else:
  - In the worker, the lock must name this same container, and the holder's process must be gone (its PID missing,
    or now another process) or have run under an earlier kernel boot.
  - In `start.sh`, the lock must name our worker and a container that `docker inspect` reports as stopped or gone.
    Any Docker error leaves the lock.
  - Removal renames the lock to a tombstone and checks it still holds what was judged dead, putting it back if not,
    so a lock that changed hands meanwhile is never lost.
- It writes only under `local/<workspace>/` for our workspaces; its IAM user may write nowhere else. It hands a job
  of any other workspace to Fargate at once.
- Every file a render run uploads is recorded first. The web app deletes, after 24 hours, the files of runs that
  lost their job or died (nothing points at them), and account deletion removes them all.
- While the PC is off or asleep, or the worker is stopped, nothing gets stuck.
  After 10 minutes the web app moves a job that was sent to the local queue
  and never claimed, or whose render stopped heartbeating, to the Fargate
  queue, and starts a task.
  - A moved job is a cloud job from then on. It is never moved twice.
  - A render that resumes on a waking PC finds its lease gone. It stops, and
    publishes nothing.
  - `docker stop` hands the render in progress back to the queue first.

## Settings

| Variable | Default | |
|---|---|---|
| `AWS_PROFILE_ADMIN` | `reelwalk` | profile that reads ECS, SSM and ECR, and makes the key |
| `REELWALK_SECRETS` | `~/.reelwalk` | where the worker's key and database URL are kept |
| `RENDER_CONCURRENCY` | `4` | browser tabs per render |
| `HEAVY_LOCK_PARENT` | `C:/dev/lm` | folder that holds `.heavy.lock` |
| `HEAVY_LOCK_WAIT_SECONDS` | `480` | longest wait for the lock before handing a job to Fargate |
| `HEAVY_LOCK_COOLDOWN_SECONDS` | `60` | wait after releasing before taking the lock again |

`start.sh` writes `infra/local-worker/.env.task`, which holds the task
definition's plain settings and is gitignored.
