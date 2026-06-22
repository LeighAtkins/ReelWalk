# ReelWalk — Strategy & Competitive Evaluation

> This is **strategic context**, not a task list. It exists so the build agent understands the *why* behind every scoping decision in `MVP_SPEC.md`. Source: founder evaluation pass.

## The market is real

NAR data: 73% of sellers prefer agents who use video; listings with video get 403% more inquiries. Existing players — **Reel-E, RealStateVideo, vProp, Fliki** — validate demand but also mean ReelWalk is not alone. The deciding question is whether the **floorplan-aware video angle** is a differentiated wedge.

## 1. Will people pay for this?

Yes — but the bar is "saves me time I was already spending." RealStateVideo claims 2,500+ realtors / 10,000+ videos. Agents currently pay **$150–400/listing** for videographers or spend **2–4 hours** editing. A **$29–79/month** SaaS that cuts that to ~5 minutes of upload-and-tweak is an easy sell.

Risk: most existing tools already turn photos into Reels with AI scripts + voiceover. ReelWalk needs a reason someone picks it over the 4+ competitors that showed up in 30 seconds of search.

## 2. Is "floorplan-aware TikToks" the wedge?

Yes — but as a **feature, not the whole product**.

Why it works:
- Nobody else does a floorplan overlay with a moving marker. It's an immediately recognizable, shareable visual hook — exactly what TikTok's algorithm rewards.
- Adds informational value ("where am I in this house?") beyond the standard kitchen/bedroom slideshow. Matters for serious buyers scrolling Reels.
- Looks premium. Agents want to look like they invest in marketing.

Risk: only works if the customer **has** a floorplan. If they don't, ReelWalk is back to competing on features others already built. → **MVP must handle the no-floorplan case gracefully** (fall back to room labels from video classification alone).

## 3. How this fits existing toolchains (augment, don't replace)

```
Matterport / iGUIDE / CubiCasa / Zillow 3D Home
        ↓  (produces floorplan + sometimes video)
ReelWalk
        ↓  (ingests floorplan + walkthrough video)
TikTok / Instagram Reels / YouTube Shorts
```

Integration points:
- **Floorplan ingestion:** accept PDF, PNG, SVG from any of these tools; also Matterport dollhouse-view screenshots (common).
- **Video ingestion:** accept raw walkthrough MP4s photographers already shoot; also Matterport/iGUIDE auto-generated walkthrough exports.
- **Output:** platform-optimized MP4s. **Do not auto-post** — compliance minefield (MLS rules, brand compliance).

**Photographers > agents as the initial customer.** Photographers produce media for 50–200 listings/month and want to upsell a "social media package" to agents. A tool that turns their walkthrough footage into 5 polished Reels/listing is a force multiplier they'll pay for. Agents create fewer listings and are more price-sensitive.

## 4. Floorplan generation — avoid it

Do **not** generate floorplans from scratch:
- CubiCasa / iGUIDE / Matterport / Zillow 3D Home already solve this with LiDAR, depth sensors, dedicated scan apps. Competing software-only ML against hardware-accelerated accuracy is a losing battle.
- Accuracy matters legally (disclosure, room dimensions). A room 10% too small is a liability.
- Floorplan-from-images/video is genuinely hard SOTA — struggles with complex layouts, multi-story, non-rectangular rooms.

ReelWalk is **downstream consumption** of floorplans, not upstream generation. Accept any format; if none, run video-only.

## 5. Open-source datasets — careful

- **CubiCasa5k:** research-only license. **Cannot** train a commercial product on it. OK for prototyping/benchmarking only.
- **ZInD (Zillow Indoor Dataset):** research-only. Same restriction.
- **DeepFloorplan / FloorplanTransformers:** architectures usually MIT/Apache (reusable); their training data is not.

What you **can** use:
- Model architectures / code from papers (usually permissively licensed).
- Synthetic floorplans you generate yourself (procedural room layouts).
- User-uploaded floorplans with consent (your own data flywheel).

## 6. Training-data strategy (the hardest part)

- **Phase 1 (MVP — no custom ML):** GPT-4V / Gemini Vision for room classification from video frames; off-the-shelf OCR + heuristics for floorplan room-label extraction; manual floorplan overlay alignment (user drags marker on a mini-map, or simple affine transform from known room positions).
- **Phase 2 (semi-automated):** collect user-correction data (wrong room name → user fixes = training signal); photographer partnerships ("free tool in exchange for consent to use footage for training"); human correction loop (Scale AI / MTurk) for room-classification labels.
- **Phase 3 (custom models):** train room classifier on collected data; fine-tune floorplan OCR/parser on accumulated real-estate floorplans; start narrow (single-family homes) and expand.

**Key principle:** don't train custom models until you have real user data. Validate the product with API-based intelligence first.

## 7. Technical stack

| Component | Pick | Note |
|---|---|---|
| Frontend | Next.js / React | Good — Remotion is React-based, so synergistic. |
| Backend | FastAPI | Good for ML integration; Python ecosystem matters. |
| Storage | S3 (+ CloudFront) | Obvious; add CloudFront for video delivery. |
| Queue | SQS + ECS/Fargate | Good — video rendering is embarrassingly parallel. |
| Video | FFmpeg + Remotion | Remotion for programmatic compositing (React → MP4). Watch perf: 30–45s @ 1080p = 15–60s/single core. At scale, hybrid: Remotion for overlay+captions, FFmpeg for transcode/clip. |
| ML | PyTorch / OpenCV / OCR | But see Phase 1 note — start with API calls, not custom models. |
| DB | PostgreSQL (+ Redis) | Fine; add Redis for job state + caching. |

Recommended additions: **CloudFront** in front of S3; **Redis** for queue state + caching; **Sentry** for observability (video rendering is fragile).

## 8. Product model: AI drafts + light editing

Fully-automated generation will disappoint — real-estate branding is deeply personal (fonts, colors, intro/outro, agent name treatment, music). Auto-generate with no tweakability and customers leave.

Right model:
- Upload → AI generates a draft in 30–60s.
- Draft is ~80% right: good clips selected, rooms labeled, floorplan aligned, captions written.
- Customer adjusts: room names, marker positions, clip order, captions, branding (colors/fonts/logo), music, text overlays.
- Re-render on export (Remotion is ideal — change params, re-render).

This is the Canva-for-design / Runway-for-AI-video pattern.

> Original evaluation was truncated at this point; the above captures the complete strategic intent.
