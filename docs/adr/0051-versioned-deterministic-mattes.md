# 51. Mattes as a versioned, deterministic artifact (first milestone)

Date: 2026-10-21

## Context

The rewrite review of 2026-10-21 (`sol-rewrite-review-2026-10-21.md`, item
B#2) found that the person and object mattes (ADR 0039, 0044, 0045) were
per-frame work inside Remotion with five weak points:

- **Unpinned models.** Both `.tflite` files came from MediaPipe's `latest`
  channel, in the render and through the editor's rewrites. Google can
  repoint it and every matte changes without a commit.
- **Preview and export ran different rules.** A frame's matte is settled
  toward the previous frame's mask. An export page that started mid-shot
  read the previous frame from the footage; the editor skipped it when it
  was not cached. A scrubbed preview and the export did not agree.
- **Inconsistent failure.** A person matte that could not be made failed the
  export, but an object matte with no mask cleared its canvas and passed.
- **Allocation churn.** Refinement allocated about fifteen full-size arrays
  per frame (integral images, the guided filter's intermediates, the grow
  passes, the blend, the alpha, the ImageData).
- **Taps rode the wall.** A tapped object was carried through the shot by
  the title plane's homography, which cannot follow a plant or a chair that
  moves with parallax in front of that wall.

The end state both reviewers named is an offline pipeline: masks made once
from a sequential decode, stored immutably, and only sampled by Remotion.
That is weeks of work across the worker, storage and the renderer. This ADR
is the bounded first milestone, plus the design of that end state.

## Decisions

### 1. Everything the matte runs on is pinned (`matte-assets.ts`)

- Models are named by version (`…/float16/1/…`, `…/float32/1/…`, which were
  byte-identical to `latest` on 2026-10-21) and by SHA-256. Each model is
  fetched as bytes, hashed with `crypto.subtle`, and handed to MediaPipe as
  `modelAssetBuffer`. A different byte fails the load, which fails an export.
- The WASM runtime is `@mediapipe/tasks-vision` at the exact version in
  `package.json`, and the SIMD build is named explicitly instead of picked
  by feature detection (both Chromes support SIMD; a Chrome that does not
  fails instead of silently running another binary). A test hashes the
  installed package's files against the manifest, so a package bump cannot
  land without updating it.
- The editor reads everything from its own origin (CSP `script-src 'self'`)
  under versioned paths (`/mediapipe/1.1.1/wasm/…`,
  `/mediapipe/models/<sha256 prefix>/<file>`), which `next.config.ts`
  rewrites to exactly the URLs the render reads. A test checks the rewrites
  match the manifest and that no source or rewrite contains `latest`.
- **Not vendored.** The brief preferred copying the files into the repo.
  The render's Remotion bundle has no shared public directory (three bundle
  call sites, one of which repoints `publicDir` at the input), and the
  editor's `public/` is not in the worker image, so a vendored copy would
  need build plumbing in both apps and ~6.5 MB of models in git (40 MB with
  the WASM). The SHA-256 check gives the same guarantee for *what* runs;
  what it does not give is availability if Google deletes version 1. That
  is solved properly by the artifact pipeline (the worker image carries the
  models) and is listed below.
- `MATTE_VERSION` (`matte-core.ts`) is derived from everything that changes
  the pixels: the rule, the working size, every threshold, the tracker's
  settings, the runtime version and hashes, the model hashes. It cannot be
  forgotten when one of them changes, and a test pins its current value
  (`matte-1-f860056dedacb91e`) so the change shows in review. The canvases
  carry it as `data-matte-version`.

### 2. One rule for preview and export (`matte-core.ts`)

`PersonMatteRule.matte(key, previousKey, read)` defines frame n's alpha as
`toAlpha(blend(raw(n), raw(n − 1), 0.35))`, where `raw(f)` is the refined
segmentation of picture f alone and n − 1 is the previous frame of the same
shot (none on its first frame). The rule holds the last two raw masks as a
cache; when the one it needs is not held, it asks `read` for that picture,
previous frame first, so the decode ends on frame n. The components only
seek, hand over pixels and the segmenter, and draw; `isRendering` no longer
changes the rule.

We kept the settle term and made the preview reconstruct n − 1, rather than
dropping the settle:

- Saved reels export the same pixels as before: the export already
  reconstructed n − 1, and the refinement arithmetic is unchanged (the
  existing `matte-refine` tests pass untouched).
- The settle is what stops the edge flickering at 30 fps; the guided filter
  alone did not (ADR 0039, attempts two and three).
- The cost is one extra seek and segmentation per *scrubbed* frame in the
  editor. Playback in order reads each picture once (tested). ADR 0045 saw
  the matte "a frame behind" with a second seek; that came from effects for
  successive frames interleaving on the one decode, which the views now
  prevent by running matte jobs one at a time and dropping superseded ones.
- In the artifact pipeline the previous frame is free (sequential decode).

The proof is a pixel-hash test on a synthetic shot (a textured wall and a
moving red blob, with a fake segmenter answering on a coarse grid like the
real model): every frame's alpha hash is identical whether the frames are
asked for in order, reversed, shuffled, repeated, each on a fresh page, or
split across two pages; and the unsettled alpha differs, so the test would
catch the old preview behaviour.

### 3. Fail closed, everywhere

