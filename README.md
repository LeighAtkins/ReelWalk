# ReelWalk

Turn real-estate walkthrough video + a floorplan into a polished, shareable social Reel (TikTok / Instagram Reels / YouTube Shorts) with a moving floorplan marker and captions.

> MVP, not the whole company. See `docs/MVP_SPEC.md` for the scoped Phase 1 build and `docs/TASK_01.md` for the first task.

## Why this exists (one paragraph)

Real-estate agents and listing photographers spend $150–400 per listing on videographers or 2–4 hours hand-editing. Existing tools (RealStateVideo, Reel-E, vProp, Fliki) turn photos into Reels with AI scripts + voiceover. **ReelWalk's wedge is the floorplan-aware overlay** — a moving "you are here" marker on the floorplan synced to the walkthrough. Nobody else does it; it's a visual hook TikTok's algorithm rewards and it makes the agent look premium. Read `docs/PLAN.md` for the full strategy + competitive eval.

## Golden rules (read before building anything)

1. **No floorplan generation.** Ingest whatever format the customer has (PDF / PNG / SVG / Matterport screenshot). If they have none, fall back to video-only mode with AI room labels. Do not compete with CubiCasa / iGUIDE / Matterport / Zillow 3D Home on scanning.
2. **No custom ML in Phase 1.** Use API intelligence (GPT-4V / Gemini Vision for room classification; off-the-shelf OCR for floorplan labels). Only train custom models once you have real user-correction data.
3. **Draft + light edit, not full auto.** Output is ~80% right; the customer tweaks room names, marker positions, clip order, captions, branding, music, then re-renders.
4. **No auto-posting.** MLS / brand compliance is a minefield. Export platform-optimized MP4s only.

## Repo layout (target)

```
reelwalk/
  apps/web/          # Next.js — upload, draft preview, light editor
  apps/api/          # FastAPI — ingest, job orchestration, render trigger
  packages/render/   # Remotion compositions (floorplan overlay + captions)
  infra/             # IaC (S3, CloudFront, SQS, Fargate, RDS, ElastiCache)
```

## Docs

- `docs/PLAN.md` — full strategy & competitive evaluation (context, not a task list)
- `docs/MVP_SPEC.md` — scoped Phase 1 MVP
- `docs/TASK_01.md` — the first bounded engineering task

## Task 01 local quickstart

```bash
cp .env.example .env
docker compose up --build
```

Open http://localhost:8080, upload a walkthrough video (MP4/MOV/WebM) or a panorama image (JPG/PNG/WebP), and wait for the inline 9:16 stub render.

Local services:

- Nginx public entrypoint: http://localhost:8080
- Web and API direct ports (3000/8000) are not published on the host by `docker-compose.override.yml`; use Nginx on 8080
- MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`)

The Task 01 slice uses Nginx as the single browser-facing origin, MinIO as S3, Redis as the local render queue, Postgres for listing/job state, and a local Node worker that calls the Remotion render package.

From another device on the same network, use `http://<vm-ip>:8080` and make sure the VM firewall allows inbound TCP 8080.

Useful checks:

```bash
python3 -m pytest apps/api/tests
pnpm install
pnpm test:render
pnpm test:worker
```
