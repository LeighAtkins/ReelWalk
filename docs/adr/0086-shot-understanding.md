# 0086 - Shot understanding: what is in the picture, moment by moment

Date: 2026-10-26

## Context

The owner's cut grammar (2026-10-26) says that every shot change must be a named continuity technique. Examples are
an eye-trace cut, a match on direction, a cut on action, an occlusion wipe, a rack focus, a shape match or a scale
jump. Motion should never stop, and something should surprise the viewer every 3–5 s. A planner can only choose
those by looking at what is *in* the picture at the frame it cuts on. Today nothing looks. The autopilot diagnosis
(2026-10-26) found three causes:

- In-points are "the middle of the clip" (`autopilot.ts` `ruleCut`, `pacing.ts` `withLength`).
- Landscape sources are centre-cropped to 9:16 with no reframe, which throws away about 68 % of the frame.
- The models get text only.

Motion is read as one number per clip (`clipEnergyFromMotion`). Edge motion is read only at cuts (ADR 0074), never
per window.

The cut planner (ADR 0087, built in parallel on `feat/cut-grammar`) and the director need per-clip, per-window facts.
This ADR is the agreed contract for those facts, and the work that measures them.

## Decision

**One analysis per video, measured once by the worker when the 720p preview is made, stored on the asset.**
`MediaAsset.shotAnalysis` is a JSON column (migration `20261026120000_shot_analysis`, additive). The PREVIEW job
(`apps/worker/src/render.ts`) runs `analyseShot` on the proxy it has just written, after the transcript. Sizes and
duration come from the asset, which is the original upload, so virtual close-ups count real pixels. A failure is
logged and skipped, the same as the transcript.

**The contract lives in `packages/core/src/shot-analysis.ts`** (`shotAnalysisSchema`, `ShotAnalysis`). The fixture for
the 8 Reel 91 clips holds real measurements: `packages/core/src/fixtures/shot-analysis-reel91.json`.

Conventions:
- Times are integer source ms.
- Points are fractions of the source frame.
- Flow is *content* motion: `dx`/`dy` in frame widths a second, so `dx > 0` means things slide right.
- Directions are named the way the eye follows them: `left right up down push pull rotate static`.

Samples are every 250 ms. Each sample carries:
- sharpness (variance of the Laplacian at 384 px, squashed to 0..1);
- crushed and blown shares, and mean luma;
- steadiness (high-frequency flow jitter);
- flow: an affine Lucas-Kanade fit from `motion-kind.ts` over the frames ±125 ms (8 fps decode), giving `dx dy zoom
  rotate magnitude`, plus a *localised* residual (the worst quarter of 6×4 cells against the median, after the global
  flow is removed);
- the spectral-residual saliency peak (Hou & Zhang 2007, 64×64 FFT) with its strength;
- an aesthetic score every second.

From the samples the worker derives:

- **Best windows** at 0.8, 1.5, 2.5 and 4 s (`bestWindows`). The score weighs sharpness .28, aesthetic .22, motion .20,
  steadiness .16 and exposure .14. The worst sample and any change of direction pull the score down. Windows start on
  the sample grid and keep 300 ms off both ends (the start/stop wobble). The best three of each length are kept and
  do not overlap. This replaces "take the middle".
- **Motion segments**: runs of one direction, with `mover` camera, subject, both or none. Also **flow peaks**, the
  cut-on-action points.
- **Depth**: Depth Anything V2 small at 3 evenly spaced samples plus each occluder's peak. Each is stored as a
  32×18 nearness grid (base64 bytes) with the foreground share, the nearest compact blob's box and the depth spread.
- **Occluders**: the frame is split into 12 vertical strips, and each strip is block-matched against the frame
  before. A strip is occluded when it moves faster than the background (parallax), or when it is soft and set apart
  in brightness (an out-of-focus door frame or wall edge). The bands are tracked across samples. A track must travel
  more than one strip, or shift, to count as a sweep. A near blob in the depth sample at its peak confirms `near`.
  Each occluder gives its span, peak, direction, coverage, and the edge that moves (the line a wipe follows).
- **Reframe** (`crop-path.ts`). For a source wider than 9:16:
  - raw targets are the saliency peaks, led 0.5 s toward where the camera is heading and pulled to centre where
    weak;
  - `smoothCropPath` smooths them in four stages: a dead band with hysteresis (6 % of the width), a critically
    damped spring (ω 2.2) run forward and backward and averaged (no overshoot, no lag), a speed limit of 0.12
    widths/s, and a clamp inside the frame;
  - keys are kept every 500 ms.

  **Virtual close-ups**: 9:16 boxes at least 720 real source pixels wide that stay put on a sharp, salient region for
  at least 1.2 s. A 1080p landscape source has none (its full-height crop is 607 px). A 4K source, or a portrait
  1080p one, does.
- **Scene facts**: a k-means palette, rectilinearity (the share of edge energy within 10° of the axes), the strongest
  round shape, brightness ramps (lights on, curtains) and blown regions (sky or window). The round shape comes from
  gradient Hough voting checked on the picture against off-centre controls, so texture does not count.

**Models (CPU, transformers.js, already a worker dependency), baked into the image by
`scripts/fetch-shot-models.ts`:**
- *Aesthetic*: the image tower of MobileCLIP-S0 (`Xenova/mobileclip_s0`, 45 MB fp32, about 40 ms a frame on 2
  threads). It is scored with CLIP-IQA antonym prompt pairs (Wang et al. 2023) at temperature 50. The prompts'
  text embeddings are precomputed into `src/shot-iqa-prompts.json`, so the 43–170 MB text tower is never loaded.
  MobileCLIP-S0 matches ViT-B/16 CLIP on zero-shot ImageNet at a fraction of the size. A LAION aesthetic head would
  need ViT-L/14, which is 10× larger.
