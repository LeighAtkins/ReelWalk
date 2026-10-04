# ReelWalk

A phone-first editor for Instagram Reels of property listings. Pick photos and walkthrough video, trim, split, reorder, add text and music, then export a 1080×1920 MP4 and share it to Instagram from the phone.

**What the editor does**

- Clips: trim, split at the playhead, reorder, duplicate, delete, speed (0.5× to 3×), clip volume, fill or fit the 9:16 frame
- Photos: on-screen length and slow zoom or pan
- 360 photos: recognised automatically and shown as a camera sweep through the room; set start, turn, tilt and zoom
- Floor plan: media from a home tour carries its position, and the reel shows the plan with a marker that moves from room to room and turns with the camera
- Looks (colour filters) per clip or for the whole reel, fade-through-black transitions
- Text: four styles, six colours, size, drag to place, start and end times; Japanese renders correctly
- Music: upload a song, set volume and where it starts; it fades out at the end
- Instagram rules built in: 3 s to 3 min, caption and hashtag limits, guides for the areas Instagram covers with its own buttons and caption
- Undo and redo, autosave, and protection against two tabs overwriting each other
- Export renders on a worker and keeps going if you leave; the export screen opens the phone's share sheet with the video and copies the caption

> The product strategy (floorplan overlay, AI room labels) is in `docs/PLAN.md` and `docs/MVP_SPEC.md`.

## Why this exists (one paragraph)

Real-estate agents and listing photographers spend $150–400 per listing on videographers or 2–4 hours hand-editing. Existing tools (RealStateVideo, Reel-E, vProp, Fliki) turn photos into Reels with AI scripts + voiceover. **ReelWalk's wedge is the floorplan-aware overlay** — a moving "you are here" marker on the floorplan synced to the walkthrough. Nobody else does it; it's a visual hook TikTok's algorithm rewards and it makes the agent look premium. Read `docs/PLAN.md` for the full strategy + competitive eval.

## Golden rules (read before building anything)

1. **No floorplan generation.** Ingest whatever format the customer has (PDF / PNG / SVG / Matterport screenshot). If they have none, fall back to video-only mode with AI room labels. Do not compete with CubiCasa / iGUIDE / Matterport / Zillow 3D Home on scanning.
2. **No custom ML in Phase 1.** Use API intelligence (GPT-4V / Gemini Vision for room classification; off-the-shelf OCR for floorplan labels). Only train custom models once you have real user-correction data.
3. **Draft + light edit, not full auto.** Output is ~80% right; the customer tweaks room names, marker positions, clip order, captions, branding, music, then re-renders.
4. **No auto-posting.** MLS / brand compliance is a minefield. Export platform-optimized MP4s only.

## Stack

| Layer | Technology |
| --- | --- |
| Web | TypeScript, React 19, Next.js 16 App Router, Server Components, Server Actions, Remotion Player |
| Data | PostgreSQL, Prisma 7 |
| Queue and storage | SQS with a dead-letter queue, S3 (ElasticMQ and MinIO locally) |
| Rendering | Separate TypeScript worker; the same Remotion composition as the preview, headless Chrome, WebCodecs |
| Monorepo | pnpm workspaces, Turborepo |
| Runtime | Docker, Kubernetes, Helm, kind for local clusters |
| CI/CD | GitHub Actions, Trivy, Argo CD (optional) |
| Tests | Vitest, Playwright |

How the pieces fit, what each one does, the schema and the job lifecycle are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The reasons behind the main
choices are in [`docs/adr`](docs/adr).

## Repo layout

```
apps/web          Next.js app (Server Components, Server Actions)
apps/worker       SQS consumer that renders jobs
apps/editor       Standalone browser timeline editor (Vite)
packages/core     Job state machine, queue delivery/retry decisions, upload rules
packages/db       Prisma schema, migrations, client, seed
packages/render   Remotion compositions and render functions
e2e               Playwright tests
infra/helm        Helm chart
infra/kind        Local Kubernetes cluster
infra/argocd      Argo CD Application
```

## Run it with Docker Compose

Needs Docker only.

```bash
docker compose up --build
```

Open http://localhost:8080 (on a desktop, the browser's phone emulation
shows it as intended). Tap New reel, pick photos and videos, edit, then
Export. The export screen shows progress and plays the finished 9:16 MP4.

Load sample content, so there is something to edit straight away: 22 real 360
room photos, 8 home videos and three ready-made reels, all openly licensed
(details and sources in [`docs/MEDIA_LIBRARY.md`](docs/MEDIA_LIBRARY.md)):

```bash
docker compose run --rm import-library
```

To try it on a real phone on the same network, open `http://<pc-ip>:8080` and
set `S3_PUBLIC_ENDPOINT_URL=http://<pc-ip>:9000` in `.env` so the phone can
reach uploaded media.

- MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`)
- The timeline editor is at http://localhost:8080/editor/
- Run more workers with `docker compose up -d --scale worker=3`

## Run it on Kubernetes (kind)

Needs Docker, `kind`, `kubectl` and `helm`.

```bash
infra/kind/up.sh
```

This creates the cluster, builds and loads both images, deploys Postgres,
MinIO and ElasticMQ, and installs the Helm release. Open http://localhost:8081.

```bash
kubectl --context kind-reelwalk -n reelwalk get pods
kubectl --context kind-reelwalk -n reelwalk logs deploy/reelwalk-worker -f
kubectl --context kind-reelwalk -n reelwalk scale deploy/reelwalk-worker --replicas=4
kind delete cluster --name reelwalk
```

To deploy through Argo CD instead of `helm upgrade`, see `infra/argocd/install.sh`.

If `kubectl` fails with `x509: certificate signed by unknown authority`, an
antivirus HTTPS scanner is intercepting the connection to the cluster on
`127.0.0.1`. Exclude that address from HTTPS scanning.

## Develop

Needs Node 22+ and pnpm (`corepack enable`).

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test          # Vitest: core logic and the worker's message handler
pnpm e2e           # Playwright, against the compose stack on :8080
E2E_BASE_URL=http://localhost:8081 pnpm e2e   # against the kind cluster
```

To run the web app or worker on the host against the compose services, copy
`.env.example` to `.env`.

Database changes: edit `packages/db/prisma/schema.prisma`, then
`pnpm --filter @reelwalk/db migrate:dev`. Migrations are applied by the
`migrate` service in Compose and by a Job in Kubernetes.

## CI

`.github/workflows/ci.yml` runs on every pull request:

1. Lint, typecheck, unit tests, Helm lint
2. Trivy scan of the lockfile, Dockerfiles and manifests
3. Build both images and scan them with Trivy
4. Start the Compose stack and run the Playwright suite

On `main`, images are pushed to ECR once the repository variables
`AWS_ROLE_ARN` and `AWS_REGION` are set (GitHub OIDC, no stored keys).

## Product docs

- `docs/PLAN.md` — strategy and competitive evaluation
- `docs/MVP_SPEC.md` — scoped Phase 1 MVP
- `docs/TASK_01.md`, `README_TASK01.md` — the first engineering task (describes the earlier FastAPI + Redis slice)
