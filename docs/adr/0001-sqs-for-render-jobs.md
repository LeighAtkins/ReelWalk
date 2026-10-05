# ADR 0001: SQS for the render queue

Status: accepted (2026-10-04)

## Context

A render takes seconds to minutes, uses a lot of CPU and memory, and can fail
or kill its process. It cannot run inside a web request. The first version
pushed jobs onto a Redis list and popped them with `LPOP`, which lost the job
whenever a worker died mid-render, and had no retry or dead-letter handling.

## Decision

Use SQS (ElasticMQ locally, same API) with a dead-letter queue.

- The message carries only `{ jobId, generation }`. Postgres is the source of
  truth for everything else.
- A worker receives one message, and the message stays invisible for a
  visibility timeout. While rendering, the worker extends that timeout and
  writes a heartbeat to the job row. If the worker dies, both lapse and the
  message is delivered again.
- A failed attempt re-queues the job with exponential backoff by setting the
  message's visibility timeout. After `maxReceiveCount` (3) receives, SQS moves
  the message to the dead-letter queue.
- A small consumer on the dead-letter queue marks the job `FAILED` if it is
  still `QUEUED` or `RUNNING`. That covers the case where every attempt killed
  the worker before it could record the failure.

## Why not the alternatives

- Redis list: no visibility timeout, no receive count, no dead-letter queue.
  All three would have to be built and tested by hand.
- Postgres as a queue (`SELECT ... FOR UPDATE SKIP LOCKED`): works at this
  scale and removes a dependency, but long renders hold either a transaction
  or a hand-written lease. SQS already is that lease.
- Kubernetes Jobs, one per render: good isolation, but slow start per job and
  the API server becomes the queue.

## Consequences

- SQS delivers at least once, so the worker must be idempotent (ADR 0003).
- `RENDER_MAX_ATTEMPTS` in the worker and `maxReceiveCount` on the queue must
  be the same number. They are set in two places.
- The job row and the message live in two systems. They are kept consistent
  with a transactional outbox (ADR 0010); before that, the row was committed
  first and a failed send marked the job `FAILED`.
