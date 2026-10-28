# 0093 - Walk the block: a home drawn to scale on a drone clip of the land

Date: 2026-10-28

## Context

Land sells on imagination: "picture the house here". The au-land reels (ReelWalk-hybrid `output/au-land-maya/`, notes
and `app-feature-spec.md`) showed what works and what does not:

- **Generators do not hold scale.** The scheduled AU land reel's Veo/FLUX house measured about 40 × 27 m with a 14 m
  ridge when cast onto the solved ground (a barn). Given a true-scale white massing as the first frame and a true-scale
  house as the last, Veo still grew a two-storey house about twice the size mid-build. Any "build it here" feature needs
  a measured footprint and a deterministic reveal.
- **The camera solve.** COLMAP failed three ways on a forward drone flight (free focal collapsed to f ≈ 140 px; fixed
  focal converged to a flattened, depth-reversed model; pycolmap's parallel extraction numbered images in completion
  order). An OpenCV incremental solve (SIFT, a two-view start on a 4 s pair, then PnP and triangulation frame by frame,
  focal fixed) solved 76 of 76 frames at 0.29 px in 36 s, and three independent references agreed on its scale (road
  6 m → power pole 9.8 m).
- **The match-move reveal** (the plan's outline on the land, a white massing rising, tracked to the ground as the drone
  flies) was what the owner approved on 2026-10-28.

The owner's product rules apply: ask while uploading, render while answering, the person places and the system obeys,
thumb-sized on a phone, power where it acts.

## Decision

**What the person does** (`/new/block`, a tile on the new-reel screen):

1. Drop one drone clip. It uploads as the original (`uploadFile(..., { shrink: false })`): a 9:16 crop of a
   landscape frame needs the 4K pixels.
2. While it uploads and is read, two questions as chips: *What would you build here?* (Low country home 24 × 11 m,
   Two-storey family home 16 × 11 m, Pool and deck 14 × 7 m, Just the land 40 × 30 m) and *How high was the drone?*
   (about 30 / 60 / 100 m, or Not sure).
3. One full-screen 9:16 frame of their land with the outline at true size on open, level ground the reading found
   (`suggestSite`: no solved point more than 1.2 m above the ground under it, and inside the crop for the whole reveal).
   One finger drags it; a handle at the end of its long side turns it; a sun disc dragged around it turns the light (the
   massing's shadow follows live); − / + change length and width in metres, with the m² beside them. The scale badge
   says what the scale rests on; tapping it measures: tap both edges of a road, driveway or car, pick which, and the
   scale is corrected. Play runs the reveal live over the real clip with the same drawing the render uses.
4. "Make it · free" draws the reveal and opens a new reel whose first shot it is, with one quiet serif title
   ("Drawn to scale.") from frame 0.

**The pieces.**

- `apps/worker/block/` (Python, OpenCV): `solve.py` is the prototype's `solve_cv.py` made a module (same steps and
  thresholds; init pair at 4 s with 3/5/2 s fallbacks; refusals with a reason code: `too-short`, `no-parallax` for a
  drone turning on the spot, `lost-track`, `depth-reversed`, `portrait`). `measure.py` levels and scales it as the
  prototype's `terrain.py` did: world up perpendicular to every camera's right vector (gimbal-level horizon), with the
  ground's normal picking the pitch when the drone barely yaws (a 4 s clip; the right vectors alone only fix roll);
  RANSAC ground within 20° of up; origin on the ground under the first camera, y up, −z its heading. `run.py` is the
  worker's entry: every n-th source frame for about 3 a second, each with its own timestamp (≤ 24 s, ≤ 1920 wide) → `solve.json` + `still.jpg`. Focal is never refined: 2/3 of
  the frame width (a drone's 24 mm-equivalent; the prototype's focal search peaked at 1280–1500 on 1920).
