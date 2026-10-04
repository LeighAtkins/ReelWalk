# ADR 0004: Kubernetes with a Helm chart

Status: accepted (2026-10-04)

## Context

ReelWalk has three kinds of workload: a web app that must stay up during
deploys, workers whose number should follow the queue, and a migration that
must run once per release. Docker Compose runs all three on a laptop but has
no rollout, no health-based restarts and no scaling.

## Decision

One Helm chart, `infra/helm/reelwalk`, with:

- **web**: a Deployment (2 replicas, rolling update with `maxUnavailable: 0`)
  and a Service. Readiness checks the database and that migrations ran;
  liveness only checks that the process answers. The split matters: a
  database outage should take pods out of rotation, not restart them.
- **worker**: a Deployment with no Service. Liveness is a small HTTP endpoint
  fed by the poll loop. A memory-backed `/dev/shm` for Chrome, and a long
  `terminationGracePeriodSeconds` so a render can finish on shutdown.
- **migrate**: a Job running `prisma migrate deploy` and the seed. Its name
  includes a hash of the image tag, because a Job's pod template is immutable.
- **ConfigMap** for settings, **Secret** for credentials, both injected with
  `envFrom`. A checksum annotation rolls the pods when either changes.
- Requests and limits on every container, non-root, no privilege escalation,
  all capabilities dropped.

Postgres, MinIO and ElasticMQ are deliberately outside the chart
(`infra/k8s/local`). In production they are RDS, S3 and SQS, so they are not
part of the application release.

## Why not the alternatives

- ECS/Fargate: less to operate, and a reasonable choice for this size. The
  Terraform in `infra/terraform` started that way. Kubernetes was chosen
  because the same manifests run on a laptop and on EKS.
- Plain manifests or Kustomize: fine for one environment. Helm values make
  the local and AWS differences explicit in one file each.

## Consequences

- Worker autoscaling in the chart is CPU-based and off by default. Queue
  depth is the better signal; KEDA's SQS scaler is the planned next step.
- The chart ships an optional Ingress, disabled by default. The local
  cluster uses a NodePort so it needs no ingress controller.
- In production the Secret comes from outside the chart (`secret.create:
  false`), and pods get AWS access through IRSA on the ServiceAccount.
