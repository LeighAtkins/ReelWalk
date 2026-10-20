# 44. Corners by hand, posts, and a check before export

Date: 2026-10-20

## Context

Four rounds of the Bahia typography reel (post-mortems of 2026-10-19 and
-20) cost a day each, and the tracker was not the reason. The placements
the owner accepted were the ones set from their own drawn boxes; the
ones they rejected were detected or guessed. Every check meant a
fifteen-minute export, because the editor preview is a phone-width frame
and the only way to see a title at full size was to render. Windows with
mullions had no way to add the post that should block the title except
an API save. And a title on a wall that leaves the frame during a push-in
could only be shortened by hand-editing keyframes.

## Decision

The author sets the surface; the app tracks it and shows the result at
full size before anything is exported.

- **Corners by hand.** Opening Pin moves the playhead to the first frame
  of the title's shot, where surfaces are defined. "Set the four corners"
  puts a box around the title with numbered, thumb-sized corners and a
  cross-hair while one is dragged. The detector remains as "Suggest
  corners" and nothing more. A surfaced title fills the quad it is given
  (#173), so the four corners are the whole placement.
- **Posts.** "Add a post" drops a strip across the surface, its two edges
  dragged onto a mullion or pole; the title is cut out where it stands
  (`bars`, #169/#171). Up to eight.
- **Check mode.** A Check button beside Export (and one on the Pin sheet
  after a pin) opens the frame full screen with a strip of marks, five per
  shot (first frame, quarters, last frame). Every title's surface is
  outlined, green where it is the tracked plane. A drift, a title off its
  wall, or a post in the wrong place shows in seconds, not after a render.
- **Early end fades.** A pinned title shortened under Timing to end
  before its shot fades over its last 0.4 s (`endsBeforeShot`), so a wall
  that slides out of frame can be let go cleanly.

## Consequences

Placement quality is now the author's, with the tool making the job
precise and visible; the detector and the tracker are helpers. Check mode
is the acceptance test for any placement before export, in the app and in
our own agent runs. Tracking itself is unchanged; a bare wall under a
push-in still drifts (post-mortem slip 64) and is handled by ending the
title early, until a depth-aware tracker is worth its GPU.
