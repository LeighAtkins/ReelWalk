# Local render worker

Our own workspaces' renders run on the owner's PC instead of Fargate
(ADR 0094). The web app sends their render jobs to the SQS queue
`reelwalk-render-jobs-local`. This worker consumes only that queue. Every
other workspace still renders on Fargate (Spot first).

Which workspaces count is set in Terraform (`local_render_workspace_ids`, `local_render_emails`):

- the @reelwalking studio
- Last Mile
- every workspace leigh.atkins1@gmail.com owns

## Start

From any checkout, in Git Bash, with Docker Desktop running:

```bash
bash infra/local-worker/start.sh
```

That one command:

1. reads the reelwalk-app key from `.env.aws` in the main checkout;
2. reads the deployed worker image and its settings from the live ECS task
   definition, and the database URL from SSM, using the `reelwalk` profile;
3. pulls the image from ECR if it is not already here;
4. starts the container `reelwalk-local-worker-worker-local-1`.

The container has `restart: unless-stopped`, so it comes back with Docker
Desktop. Run the command again after each deploy to move to the new image,
so the worker always matches the production database.

Other commands:

- `start.sh logs` follows the log.
- `start.sh status` shows whether it is up and its last lines.
- `start.sh stop` stops it.

## What it does and doesn't do

- It renders exports, previews and story cuts from the local queue. AI video
  (Veo), AI steps and the nightly backup stay on Fargate.
- Each render takes the shared-PC heavy lock `C:\dev\lm\.heavy.lock`, the
  same lock Last Mile and the agents use:
  - it takes the lock with `mkdir` and writes `owner.txt` as
    `reelwalk-local-worker <time> render <job id>`;
  - it refreshes `owner.txt` every 4 minutes and removes the lock when the
    render ends (after Chrome and ffmpeg have exited);
  - it waits 60 s before taking the lock again (`HEAVY_LOCK_COOLDOWN_SECONDS`);
  - it never steals the lock: while someone else holds it, the render waits,
    and the job shows as rendering at 0%.
- While the PC is off, asleep or the worker is stopped, nothing gets stuck.
  After 10 minutes the web app moves a local job that nobody has claimed, or
  whose render stopped heartbeating, to the Fargate queue and starts a task.
  `docker stop` hands the render in progress back to the queue first.

## Settings

| Variable | Default | |
|---|---|---|
| `REELWALK_ENV_AWS` | `.env.aws` in this or the main checkout | file holding `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| `AWS_PROFILE_ADMIN` | `reelwalk` | profile that reads ECS, SSM and ECR |
| `RENDER_CONCURRENCY` | `4` | browser tabs per render |
| `HEAVY_LOCK_PARENT` | `C:/dev/lm` | folder that holds `.heavy.lock` |
| `HEAVY_LOCK_COOLDOWN_SECONDS` | `60` | wait after releasing before taking the lock again |

`start.sh` writes `infra/local-worker/.env.task`, which holds the task
definition's plain settings and is gitignored. It writes no secrets to disk.
The secrets are passed to the container's environment. Anyone who can run
`docker inspect` on this PC can read them, the same as with
`docker-compose.aws.yml`.