`objectRaw` distinguishes three outcomes. `off-frame` (every tap has left
the picture) is an empty matte, which is right. `no-mask` (a tap in the
picture got nothing from the segmenter) cancels an export with the title,
clip and frame named. In the editor both mattes now show the failure as a
red note on the preview (`MatteWarning`) as well as in the console, and the
words stay over the subject.

### 4. Buffers are reused

`matte-refine.ts` takes an optional `Workspace`: named buffers that only
grow, returned as views of the requested length, with an `allocations`
counter. The guided filter reuses its intermediates (eleven arrays down to
seven pooled ones), `grow` ping-pongs between two, and everything else
writes into caller buffers. The person rule owns its two raw masks, the
settled mask and the alpha; the views keep one `ImageData` for the alpha.
Tests run 100 frames through the person rule and the object path and
assert the counter does not move after warm-up. What still allocates per
frame: the model output copy (the one the brief allows), the
`getImageData` the browser returns, and MediaPipe's internals.

### 5. Taps follow the object (`point-track.ts`)

Each tap's 21×21 neighbourhood on the pin's first frame (the frame the
author tapped, `pin.fromMs`) is a template. On frame n it is searched by
normalised cross correlation in a ±40 px window (working pixels) around
where the wall homography carries the tap, coarse at 2 px then every pixel,
then a parabola for sub-pixel. Below a correlation of 0.7, on a flat
template, or at the frame edge, the tap falls back to the homography point.
The canvas's `data-matte-status` says which (`ok; tracked 1/1`, or
`ok; tracked 0/1; the rest follow the wall (tracker lost)`), and the
console notes it when it changes.

It is a template match from the reference frame, not sequential
Lucas–Kanade, on purpose: frame n's answer depends only on the reference
frame, frame n, the tap and the prior, so random access stays
deterministic. The cost is no template update: an object that turns or
grows a lot over a long shot drops below the threshold and rides the wall
again, which is today's behaviour. Titles without a pin keep their taps
fixed, as before.

### 6. The end state: offline artifacts (designed, not wired)

`matte-artifact.ts` fixes the contract behind `MATTE_ARTIFACTS_ENABLED`
(false):

- **Producer.** The worker decodes a source sequentially once per subject,
  runs the same `matte-core` functions (with a Node or headless-Chrome
  MediaPipe), and writes one 8-bit grayscale PNG per source frame plus a
  manifest. Masks are in *source* space, so trims, speed, refits and
  reorders reuse them. The settle becomes raw(i) toward raw(i − 1) of the
  source, a rule change and so a new `MATTE_VERSION`.
- **Keys.** `mattes/<source sha256>/<MATTE_VERSION>/<subject>/manifest.json`
  and `…/frames/<000000>.png`, where subject is `person` or
  `object-<hash of taps + pin quad + path>`. Every component is a content
  hash or a version, so artifacts are immutable and old reels keep theirs.
- **Manifest.** `{ format: 1, matteVersion, subject, source: { sha256,
  width, height, fps, frameCount }, mask: { width, height }, status?,
  frames: [sha256 per PNG] }`, validated by `matteManifestSchema`;
  `checkManifest` refuses another version, source or tap set.
- **Sampler.** `MatteSampler.frame(index)` returns the mask for source
  frame `sourceFrameIndex(clip, n)`; the browser implementation checks each
  PNG's hash and fails rather than draw nothing. The views would then draw
  the footage through the mask with no model, no second decode and no seek.

## Consequences

- Same reel, same export: the person matte's arithmetic and settle are
  unchanged and the models are the bytes `latest` served today. The object
  matte asks the segmenter at the tracked point instead of the homography
  point where the tracker locks on, so a tapped object that moves
  independently of its wall now stays matted; on a static object the two
  points coincide.
- Exports fail on a tapped object the segmenter cannot find, where they
  used to drop the matte silently.
- The editor does up to one more seek and segmentation per scrubbed frame.
  The object matte seeks once per view to the pin frame for its template.
- Determinism is proven for the rule, on a synthetic fixture. Pixel
  equality *between* the editor's Chrome and the render's headless Chrome
  is not: canvas scaling and the WebGL/CPU path inside MediaPipe can differ
  by a level here and there. The artifact pipeline removes that by making
  both sample the same PNGs.
- No real presenter clip is checked in; the fixture is synthetic (Pexels
  needs a browser to download, and agents may not drive one today).

## What was verified

- `pnpm --filter @reelwalk/render test`: the new `matte-core`,
  `matte-assets`, `point-track` and `matte-artifact` suites and the
  existing `matte-refine` suite pass.
- `pnpm check` (lint, typecheck, all tests) passes.
- `pnpm --filter @reelwalk/render smoke` (the smoke reel now has a tapped
  object on the pinned `OCEAN VIEWS` title): 15 checkpoint frames drew in
  106 s and the short export produced a 4.91 s 1080×1920 MP4 with audio, in
  the render's headless Chrome with the hash-checked models. The object
  matte visibly cuts the title in the middle still of shot 2. Run on
  Windows with a static ffmpeg on PATH (the host has none).
- The pinned model URLs and the `latest` URLs served identical bytes on
  2026-10-21 (sha256 above), and jsdelivr's 1.1.1 WASM files match the
  installed package's.

## Left open

- Vendoring the models (or baking them into the worker image) so a deleted
  upstream version cannot stop renders; today it fails closed instead.
- The producer, storage and sampler implementation of decision 6.
- Forward–backward checking and template refresh in the point tracker; a
  real benchmark of tracked taps on footage with parallax.
- A real presenter fixture in smoke.
