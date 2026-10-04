# ADR 0005: kind before EKS

Status: accepted (2026-10-04)

## Context

The goal is to learn and demonstrate Kubernetes operation of this app. EKS
costs money from the first hour (control plane, nodes, NAT gateway, load
balancer) and adds VPC, IAM and add-on work before the first pod starts.

## Decision

Run the chart on kind (Kubernetes in Docker) first. `infra/kind/up.sh` builds
the images, loads them into the cluster, deploys the local stand-ins for RDS,
S3 and SQS, and installs the release. The Playwright suite runs against it
with `E2E_BASE_URL=http://localhost:8081`.

Everything that differs between kind and AWS is in `values-kind.yaml`:
endpoints, the NodePort, and throwaway credentials. The application code has
no "local mode": it always speaks the S3 and SQS APIs through the AWS SDK.

## What kind does not cover

These need a real EKS cluster and are not claimed as done:

- IRSA (IAM roles for service accounts) and real IAM policies
- A load balancer, TLS and DNS
- Node autoscaling
- RDS networking and backups
- CloudFront in front of the media bucket

## Consequences

- The whole stack can be created and destroyed in minutes at no cost.
- Moving to EKS should be a new values file plus Terraform for the AWS
  resources, with no chart or application changes. That claim is untested
  until it is done.