- `packages/core/src/walk-block.ts` (pure): the solve schema, camera interpolation (slerp), projection and ground casts,
  scale from a stated height or a measured length, the 9:16 crop and the push-in (eased; 1.16 at least, up to 1.45 until the outline spans a third of the frame at
  the end, as the prototype pushed to 1.42), the site suggestion,
  and `drawBlock(solve, pin, tMs)`: the outline (dashed, drawn on 0.3–1.3 s), its fill, the area written flat on the
  ground in perspective (0.9–3.0 s; stays for "Just the land"), the gable massing rising 2–4 s with only its
  camera-facing faces, shaded by the sun, and its shadow cast along the sun onto the ground. `blockSvg` writes the shapes
  as SVG. The pin screen and the worker both draw with it, so what is placed is what renders.
- `apps/worker/src/walk-block.ts`: two durable steps on the ADR 0049 machinery, like ADR 0066's `music-analysis`
  (worker only, never a paid provider, so an attempt that fails is simply retried):
  - `block-solve` runs `run.py` on the clip and stores `blocks/<assetId>/solve.v1.json` and `still.v1.jpg`; a refusal is
    stored too, so the person sees the reason, and a clip is read once.
  - `block-reveal` decodes the clip (≤ 2160 high, at its own frame rate, frame for frame), crops each frame to that moment's window, rasterises that
    moment's shapes onto it (sharp/librsvg; the area label is rendered once from the bundled Playfair TTF, OFL, because
    librsvg cannot read the editor's woff2 web fonts, and placed per frame by the ground transform), encodes H.264, and
    creates a media asset `block-<step>` and a reel `walk-<step>` that opens on it.
- **Scale is one number.** The solve assumes the first camera 60 m up (`basis: "assumed"`). A stated height or a
  measured length gives a factor (true metres per solve metre); the pin keeps its place in solve metres and its sizes in
  true metres, so correcting the scale resizes the house but does not move it. The badge always says which basis holds.
- **HTTP, for agents as well as thumbs.** `POST /api/blocks/:assetId` starts the read (202 + `jobId`; poll
  `/api/ai-jobs/:jobId`); `GET /api/blocks/:assetId` returns `ready` (the solve and the still's URL), `refused` (reason)
  or `missing`. `POST /api/blocks/:assetId/reveal` with `{ requestId, pin }` (`blockPinSchema`) draws the reveal; the
  job's result is `{ assetId, reelId }`. `/new/block?asset=<id>` opens the flow on a library clip.
- **Credits: none.** No AI video, no paid provider. The image gains python3 and a venv with numpy and
  opencv-python-headless, pinned by hash; pip and setuptools are removed from it.

**The sun is not estimated.** Two estimators were built and measured against the prototype's hand-measured sun
(azimuth 137°, elevation 27° from four tree shadows): the darkest bearing around each isolated tree, and a global
search over sun hypotheses scoring the ground where every tall point's shadow would fall. Both were confidently wrong
(250°): dark tree crowns read as shadow, and crown exclusion did not fix it. Shipping a confident wrong sun would put
the massing's shadow against the real trees' shadows, so the sun is a default (135°, 35°: ahead-left of the drone,
long afternoon shadows) flagged `assumed`, and the person turns it on the pin screen.

## Review fixes (GPT-6.1 Sol, PR #259 at 5c524c7)

1. **Not behind AI_JOBS_DURABLE.** That flag moves *paid* AI steps onto the worker and is off in production; the block
   steps are worker-only and free, and the worker consumes step messages whatever it says. The routes now need only the
   render queue that exports use (`SQS_QUEUE_URL` and the ECS launcher are set for App Runner in `serverless.tf`; the
   media CloudFront serves the whole bucket, so `blocks/` stills resolve). `WALK_BLOCK=off` switches it off.
2. **Refuse before decoding.** `run.py` decides from the probe alone: portrait, over 8K, wider than 2.4:1, an unreadable
   frame rate, under 5 s, or sampled frames over a 900 MB budget are refused before a frame is decoded.
3. **Supervised ffmpeg.** Both processes' exits are observed from the start; an encoder that dies stops the loop at the
   next frame; every path waits for both to exit, so a failure is an error, never an unhandled rejection.
4. **Prompt cleanup.** When the attempt's signal fires, the step's scope is aborted *and closed* then: its ffmpeg and
   Python are killed and its temp dirs removed at once, not after the work notices.
5. **True frame times.** The solve took ffmpeg's `fps=3`, which picks the last frame of each rounded bucket (about
   0.13 s late at 30 fps) while the camera was labelled with the bucket's start. It now takes every n-th source frame
   and labels each with its own presentation time (`showinfo`); the reveal is decoded at the source's frame rate with no
   resampling, so frame k is at k / fps exactly.
