# 57. Inspect: magnify the frame in the editor

Date: 2026-10-21

## Context

"We need an easier way to magnify in on parts of the video." Checking an
AI presenter take for a face or eye defect, or a title's edge and matte,
meant exporting, pulling frames with ffmpeg and cropping them outside the
app. The editor's only magnifier is the placing loupe (ADR 0044): 2.5×, a
150 px circle, shown only while a corner is held. The owner works on a
phone and wants it full screen, thumb-sized, instant, built from what the
editor already has, with nothing over the middle of the picture (placement
philosophy, 2026-10-20).

## Decision

An **Inspect** mode in the editor preview, opened from a magnifier in the
preview's control row (between Redo and Full screen) or with `I` on a
desktop. It reuses the placing screen's full-screen layout (ADR 0047: a 9:16
frame with 44 px gutters), with the controls in a bar above and a tray below
the frame, never on it.

- **Zoom 1×–8×.** Pinch zooms and pans (the point under the fingers' midpoint
  stays under it); one finger or the mouse drags; a double-tap toggles 1× ↔ 3×
  about the tap; the wheel or a trackpad pinch zooms about the cursor; `+`,
  `−` and `0` on a keyboard. A readout ("4×") and a 1× button reset. The view
  is a zoom and a centre in composition fractions (ADR 0047's space), clamped
  so the frame never leaves the screen. The maths is pure and tested
  (`apps/web/components/editor/inspect-view.ts`).
- **Final / Footage only.** The view belongs to neither layer, so switching
  shows the same region: an eye that is wrong in Footage only is the take's
  fault; one that is only wrong in Final is a matte's or a title's.
  - *Footage only* draws the clip's **source frame at the source's own
    resolution** onto a canvas the size of the screen's pixels (device pixel
    ratio up to 3), through the clip's fit, zoom and camera move
    (`pictureCanvasTransform`, the same matrix the composition uses) and then
    the inspect zoom. Each screen pixel samples the source directly, so 8×
    shows the source's own detail, not an enlarged 1080×1920 copy. No grade
    and no Fit backdrop: these are the pixels that were delivered. The frame
    comes from the frame service (ADR 0047) under a new purpose, `source`
    (the media's own frame at its own size, untouched), on a latest-wins
    channel, so stepping never queues stale seeks. The editor plays a 720p
    preview rendition; Footage only reads the **original** file
    (`LibraryAsset.originalUrl`, added; absent when the editor already plays
    the original) and falls back to the preview if the original cannot be
    read.
  - *Final* magnifies the Player itself with a CSS transform: titles, mattes
    and particles exactly as the composition draws them at that frame. The
    browser re-rasterises text and vector shapes at the zoomed size; video is
    drawn from its decoded frames, which in the editor are the **preview
    rendition** (720p); canvases (mattes, particles) at their own backing
    size. So Final at 8× is sharp for titles and as sharp as the preview for
    footage; to judge the footage itself, use Footage only. A full-resolution
    still of the composition exists only in the render (`renderReelStills`);
    wiring it to the editor is a follow-up.
- **Pixels / Smooth.** Above 4× the source pixels are drawn as blocks
  (`imageSmoothingEnabled` off; `image-rendering: pixelated` on the Player in
  Final); the Pixels button flips it at any zoom.
- **Frame steps that keep the zoom.** ◀ ▶ step one frame on the reel's frame
  grid (the Player rounds to whole frames) and a scrub strip moves anywhere;
  the view is not touched, so the same eye can be watched across frames. The
  canvas keeps the last frame drawn until the next arrives, so stepping does
  not flash black. The editor's arrow keys still step frames; every other
  editing key is ignored while Inspect is open.
- **Face.** On an AI-generated clip a Face chip zooms to the presenter. The
  identity gate (ADR 0056) stores `identityChecks` with `faceHeightPx` but
  **not the face box**; Inspect reads the latest first-frame check through
  `faceHintFromChecks`, uses a `faceBox` if one is ever stored (the gate's
  own `[ymin, xmin, ymax, xmax]` 0–1000 format), and otherwise centres on the
  point the presenter kit frames her at (top-third centre, a quarter of the
  way down) at the zoom that makes a face of the stored height fill 40% of the
  view (4× with no height). The gate's logic is unchanged; it is only read.
  MediaPipe's face detector was not added: its model is not one of the pinned
  matte models (ADR 0051) and pinning a new one belongs with the mattes.
- **Copy.** Saves the zoomed view as a PNG download named with the reel time,
  zoom and layer (`reelwalk-inspect-0m01.533s-8x-footage.png`). It is always
  the footage (in Final the button reads "Copy footage"): the browser cannot
  read the Player's pixels back. A phone screenshot captures Final.

## Consequences

- Nothing saved changes and the composition is untouched. `LibraryAsset`
  gains two optional fields (`originalUrl`, `face`); the frame service gains
  a purpose; the transport row gains a column.
- Footage only downloads the original on demand. A large original is read by
  range requests as the video element seeks, but on a slow phone the first
  frame can take seconds; the tray says "Loading the frame…" meanwhile.
- Source frames are kept in the frame service's four-frame cache. A 4K
  original is 33 MB a frame; that is the cache's existing bound.
- Final's magnification is the preview rendition's resolution for footage.
  When that matters, Footage only is one tap away and shows the original.

## What was verified

- `apps/web/components/editor/inspect-view.test.ts` (21 tests): clamping to
  the frame's edges, zoom about a point (the composition point under the
  finger stays under it), pans stopping at the edge, pinch (spread to zoom,
  midpoint kept, two fingers moving together pan, 1× and 8× limits),
  double-tap 1× ↔ 3×, wheel, the CSS/canvas matrix against
  `compositionToStage`, the layer toggle keeping the view, reset keeping the
  layer, the smoothing toggle, frame steps on the frame grid and inside the
  reel; the source drawing against a recording context for landscape under
  Fill, under Fit zoomed and a 9:16 take with a zoom-in (every source pixel
  lands where `sourceToComposition` and the zoom say, and the visible source
  rect maps to the canvas corners); 405 → 101.25 source px across at 4× for
  1280×720 under Fill; face hints from checks with and without a box; the
  Face view; the file name.
- `e2e/tests/inspect.spec.ts` on the suite's Pixel 7 (412×915, touch through
  DevTools touch events), CI only (local Docker ports are broken): see the PR
  for the run. It opens Inspect from the control row, checks every control is
  at least 44×44 and does not intersect the frame (in Final at 1× and 8×),
  switches to Footage only (source frame 1280×720, 405 px across at 1×),
  pinches to 4× (101 px across), steps a frame (the playhead moves 33.3 ms,
  the view is unchanged), and compares 25 patches of the canvas with the same
  source pixels of the video decoded independently in the page at the time
  the canvas says it shows, against the same comparison 12 source px aside;
  pinches to 8× (Pixels on by default), copies the frame (the download's
  name), switches to Final (the Player's transform is `matrix(8, …)`),
  double-taps to 1× and to 3×, and leaves with the Player's transform
  cleared. Screenshots are uploaded as the `e2e-screenshots` artefact.
- `pnpm check` passes.

Not verified: on a real phone (iOS Safari's pinch on a `touch-action: none`
element, and iOS canvas memory with a large original); the Face chip on a
real AI take (the e2e fixture is not an AI generation; the face maths is
unit-tested); `image-rendering: pixelated` on video in Final (browser support
varies; Footage only is the reliable pixel view).
