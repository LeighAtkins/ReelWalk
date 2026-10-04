# ADR 0003: Render workers are separate from the web app, and idempotent

Status: accepted (2026-10-04)

## Context

The web app is small and I/O bound. A render runs headless Chrome and ffmpeg
and needs gigabytes of memory. The two scale differently, fail differently
and have very different images (about 230 MB against 1.7 GB).

## Decision

Two deployables from one repository:

- `apps/web`: Next.js. Writes the job row and sends the queue message.
- `apps/worker`: a TypeScript process that receives messages and renders.

They share types and rules through `packages/core` and `packages/db`, not
through HTTP. The worker writes progress and status directly to Postgres, and
the web app reads it with Server Components.

Because the queue delivers at least once, a job may be rendered twice. The
worker is built so that this is harmless:

- The output object key is `renders/<jobId>.mp4`. A second render overwrites
  the same object.
- `RenderOutput.jobId` is unique and written with an upsert.
- A delivery for a job that is already `SUCCEEDED` or `FAILED` is deleted
  without rendering.
- A delivery for a job that another worker is rendering (fresh heartbeat) is
  left alone.
- A manual retry increments `generation`. Messages from an older generation
  are discarded, so a late message cannot affect the retried run.

## Consequences

- A web deploy never interrupts a render, and a render that runs out of
  memory never takes the site down.
- Each worker pod renders one job at a time. Throughput is scaled by adding
  pods, which keeps memory per pod predictable.
- On `SIGTERM` the worker stops polling and finishes its current job. If the
  pod is killed first, the job is picked up again after the visibility
  timeout.
