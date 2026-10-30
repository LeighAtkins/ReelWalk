# Local render worker

Our own workspaces' renders run on the owner's PC instead of Fargate
(ADR 0094). The web app sends their render jobs to the SQS queue
`reelwalk-render-jobs-local` and records that route on each job. This worker
consumes only that queue. Every other workspace still renders on Fargate
(Spot first).

Which workspaces count is set in Terraform (`local_render_workspace_ids`, `local_render_emails`):

- the @reelwalking studio
- Last Mile
- every workspace leigh.atkins1@gmail.com owns

## Start

From any checkout, in Git Bash, with Docker Desktop running:

```bash
bash infra/local-worker/start.sh key   # once: makes the worker's own AWS key
bash infra/local-worker/start.sh       # starts it
```

`key` creates an access key for the IAM user `reelwalk-local-worker` and
writes it to `~/.reelwalk/aws-credentials`. The key is never printed and never
written inside a checkout. That user may only:

- use the local queue and its dead-letter queue;
- read media;
- write render outputs (`renders/`, `previews/`, `thumbs/`, `render-sources/`).

It cannot touch the customers' queue, list the bucket or delete anything. To
replace the key, delete it in IAM, delete the file, and run `key` again.

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
    `reelwalk-local-worker <time> render <job> host=<container> boot=<process> #<token>`.
  - It refreshes `owner.txt` every 4 minutes and removes the lock once the
    render has ended (after Chrome and ffmpeg exit).
  - It waits 60 s before taking the lock again (`HEAVY_LOCK_COOLDOWN_SECONDS`).
- It never steals someone else's lock. If the lock is not free within 8 minutes
  (`HEAVY_LOCK_WAIT_SECONDS`), it hands the job to Fargate. The job was never
  claimed, so the hand-off spends no attempt.
- It cleans up its own dead locks, and only its own:
  - When this container's previous process left a lock (a crash, an OOM kill,
    the PC rebooting), the restarted worker sees the same `host` with a
    different `boot` and removes it.
  - When the container itself is gone, `start.sh` removes the lock, but only
    if `owner.txt` names our worker and a container that is no longer running.
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
