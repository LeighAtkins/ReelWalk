# ReelWalk Render Pipeline — Services & Cost Report

**Generated:** 2026-06-21  
**Prepared by:** Tarkovsky 🦞

---

## 1. Architecture Overview

```
Browser → nginx :8080 → web (Next.js)
                    → api (FastAPI/uvicorn)
                          ↓
                    PostgreSQL    Redis (queue)
                          ↓          ↓
                    MinIO/S3    Worker ×2 (Remotion + Chrome)
```

### Services (Docker Compose)

| Service    | Image / Stack                    | Instances | Purpose                          |
|------------|----------------------------------|-----------|----------------------------------|
| nginx      | nginx:1.27-alpine                | 1         | Reverse proxy, routing, TLS      |
| web        | Next.js 15 (standalone)          | 1         | Frontend UI + batch test page    |
| api        | FastAPI + uvicorn (Python 3.12)  | 1         | REST API, listings, uploads      |
| worker     | Node 22 + Remotion 4 + Chrome    | 2         | Render workers (parallel)        |
| postgres   | postgres:16-alpine               | 1         | Metadata, listings, render jobs  |
| redis      | redis:7-alpine                   | 1         | Job queue (`render_jobs` list)   |
| minio      | minio (S3-compatible)            | 1         | Dev object storage               |

**Production alternative:** AWS S3 (`reelwalk-media-prod-734329326838-us-east-2-an`) + CloudFront (`dh5xvp6apljoh.cloudfront.net`) in `us-east-2`.

---

## 2. Host Specifications

| Resource | Value                                  |
|----------|----------------------------------------|
| CPU      | 4 vCPU                                 |
| RAM      | 7.6 GB total, ~5.0 GB available        |
| Disk     | 75 GB (69 GB used, **96% full** ⚠️)   |
| OS       | Ubuntu 22.04 (kernel 5.15)             |
| Swap     | None                                   |

### Container Resource Usage (idle)

| Container               | CPU %  | Memory       |
|-------------------------|--------|--------------|
| nginx                   | 0.00%  | 7 MB         |
| web                     | 0.00%  | 45 MB        |
| api                     | 0.21%  | 115 MB       |
| worker ×2               | ~0.3%  | ~330 MB each |
| postgres                | 0.00%  | 46 MB        |
| redis                   | 0.97%  | 8 MB         |
| minio                   | 1.16%  | 299 MB       |
| **ReelWalk subtotal**   |        | **~1.2 GB**  |

During active rendering, each worker spikes to **~1-1.5 GB RAM** (Chrome + Remotion bundling).

---

## 3. Storage

### Docker Images

| Image              | Size     |
|--------------------|----------|
| reelwalk-worker    | 2.01 GB  |
| reelwalk-api       | 970 MB   |
| reelwalk-web       | 300 MB   |
| reelwalk-nginx     | 74 MB    |
| postgres:16-alpine | 420 MB   |
| redis:7-alpine     | 58 MB    |
| minio              | 250 MB   |

**Total ReelWalk images:** ~4.1 GB

### Object Storage (MinIO dev bucket)

| Type    | Objects | Size     |
|---------|---------|----------|
| Uploads | 32      | 216.6 MB |
| Renders | 25      | 81.3 MB  |
| **Total** | **57** | **297.9 MB** |

### Production (AWS S3)

- **Bucket:** `reelwalk-media-prod-734329326838-us-east-2-an` (`us-east-2`)
- **CDN:** CloudFront `https://dh5xvp6apljoh.cloudfront.net`
- Workers support both MinIO (dev) and S3 (prod) via env config

---

## 4. Render Job Statistics

### All-Time Totals

| Metric              | Value        |
|---------------------|--------------|
| Total jobs          | 38           |
| Completed (done)    | 27           |
| Failed              | 10           |
| Success rate        | 71%          |
| Avg render time     | 134.2s (~2m) |
| Fastest render      | 17.8s        |
| Slowest render      | 620.5s (~10m)|
| Listings created    | 61           |

### Parallel Batch Test (2026-06-21 04:53 UTC)

4 MP4 jobs submitted simultaneously, 2 workers:

| Job | Status | Duration |
|-----|--------|----------|
| 1   | done   | 68.2s    |
| 2   | done   | 83.6s    |
| 3   | done   | 116.3s   |
| 4   | done   | 141.1s   |

