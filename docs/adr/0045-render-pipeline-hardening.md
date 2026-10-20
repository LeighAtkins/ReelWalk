# 45. Render pipeline hardening after the 2026-10-20 review

Date: 2026-10-20

## Context

Two independent reviews of the rendering pipeline (GPT-6.1-Sol agents,
findings verified against `main` at 454918e) ranked thirteen issues. The
ones that could produce a bad export that passes every check we have were
fixed together; the rest are tracked in the review thread.

## Decisions

- **A render attempt holds a lease.** The worker's job store now keys every
  write on job, generation *and attempt* (the SQS receive count the claim
  wrote). A worker declared stale that comes back later finds the attempt
  moved on: its heartbeat, requeue, failure and success all land on
  nothing. `succeed` flips the status first and writes the output row only
  if that flip won, in one transaction, and returns whether it did; the
  handler reports `discarded` and leaves the message to the worker that
  owns it. Retries upload to `renders/<job>-<attempt>.mp4`, so a late
  upload cannot replace the file the winning attempt published. The
  dead-letter path uses `failAbandoned`, which needs no lease.
- **The person matte fails an export instead of vanishing.** A segmenter
  that does not load, a decode error, or a frame that returns no mask
  cancels the render with the clip and frame named. In the editor the
  fallback is still the words over the person, now with a console note.
- **The matte is deterministic.** Each frame's mask is settled against the
  previous frame's *raw* mask, which is reused when it was the last one
  computed here and otherwise read from the footage by stepping the decode
  back one frame. The result depends on those two pictures only: parallel
  Remotion pages, seeks and retries give the same pixels.
- **The matte follows the footage.** `clipPresentation` (new
  `presentation.ts`) is the one source of a clip's fade, whip and motion
  transform for the footage and for the matte; the matte draws the person
  through the clip's `object-fit` geometry (`fitRects`) rather than
  stretching the decode over the frame.
- **Preflight and smoke cover more.** Preflight draws the middle frame of
  every shot as well as the first and last. The smoke reel adds a surfaced
  title with two overlapping posts on two lines, a 360 panorama with a fade,
  and then renders a short real MP4 whose video stream, audio stream and
  duration are checked with ffprobe.
- **Smaller fixes.** `pinnedProgress` reads the clip on screen from the
  same frame-rounded plan the composition renders (`locateFrame`), so a
  shot whose start rounds down no longer hides its title on its first
  frame. Posts are subtracted as a union with an SVG mask instead of an
  even-odd path, so overlapping posts no longer cancel. A surfaced title
  with typed line breaks is fitted by its block height and widest line.

## Consequences

Attempt-scoped keys mean a job's output row, not its id, names the file;
`outputUrls` already reads the row. The smoke test takes longer (one short
encode). The matte does up to one extra seek and segmentation per frame on
pages that start mid-shot. Left open from the review: subprocess timeouts
in the worker, concurrent capacity reconciliation on ECS, the typewriter on
planar titles, the symmetric-edge suppression in surface detection, and
cold-font fit measurement.
