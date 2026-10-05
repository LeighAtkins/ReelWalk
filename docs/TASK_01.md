# ReelWalk — TASK 01: Scaffold repo + vertical upload→S3→stub-render slice

> **Historical.** This describes the first slice (FastAPI, Redis). The current stack is Next.js, Prisma, SQS and Kubernetes: see `README.md` and `docs/ARCHITECTURE.md`.

> **Bounded first task.** Do not build the whole MVP. Land this slice end-to-end, prove the pipeline, then stop and report back.

## Objective

Stand up the monorepo and a thin **vertical slice**: a photographer can upload a walkthrough MP4 through the web UI; the API streams it to S3; a render job is enqueued; a worker picks it up and produces a **stub render** (a short 9:16 MP4 with a placeholder floorplan + caption) served back via a CloudFront/S3 URL.

This proves ingest → storage → queue → render → delivery **before** any real intelligence (vision/OCR/alignment) is wired in.

## Deliverables

### 1. Monorepo scaffold
- `apps/web` — Next.js (App Router, TypeScript).
- `apps/api` — FastAPI (Python, async).
- `packages/render` — Remotion project with **one** composition: `StubReel` (9:16 1080×1920, ~5s, a static placeholder floorplan image + one caption line + a branding slot). FFmpeg helper for transcode/export.
- `infra/` — minimal IaC (Terraform or CDK) for: S3 bucket + CloudFront, SQS queue, Fargate task definition, RDS Postgres, ElastiCache Redis. (Can be `localstack`-friendly for dev.)
- Root: `pnpm` workspace (or npm), `docker-compose.dev.yml` to run web+api+postgres+redis+minio (S3-local) locally, `.env.example`, `README` quickstart.

### 2. Upload → S3 (API)
- `POST /listings` (stub auth — single dev user) creates a listing record in Postgres.
- `POST /listings/:id/upload` — **multipart/resumable** upload streaming the MP4 straight to S3 (MinIO in dev). Store the object key on the listing.
- `GET /listings/:id` — returns listing + media URL.

### 3. Queue + worker
- On upload complete, API enqueues a render job onto SQS (or a Redis-backed queue in dev if simpler).
- A Fargate/local worker dequeues the job, runs the Remotion `StubReel` render server-side against the uploaded video's first frame as the placeholder, transcodes with FFmpeg to 9:16, writes the output MP4 to S3, and updates job status in Postgres.
- Frontend polls `GET /listings/:id/jobs/last` for status → shows the rendered MP4 when `done`.

### 4. Web UI (minimal)
- One page: "New listing" → file picker → upload progress → "Rendering…" → inline `<video>` of the stub result.

## Acceptance criteria (all must pass)

- [ ] `docker compose up` brings the whole stack up locally; quickstart in README works on a clean machine.
- [ ] Upload a sample MP4 via the UI; it appears in the S3/MinIO bucket.
- [ ] A render job transitions `queued → running → done` in Postgres.
- [ ] A playable 9:16 MP4 is produced and shown in the UI, containing the placeholder floorplan + caption + branding slot.
- [ ] All three non-web layers have at least one automated test (API route, queue handler, render fn).
- [ ] `.env.example` documents every var; no secrets committed.

## Explicit non-goals for this task

- No GPT-4V / Gemini calls. No OCR. No real room classification.
- No floorplan upload handling yet (video only — floorplan ingestion is the next task).
- No user-dragged waypoints / alignment UX.
- No real auth, no billing, no music library.

## When done

Stop. Post a short summary: what's wired, how to run it, a link/screenshot of the stub render, and the 2–3 riskiest things for the **next** task (vision room-labelling + floorplan OCR + ingestion). Do not start Task 02 without a checkpoint.

## Context the agent must read first

- `README.md` (golden rules)
- `docs/MVP_SPEC.md` (full Phase 1 scope — this task is a subset)
- `docs/PLAN.md` (only if a "why" decision is unclear)
