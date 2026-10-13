# ADR 0021: Make it for me

Status: accepted (2026-10-13)

## Context

ReelWalk sells on one promise: a photographer with a phone full of shots
gets a finished listing reel without editing. ADR 0020 let a studio ask for
changes in words, but someone opening the app for the first time still had
to build the reel first. The first experience has to be: pick the shots,
press one button, watch a reel come out, with music, cuts on the beat and
text, rendered. It has to work every time, including for a Free studio, on
the first try, with whatever shots it picked and nothing typed.

## Decision

**One button on the home screen.** "Make it for me" leads the home screen;
"New reel" (edit it yourself) sits under it. Both open the same file
picker. The editor opens with `?auto=1` and, while the shots upload, shows
the "Make it for me" sheet: a style (Just listed, Luxury slow, Open house,
Walkthrough) and optional facts (address, price, size, beds, baths, the
open-house time). Pressing "Make my reel" waits for the uploads, then runs
without another tap, showing each step, and ends on the export screen with
the render under way.

**The model cuts, the rules finish.** `makeItForMe` (apps/web/lib/autopilot.ts)
asks the model through ADR 0020's `askForChange` with a request written
by `autopilotRequest` (the style's brief, the facts, and: use whatever
shots there are, never ask, never repeat a shot). Whatever comes back is
put through `finishAutopilot` (packages/core/src/autopilot.ts), which adds
anything a finished reel needs and the model left out: a song cut to the
beat, a hook over the first shot, the facts on the details card, room
labels, and takes out a photo shown twice.

**The rules can do it alone.** When there is no model, the studio's AI
allowance is spent, or the model's answer is not a usable reel (no clips,
under 6 s, over 90 s, a clip under 0.7 s), `ruleCut` cuts it instead:
outside shots first and views last, photos at the style's pace with a
push-in, 360 photos as sweeps, long videos split into two or three shots
from their middle, kept under the style's length, then finished the same
way. So the button always produces a reel; the model makes it better, it
does not make it possible.

**The editor does the saving and the export.** The route
`/api/reels/[id]/autopilot` returns the timeline; the editor applies it as
one undoable step, flushes its autosave and calls `exportReel`, which
redirects to the export screen. If the export is refused (a plan limit),
the reel stays in the editor with the reason and, where a bigger plan
lifts it, a "See plans" button.

## Music

The music is a library song, which the render includes, so the MP4 that
a Free studio downloads has music. An Instagram sound (ADR 0019) is not
in the rendered file; it is attached by Instagram when the reel is posted
from ReelWalk, which needs a paid plan and a connected account. Choosing a
trending Instagram sound in "Make it for me" for those studios is the next
step; until then they can switch the sound in the editor or at posting.

## Consequences

- It costs one AI request (when the model is used) and one export.
- The shots must finish uploading on the phone; everything after that
  is about 40–50 s of model time with the screen open, then the render
  runs on the servers and the studio can leave.
- The rule cut is the floor of quality: tests pin its ordering, splitting,
  length and finishing, so a model outage degrades the reel, not the
  promise.