- *Depth*: Depth Anything V2 small int8 (`onnx-community/depth-anything-v2-small`, 27 MB). It runs at 266 px
  instead of the model's 518 px: about 0.4 s a frame instead of 1.9 s, for a map that is stored at 32×18.
  q8 and fp32 maps were compared on Reel 91 and are indistinguishable at that size.
- Without the models the analysis still runs. `models.aesthetic` and `models.depth` say null, and windows score
  aesthetic as 0.5.

**On the timeline: `clip.reframe` (additive, optional).** It holds `{ aspect, keys: [{ t: source ms, x }] }`. The
shared composition (`presentation.ts` `clipPresentation`) slides the cover-fitted picture by `reframeShiftAt`. This
is the outermost transform, so zoom and camera moves happen inside the crop. Footage and the person and object mattes
read the same function, so preview and export agree. `view.ts` (`clipPicture` and its inverse and canvas transform)
maps points through the same slide, for the editor's frame service and the surface tracker. A clip without
`reframe` draws exactly as before.

It is **on by default for new cuts**. `applyReframes` (core) runs on the autopilot's rule cut and model cut
(`apps/web/lib/autopilot.ts`) for every wide, cover-fitted video with no title pinned to its picture. Saved reels
change only when asked.

**Reachable by agents and the director:**
- The command `setReframe { clipId, reframe: "auto" | {aspect, keys} | null }`. "auto" reads the clip's analysis on
  the server. It is accepted by `POST /api/reels/:id/commands` and MCP `apply_commands`.
- `GET /api/reels/:id/shots` returns the full analyses (`?assetIds=` adds library videos) and lists `pending` ones.
- MCP `get_reel` gives a compact `shot` digest per video (`digestShotAnalysis`).
- `describeReel`, the text every model edit and the Opus director sees, gives one `measured in source ms: …` line per
  analysed video (`describeShotAnalysis`).

## Consequences

- The planner chooses in-points from measured quality and motion. It measures eye-trace distance through the actual
  crop (`cutEyeTrace`, `toReelPoint`). It can hide cuts in occluders and jump scale into real pixels.
- Each analysis is about 1.3 kB per second of footage. It is loaded on demand, never with the library the editor
  downloads.
- The worker image grows by about 75 MB of models.
- Preview jobs take a few seconds longer: about 0.4 CPU-seconds per second of footage measured here, against about
  6 s for the transcript of a 12 s clip.
- Contract changes must be additive. `version` changes only on a break, and a stored analysis of another version
  reads as absent (re-run it).

## What was verified

On the owner's Reel 91 (8 clips, 4904–4911, the 720p proxies from S3). The run used `scripts/analyse-shots.ts` with
2 ONNX threads (the ECS task has 2 vCPU, `worker_cpu` 2048) on this PC, a shared 24-thread desktop:

- **Cost.** 31.4 s of CPU (node plus ffmpeg's own `-benchmark` time) for 80.6 s of footage, which is 0.39× real time
  in CPU. Wall time was 21.3 s in total; 4.2 s for the 22 s aerial. Peak RSS was 672 MB with both models loaded.
  Models load in 1.3 s.
- **Report.** One strip per clip in `ReelWalk-hybrid/output/phase-b/analysis/*.png`, with the JSON in `json/`. Each
  strip shows frames with saliency, the flow arrow or ring, the reframe crop and close-ups; depth thumbnails; and a
  timeline of quality, best windows, motion segments, occluders and the crop path.
- **Readings checked by eye on the strips:**
  - 4909: the dark foreground pillar sweeping out to the left is found (250–5250 ms, near, confirmed by depth).
  - 4910: the near teal wall edge on the right is found by depth.
  - 4904: the portrait walk reads as a push by the camera, with 4 virtual close-ups at 720 px.
  - 4905: the drone orbit reads as a turn by the camera.
  - 4908: the bowls give the only round shape.
  - Best windows avoid the soft starts.
- **Tests.**
  - New core tests cover flow direction, window choice, segments and peaks, eye trace through the crop, the crop
    smoother (dead band, no overshoot, speed limit, zero phase, inside the frame), pixel measures (sharpness,
    saliency, strip parallax, residual, circle, blow-out, palette), occluder tracking, ramps, close-ups,
    `applyReframes`, `setReframe` and `view.ts` mapping. There is also a worker test for IQA scoring and the depth
    grid, and a render test that the composition transform carries the reframe and that a clip without one is
    unchanged.
  - Full core, render and worker suites pass. Web typecheck passes.

## What failed or is not done

- **Missed sweeps.** The bedroom wall leaving frame on 4907 is missed: it covers one strip of travel, under the
  two-strip threshold that stops still walls flickering in. The strips are 12 across; finer strips would catch it.
- **Saliency on wide aerials** sometimes prefers a bright neighbour over the hero house. The reframe stays near centre
  there because weak peaks are pulled in. A small learned saliency model could do better; not tried.
- **Not run on ECS.** Fargate cores are likely slower than this PC's. The 0.39× CPU figure leaves headroom, but it is
  unmeasured there.
- **No UI toggle** for the reframe yet (command and API only). Clips added by hand in the editor are not reframed
  by default.
- **Existing assets** have no analysis until `apps/worker/scripts/backfill-shot-analysis.ts` is run against production after the migration (typechecked; not run, since production lacks the column).
- **The migration is not applied to production.**
