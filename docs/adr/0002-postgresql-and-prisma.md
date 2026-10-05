# ADR 0002: PostgreSQL with Prisma

Status: accepted (2026-10-04)

## Context

The data is relational: a workspace has properties, a property has media and
render jobs, a job has at most one output. Job status changes must be safe
when two workers, or a worker and a user, act on the same job at once.

## Decision

PostgreSQL, accessed through Prisma from both the web app and the worker. The
schema, migrations and client live in one package, `packages/db`.

- Status changes are single conditional updates, for example
  `updateMany({ where: { id, generation, status: "RUNNING" }, data: { status: "SUCCEEDED" } })`.
  The `where` clause is the guard: if another writer got there first, zero rows
  change. No read-then-write, no explicit locks.
- The legal transitions are a pure function in `packages/core`, covered by
  Vitest, and the conditional updates mirror it.
- Migrations are committed SQL, applied with `prisma migrate deploy` by a
  one-shot Job before the app rolls out.

## Why not the alternatives

- DynamoDB: no joins for the dashboards, and the access patterns are not
  stable enough yet to design keys around.
- Raw SQL (the first version used asyncpg): fine, but no generated types
  shared between the web app and the worker.

## Consequences

- Prisma 7 needs a driver adapter (`@prisma/adapter-pg`) and generates the
  client into the repository tree, so `prisma generate` must run before
  typecheck, test and build. Turborepo encodes that dependency.
- Production would use RDS. Nothing in the code changes, only `DATABASE_URL`.
