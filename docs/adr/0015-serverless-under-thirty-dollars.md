# ADR 0015: Production for under $30 a month

Status: accepted (2026-10-07), supersedes the compute part of ADR 0014

## Context

ADR 0014 put production on EKS and RDS. It worked on the first day and cost
about $250 a month: $73 for the control plane, $120 for one node, $17 for
the load balancer, $15 for the database, all of it idle most of the time.
For an app with one studio and a render every now and then, that is the
wrong shape. The target is under $30 a month, with no servers running while
nobody is exporting.

## Decision

- **Web app on AWS App Runner**, 0.5 vCPU and 1 GB, from the same ECR image.
  HTTPS, the custom domain and the certificate are part of the service, so
  there is no load balancer, no ingress controller and no cert-manager.
  Idle cost is the provisioned memory, about $5 a month.
- **Render workers as Fargate tasks started on demand.** No worker runs
  between exports. `exportReel` and `retryRenderJob` call
  `ensureWorkerRunning()`, which starts one task from the worker image when
  fewer than `ECS_MAX_WORKERS` are running. The task drains the queue and
  exits after `WORKER_IDLE_EXIT_SECONDS` (four minutes) without a message.
  A render costs a few cents; nothing bills in between. The queue, the
  outbox, the heartbeat lease and the dead-letter handling are unchanged.
- **Postgres on Neon's free tier**, which scales to zero and does not pause
  the project. RDS goes. The connection string is the one secret that is
  not in Terraform's own state.
- **Settings in SSM Parameter Store** (free), read by App Runner and ECS at
  start; both runtimes get AWS access through their task or instance role,
  no keys anywhere.
- The VPC stays for the Fargate tasks (public subnets, public IPs, no NAT).
  EKS, the node group, RDS and the Pod Identity role are removed.

## Consequences

- Expected run rate: App Runner ~$5–8, renders ~$1–5, S3/CloudFront/SQS/ECR
  ~$2–3. Budget alert lowered to $30.
- The first export after a quiet spell waits for a cold task: pulling the
  540 MB worker image and starting Chrome takes one to two minutes. A second
  export while a task is running is picked up immediately.
- If the worker stops at the same moment a message arrives, that message
  waits until the next export starts a task. A scheduled check could close
  that gap; it has not been needed.
- Deploys: push an image tag, set `image_tag`, `terraform apply`. App
  Runner rolls the web app; the next worker task uses the new image.
- The Helm chart and kind remain the Kubernetes demonstration (ADR 0005);
  `infra/eks/` is kept for reference and can be deleted once ADR 0014's
  cluster is gone.
