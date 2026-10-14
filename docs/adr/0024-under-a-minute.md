# ADR 0024: Make it for me in under a minute

Status: accepted (2026-10-14)

## Context

Measured on 2026-10-14 with six 4K phone-style clips (140 MB) on a fast
line, "Make it for me" took about 78 s from picking the shots to the draft:
50 s uploading, 4 s naming rooms, 20 s for the model's cut, 3 s for the
Instagram sound and beat snap. On a phone over mobile data the upload alone
is two to three minutes. Leigh wants the whole thing under a minute, and the
promo (output/promo) says "about a minute".

## Decision

Three changes, in the order of their payoff.

1. **Shrink videos on the phone before uploading.** A reel is 1080x1920, so
   a 4K clip carries four times the pixels the render can use.
   `components/editor/shrink.ts` re-encodes a video to 1080 on its short
   side (H.264, the original audio copied) with the browser's own hardware
   encoder, through mediabunny (WebCodecs). The shrunk file becomes the
   asset: the original is not uploaded. A clip that is already 1080 or
   lighter than about 1 MB/s, a browser without WebCodecs, or any failure
   falls back to uploading the original as before. The first third of the
   upload bar is the shrink.

2. **Name rooms while the uploads run.** The editor asked for room names
   only once every shot was up; it now asks as each shot lands, so the
   naming is finished by the time the last clip arrives.

3. **A first cut at once, the model's cut as a polish.** "Make my reel"
   first asks `/api/reels/[id]/autopilot` with `quick: true`, which returns
   the rule cut (`ruleCutWithPick`) with an Instagram sound in a second or
   two and opens it in the review, playing. The model's cut is then asked
   for in the background (the existing AI job); when it arrives it replaces
   the first cut as one undoable step, with a toast, unless the studio has
   already made more than a few changes, in which case the first cut stays.
   The review bar shows "Polishing with AI…" meanwhile.

## Consequences

- Six clips from this PC: shrink + upload about 15 s, draft on screen about
  3 s after "Make my reel", polish about 20 s later. The draft is there well
  under a minute; see the measurement in the PR.
- Exports of shrunk clips render from 1080 sources, so a `zoom` of 2 on
  such a clip is a true 2x crop (540 px wide source). Instagram re-encodes
  to about 1080 anyway.
- The worker's preview rendition (720p) and render-source copy still run;
  the render source is now usually the upload itself (H.264 at 1080).
- The AI's cut can replace a first cut the studio is watching. The toast
  says so, and Undo brings the first cut back.