**Wall-clock for batch:** ~141s (vs ~410s sequential) — **~2.9× speedup** with 2 workers.

### ZInD Panorama Batch (2026-06-21 05:09 UTC)

4 JPEG panorama jobs — **all 4 failed**.

**Root cause:** Remotion's `OffthreadVideo` component calls `ffprobe` to check audio channels/duration. JPEG files are not valid video containers, so ffprobe fails and the render aborts.

**The `Img` component fix was added to `StubReel.tsx`** but the worker still saves the upload as `input.mp4` regardless of actual content type, and the render job passes it to Remotion which attempts video probing.

**Fix needed:** Worker should preserve the original file extension so the render pipeline can detect image vs video input.

---

## 5. Cost Analysis

### Current Dev Setup (Self-Hosted)

| Component          | Cost     |
|--------------------|----------|
| VPS / host (4 vCPU, 8GB) | ~$20-40/mo (varies by provider) |
| Tailscale Funnel   | Free     |
| MinIO (self-hosted)| $0 (included in host) |
| Docker             | $0      |
| **Total dev**      | **~$20-40/mo** |

### Production AWS Estimation

| Service                | Usage (est.)         | Monthly Cost |
|------------------------|----------------------|--------------|
| **EC2** (t3.medium, 2 vCPU / 4 GB) | For API + workers | ~$30/mo |
| **ECS/Fargate** (worker, 2 vCPU / 4 GB) | Per worker | ~$50/mo each |
| **RDS PostgreSQL** (db.t3.micro) | Metadata | ~$15/mo |
| **ElastiCache Redis** (cache.t3.micro) | Queue | ~$12/mo |
| **S3** (standard, <1 GB) | Object storage | <$1/mo |
| **CloudFront** (low traffic) | CDN | <$5/mo |
| **NAT Gateway** (if private subnet) | Network | ~$32/mo |
| **Total (minimal prod)** | | **~$145-250/mo** |

> ⚠️ With 2 Fargate workers for parallel rendering: add ~$50/mo per worker.  
> Remotion rendering is CPU-intensive — `t3.medium` will be slow; `c6i.large` or better recommended for workers.

### Per-Render Cost Breakdown

Assuming EC2 at $0.0416/hr (t3.medium, us-east-2):

| Metric              | Value          |
|---------------------|----------------|
| Avg render time     | 134s = 0.037h  |
| Compute cost/render | ~$0.005        |
| S3 upload + download| ~$0.00001      |
| **Cost per render** | **~$0.005**    |

At scale (1000 renders/mo): **~$5 compute + ~$1 storage = ~$6/mo variable** on top of fixed infra.

---

## 6. Known Issues

1. **Disk at 96%** — only 3.5 GB free. Worker images alone are 2 GB each. Old renders and Docker layers need cleanup.
2. **No queue visibility timeout** — `lpop` without a processing list means crashed jobs are lost silently.
3. **Worker saves all uploads as `.mp4`** — breaks Remotion when input is actually a JPEG.
4. **No retry/dead-letter** — failed jobs stay `failed` with no automatic retry.
5. **No job concurrency limit per worker** — each worker processes 1 job at a time (fine for now, but no guard against resource exhaustion if changed).
6. **nginx not managed by compose** — was manually `docker run`'d due to bind mount path issue. Needs proper fix.

---

## 7. Recommendations

| Priority | Action | Impact |
|----------|--------|--------|
| 🔴 P0 | Fix JPEG input handling (worker file extension + Remotion Img path) | Unlocks ZInD testing |
| 🔴 P0 | Clean disk space (old Docker images, stale renders) | Prevents disk full |
| 🟡 P1 | Add Redis processing list (BRPOPLPUSH pattern) | Crash-safe jobs |
| 🟡 P1 | Bring nginx back under docker-compose | Reproducible deploys |
| 🟡 P1 | Cache Remotion bundle in worker image | Faster cold renders |
| 🟢 P2 | Add job status WebSocket / SSE for live UI updates | Better UX than polling |
| 🟢 P2 | Structured logging (JSON) for workers | Observability |
| 🟢 P2 | Auto-scale workers based on queue depth | Cost optimization |

---

*End of report.*
