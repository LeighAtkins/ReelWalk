# ADR 0022: A draft to review before export

Status: accepted (2026-10-13)

## Context

"Make it for me" (ADR 0021) went from shots to an export with no stop in
between. Trying it on a phone, Leigh found the result is better treated as a
rough draft: you want to watch it with its music, change a line of text or
the pace, and export only once it is right. The timeline editor is the wrong
place for that: on a phone it is dragging handles, and most changes people
want are a handful of the same few.

## Decision

**Make it for me ends on a draft.** The cut, the Instagram sound and the beat
snap happen as before; then the editor opens in **review** mode instead of
exporting. Review shows the reel full width with its music and, in place of
the transport, timeline and toolbar, five quick changes and Export:

- **Text**: each line of the reel's own text, to reword or to replace with one
  of three suggestions (`/api/reels/[id]/ideas`, kind "text"); room labels on
  or off.
- **Timing**: Faster, Steady, Slower (2, 3, 4 s shots) or a 15, 20 or 30 s
  reel (`retime`, `retimeToLength` in `packages/core/src/review.ts`); texts
  follow their shots, cuts go back on the beat, room labels are redrawn.
- **Music**: three Instagram songs of different moods, each to hear first,
  "Three more", or the full Music sheet (`ideas`, kind "music").
- **Look**: one filter for every clip.
- **Ask**: anything in words (ADR 0020).

"Open the full editor" switches to the timeline; `?review=1` opens a reel in
review. Every change is an ordinary timeline edit, saved and undoable.

**The facts and the rooms before the cut.** The panel offers "Add $ and sq ft
for me" (on by default, with a "Shows as $1,240,000 · 2,400 sq ft" preview;
anything already typed with a sign or words is left alone). As soon as the
shots are up their rooms are named by looking at them
(`/api/reels/[id]/rooms`, the same labelling as ADR 0021) and listed with
their thumbnails, each name a menu the studio can change.

## Consequences

- The first reel costs no export until the studio is happy with it.
- The review is the default after Make it for me; the timeline is still one
  tap away and unchanged.
- Music ideas need a connected Instagram account; without one the sheet says
  so and offers the full Music sheet (the studio's own songs).
