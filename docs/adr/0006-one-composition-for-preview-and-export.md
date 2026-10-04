# ADR 0006: One composition for preview and export, edits as a document

Status: accepted (2026-10-04)

## Context

ReelWalk became a mobile editor for Instagram Reels: trim, split, reorder,
speed, text, music, filters, then export a 1080×1920 MP4. Two things had to
be decided:

1. How the phone shows the edit while you make it, and how the server turns
   the same edit into a video.
2. How an edit is stored, saved and undone.

A common approach is a fast approximation in the browser (canvas or CSS)
and a separate render pipeline on the server. The two drift apart: text
wraps differently, a filter looks different, timing is off by a frame.

## Decision

**One React component, two players.** `ReelComposition` in
`packages/render/src/reel` draws a reel from a timeline. The editor shows it
with Remotion's `<Player>` in the browser; the worker renders the same
component in headless Chrome with `renderMedia`. Fonts ship with the bundle
(Archivo, and Noto Sans JP for Japanese), filters are CSS, motion and fades
are frame-based, so the export matches what was on the phone.

The only branch is how video is decoded. The preview uses a plain `<video>`
element, which plays with hardware decoding on phones, including iOS
Safari. The worker uses `@remotion/media` (WebCodecs), which rendered about
twice as fast as `OffthreadVideo` in a measurement here and falls back to it
for files it cannot decode.

**The edit is a JSON document.** A `Timeline` (clips, text overlays, music)
is validated by a zod schema in `packages/core` and changed only by pure
functions (`splitAt`, `trimClip`, `moveClip`, ...). That gives:

- undo/redo as a stack of snapshots, with slider drags merged into one step
- autosave of the whole document, guarded by a revision number: a save
  carrying an old revision is rejected, so a second tab cannot silently
  overwrite the first
- unit tests for every editing rule without a browser
- an export that freezes the document: the job stores the timeline as it
  was when Export was pressed, so later edits do not change that video and
  a retry renders the same thing

**Instagram's rules live in one place.** Length (3 s to 3 min), caption
(2,200 characters, 30 hashtags) and the safe zones where Instagram draws
its UI are in `packages/core/src/instagram.ts`. The editor shows them as you
work; the server checks them again before queuing an export.

## Why not the alternatives

- In-browser export (WebCodecs or MediaRecorder on the phone): no server
  cost, but slow and unreliable on mid-range phones, stops when the screen
  locks, and leaves no job to retry. The older desktop editor in
  `apps/editor` does this; the mobile flow does not.
- FFmpeg filter graphs on the server, with a separate canvas preview: fast
  to render, but every visual feature has to be written twice and kept in
  step.
- Storing edits as a list of operations (event sourcing): finer history and
  merging, but much more machinery than an editor with one user per reel
  needs.

## Consequences

- Remotion is free for individuals and companies of up to three people.
  A larger company needs a Remotion company licence.
- The worker image carries Chrome and the Remotion compositor (about
  1.5 GB). Render time is set mostly by video decoding; `RENDER_CONCURRENCY`
  (default 4) is the main knob, and more workers scale it out.
- Signed media URLs in the editor last an hour. An editing session longer
  than that needs a page reload to refresh them.
- Each reel is edited by one person at a time. Concurrent editing would need
  operation-based merging, which the revision check deliberately avoids.
