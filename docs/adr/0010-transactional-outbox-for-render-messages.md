# ADR 0010: Transactional outbox for render queue messages

Status: accepted (2026-10-05)

## Context

Queuing a render is two writes to two systems: a `RenderJob` row in Postgres
and a message in SQS. They cannot share a transaction. Until now the row was
committed first and the message sent after it; a failed send marked the job
`FAILED` so the user could retry (ADR 0001). One gap remained: if the web
process died between the commit and the send, the job stayed `QUEUED` with no
message, and nothing would ever pick it up.

## Decision

Write the message to Postgres first, in the same transaction as the job.

- `OutboxMessage` holds queue messages that still have to be sent. A new job
  (or a manual retry, which bumps `generation`) and its outbox row are written
  in one transaction, so they commit together or not at all.
- A relay (`relayOutbox` in `packages/db/src/outbox.ts`) sends pending rows.
  Each row is handled in its own transaction: lock it with
  `SELECT ... FOR UPDATE SKIP LOCKED`, send it to SQS, delete it. If the send
  fails, the row stays, with `attempts`, `lastError` and a later `availableAt`
  (backoff 1 s, 2 s, 4 s ... up to 60 s).
- The relay runs in two places. The web app calls it right after the commit,
  so a render normally starts as fast as before. Every worker also runs it in
  a loop (every `OUTBOX_POLL_SECONDS`, default 5), which picks up whatever the
  web app could not send. `SKIP LOCKED` lets all of them run at once without
  sending the same row twice.

## Why not the alternatives

- Send first, then insert the job: a worker could receive a message for a job
  that does not exist yet, or that never will.
- Change data capture (Debezium reading the WAL): the standard answer at
  scale, but a whole extra system to run for a few messages a minute.
- A separate relay deployment: one more thing to deploy and monitor. The
  worker already has both connections and is always running.
- Mark sent rows instead of deleting them: keeps a history, but needs a
  cleanup job. The job row already records what happened.

## Consequences

- A committed job always gets its message, even if the web process dies or the
  queue is down. While the queue is down the job waits in `QUEUED`; it is no
  longer failed straight away.
- The relay can send a message twice (a crash after the send, before the
  delete commits). That is the at-least-once guarantee the worker already
  handles (ADR 0003).
- A row lock is held during the SQS call, so the call is limited to 10 s.
- If no worker is running, only the web app's send after the commit relays
  messages. That is acceptable: with no worker, nothing would render anyway.
- The outbox tests need a real Postgres, so CI now starts one for the unit
  test job.
