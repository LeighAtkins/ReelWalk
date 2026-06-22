# ReelWalk — MVP Specification (Phase 1)

> Scoped, buildable, bounded. This is what the first engineering tasks deliver. Everything here defers to `PLAN.md` golden rules: no floorplan generation, no custom ML, draft+edit not full-auto, no auto-posting.

## Goal

A working end-to-end slice: a customer uploads a **walkthrough MP4** and (optionally) a **floorplan image/PDF**, and ReelWalk produces a **30–45s social Reel** with a **moving floorplan marker** and **captions** — as an editable draft the customer can tweak and re-render.

## Who it's for (Phase 1)

**Listing photographers** (not agents yet). They shoot the walkthrough footage, want to upsell a social package, and tolerate a slightly rough tool in exchange for speed. This shapes UX toward batch + speed, not hand-holding.

## In scope — Phase 1

### Ingestion
- Video upload: MP4 (raw walkthrough or Matterport/iGUIDE export), up to ~2GB, resumable/multipart to S3.
- Floorplan upload: PDF, PNG, JPG, SVG. **Optional** — if absent, run **video-only mode**.
- Floorplan label extraction: off-the-shelf OCR (e.g. Tesseract / cloud OCR) + heuristics to read room labels off the floorplan image.

### Intelligence (API-only, no training)
- **Room classification** from sampled video frames via GPT-4V / Gemini Vision.
- **Floorplan ↔ video alignment**: MVP = user-assisted — user drags the marker to a room on a mini-map at clip boundaries; store as ordered waypoints. (Automated affine alignment is Phase 2.)

### Rendering
- **Remotion** composition: floorplan thumbnail with an animated marker moving between waypoints, synced to clips; auto captions; agent/photographer branding slot (logo, colors, font, one-line handle).
- **FFmpeg** for transcoding, clipping, and platform exports (9:16 1080×1920; also 1:1 and 16:9 toggles).
- Render runs on the Fargate queue; status polled by the frontend.

### Editor (light)
- Preview the draft, then adjust: room names, marker waypoints, clip order/trim, caption text, branding (logo + 2 colors + font), music track (small licensed library or upload).
- **Re-render on export.** Edits are just param changes fed back to the Remotion composition.

### Plumbing
- **FastAPI** service: upload endpoints, job orchestration, render trigger, draft state CRUD.
- **PostgreSQL**: users, listings, draft params, job records.
- **Redis**: job queue state + render progress caching.
- **S3 + CloudFront**: media storage + video delivery.
- **SQS + Fargate**: render workers (rendering is embarrassingly parallel).
- **Sentry**: error/observability on the fragile render path.

## Explicitly OUT of scope (Phase 1)

- ❌ Floorplan **generation** from images/video/LiDAR.
- ❌ Custom-trained models (room classifier, floorplan parser). API vision + OCR only.
- ❌ Automated social **auto-posting** (MLS/brand compliance).
- ❌ Voiceover / AI scriptwriting (later; competitors do this, it's not the wedge).
- ❌ Multi-story / complex / non-rectangular floorplan handling beyond best-effort.
- ❌ Payments/billing polish (stub auth only; monetization comes after the wedge validates).

## Definition of done (the whole MVP)

1. Photographer can log in, create a listing, upload MP4 (+ optional floorplan), and submit.
2. System samples frames → vision room labels → (if floorplan) OCR labels → produces a **draft** within ~60–90s of upload.
3. Draft renders a viewable 30–45s 9:16 Reel with floorplan marker + captions + branding.
4. Photographer can edit the draft (names, waypoints, clip order, captions, branding, music) and re-render.
5. Final export produces platform-ready MP4(s) delivered via CloudFront URL.

## Risks to watch

- **Render latency:** Remotion single-core is 15–60s for 30–45s@1080p. Keep MVP clips short; plan the hybrid Remotion+FFmpeg split early.
- **No-floorplan experience:** must not feel broken — video-only mode needs to look intentional, not degraded.
- **Alignment UX:** user-dragged waypoints are the riskiest UX piece; timebox it, ship the simplest thing that's usable.
