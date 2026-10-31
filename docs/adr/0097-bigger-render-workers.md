# 0097 — Bigger render workers, parallel preflight

Date: 2026-10-31

## Context

A cloud render ran on a 2 vCPU / 8 GB Fargate task with one browser tab. The showcase export drew about 0.8 s a frame
there (ADR 0074), so a 30 s reel took about twelve minutes. Fargate bills per second, so a bigger task that finishes
sooner costs about the same per render. Before every render, preflight drew the first, middle and last frame of every
shot one at a time (ADR 0042), each still in its own browser.

`worker_render_concurrency` also fed the web app's `RENDER_JOBS_PER_WORKER`, which means renders per worker. A worker
receives one message at a time, so raising the tabs would have made the web app start a third as many workers.

## Measured

The smoke reel (packages/render/scripts/smoke-fixture.ts, 10.2 s, 306 frames at 1080×1920) on a 4-core Linux container,
cores limited with `taskset`, bundling included:

| Cores | Tabs | Render |
|---|---|---|
| 2 | 1 (the old worker) | 101.3 s |
| 2 | 2 | 89.7 s |
| 4 | 2 | 67.3 s |
| 4 | 3 | 61.4 s, 59.7 s, 60.2 s |
| 4 | 4 | 63.5 s |
| 4 | 3, `REELWALK_RENDER_GL=swangle` | 121.3 s |

Three tabs peaked at 3.9 GB of memory used, on the fixture's small media. The webpack bundle takes 2.2–2.6 s, so it is
not worth baking into the image.

Preflight of the same reel (15 stills, bundle warm): 21.1 s one at a time with a browser each; 19.2 s with one shared
browser; 10.3 s with three at once in that browser (16.2 s on 2 cores).

## Decision

- Render workers are 4 vCPU / 16 GB with three tabs (`worker_cpu`, `worker_memory`, `worker_render_concurrency`).
  At Fargate Spot's US East rates that is about 10–20% more per render than before, for a render 1.65× as fast.
- `RENDER_JOBS_PER_WORKER` is a fixed 1 in Terraform, no longer read from the tab count.
- `max_workers` drops from 6 to 3: the account's Fargate quota is 12 vCPU. Raise the quota before raising it.
- Preflight and the acceptance stills share one browser, and preflight draws up to three stills at once (capped at the
  cores). When several fail, the earliest checkpoint is the one reported, as before.
- `swangle` stays off on Linux; the measurement is recorded beside the switch.

## Consequences

- A 30 s export on Fargate should drop from about 12 minutes to about 7, plus the cold start; preflight halves.
- At most three cloud renders run at once until the Fargate vCPU quota is raised. Each finishes sooner, so the queue
  drains at about the same rate.
- The worker's environment changes (`RENDER_CONCURRENCY`, `BLOCK_SOLVE_THREADS`), so `infra/deploy.sh` needs
  `ALLOW_WORKER_ENV_CHANGE=1` for this deploy. A `terraform.tfvars` that sets `worker_cpu`, `worker_memory`,
  `worker_render_concurrency` or `max_workers` overrides these defaults.
- The PC worker (infra/local-worker/compose.yml) is unchanged: four tabs on its own cores.