6. **Enough footage.** A solved flight under 4.5 s (`MIN_REVEAL_SECONDS`) is refused by the solve and does not parse;
   the reveal never runs past the last solved camera or the clip's end; a decoder that ends early is an error.
7. **Restart after Stop.** Asking again for a stopped solve clears the stop flag in the transaction that queues it
   again (the claim refuses a stopped run at every delivery).
8. **Pool water on top.** The water is drawn after the deck's faces.

## Consequences

- A drone clip becomes a scale-true reveal for no credits in about two minutes of worker time (solve ~1 min on 2 vCPU
  for 24 s of 4K, render ~1 min), with nothing a generator can inflate.
- The reveal is a plain video clip in the reel: preview and export are the same by construction; editing the outline
  later means drawing a new clip (the pin is in the step's payload, so an agent can re-post it changed).
- The worker image grows by python3 and the venv (~120 MB). The solve tests run in CI inside the built image
  ("Drone solve tests"), against a 7-frame, 700 KB fixture of the real clip.
- `RenderJob` kinds and the export counts are untouched: the steps are `WorkflowStep` kinds, a string. No migration.

## Follow-ups (not in this change)

1. **Maya's voiced shots on the land** (spec steps 8–10): the presenter plate from the reconstruction, Veo voiced takes
   with the identity gate, pitch and lip checks, and the take QC. They cost credits and need the quote-first flow.
2. **The sun from the footage**: segment tree crowns (or use the depth model) before scoring shadows; or ask the date,
   time and place and use the solar ephemeris with the drone's compass heading from its metadata.
3. **Focal from metadata** (DJI/XMP) instead of the 24 mm prior; refuse fisheye clips.
4. **Build stages** in the massing (slab, frame, roof) for a time-lapse feel; a FLUX house tracked over the massing
   (the prototype's crop-paste + ground homography) as an optional, credit-quoted finish.
5. **Terrain**: the ground is one plane plus a local height; a sloping block needs the depth mesh (Depth Anything V2
   fitted to the solve, as the prototype did).
6. **An MCP tool** for agents (today they use the HTTP routes).
7. Run the solve on more drone clips (orbits, sideways passes, lower flights) and tune the refusals.

## Verified

- The port on the real clip (Pexels 14194694, 4K, 24 s): 72 of 72 frames, 0.29 px median reprojection, depth order
  0.319 (the prototype: 0.32), 46–55 s on the desktop CPU. Against the prototype's solve at its 92 m scale: camera
  positions within 0.4 % (181.4 m vs 180.7 m forward at 23.7 s), rotations within 0.1°; ground 1.06° from gravity.
- Python tests (`python -m unittest discover -s tests` in `apps/worker/block`, 8 tests, ~3 s): the 4 s fixture solves
  7/7 frames under 0.6 px, depth the right way round, level ground, 20.7 m forward at the assumed 60 m (31.8 m at 92 m
  as the full clip says), a stated height rescales; a synthetic pure rotation is refused `no-parallax`.
- Core tests (`packages/core/tests/walk-block.test.ts`, 16): among them, the prototype's hand-placed house corner
  (cast from reel pixel (722, 1510) at 5.00 s onto its own solve) projects back within 6 px through this independent
  solve; the outline stays on the same ground point at every moment; sizes are true metres at any scale.
- **End to end in the app, locally** (compose Postgres/MinIO/ElasticMQ; web and worker on the host, 412 × 915 phone
  viewport): the 79 MB original uploaded through `/new/block`; the `block-solve` step read it (72/72, 0.29 px, 69 s);
  the pin screen offered open ground; measuring the road's two kerbs on it gave **92 m**, the prototype's own figure
  from the same road; dragging, the live preview over the clip and "Make it" ran; `block-reveal` drew 240 frames and the
  editor opened reel `walk-<step>` with the clip and its title. The first local run hit a full disk (ENOSPC), which
  showed that a FAILED solve could never be asked for again; `startWorkerStepRun` now re-queues a FAILED worker-only step.
