# ADR 0011: Terraform owns the AWS account; compute stays local for now

Status: accepted (2026-10-06)

## Context

The AWS account came back from suspension with a media bucket and a disabled
CloudFront distribution that had been made by hand. Everything else the
application needs on AWS (a queue, image repositories, a CI identity, a
runtime identity, a spending limit) did not exist. ADR 0005 keeps EKS off the
table until there is a reason to pay for it.

## Decision

`infra/terraform` describes every AWS resource ReelWalk uses, including the
two that already existed, which were imported rather than recreated so the
CloudFront domain stays the same. State is in a versioned S3 bucket with S3
lock files.

What exists on AWS now:

- The media bucket with CORS for presigned browser uploads, SSE-S3, public
  access blocked, readable only through CloudFront (origin access control)
  or with IAM credentials.
- `reelwalk-render-jobs` and `reelwalk-render-jobs-dlq`, with the same
  visibility timeout and receive count as the local ElasticMQ config.
- ECR repositories for the web and worker images, immutable tags, scan on
  push.
- A GitHub OIDC provider and a role that only `main` of this repository can
  assume, limited to pushing those two repositories. CI uses it on every merge.
- An IAM policy for the application (objects in the bucket, the two queues)
  attached to a user, whose access key is created by hand and kept out of
  the state file.
- A monthly budget with email alerts.

What does not exist on AWS: a database, a cluster, or any running compute.
The web app and workers run locally (Compose or kind) and can be pointed at
the real bucket and queue with `docker-compose.aws.yml`.

## Consequences

- Terraform `plan` is the drift check for the account; nothing is changed in
  the console.
- The remaining step to a cloud deployment is compute and a database (EKS or
  ECS, RDS), which is a new values file plus more Terraform, not application
  changes.
- Scanner findings about a WAF and customer-managed keys are accepted as cost
  decisions in `.trivyignore.yaml`.
- The IAM user is a stop-gap. When pods run on EKS the same policy moves to an
  IRSA role and the user is deleted.
