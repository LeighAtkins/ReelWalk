# 48. One command boundary for changes to the cut

Date: 2026-10-21

## Context

The 2026-10-21 rewrite review (Sol A #1) found that "change the cut" meant
something different behind every button. A trim or a reorder in the editor
called `trimClip`/`moveClip` directly, and the titles stayed at their old
seconds over a different picture. The beat snap clipped texts to the new
length but did not move them, and the editor redrew room labels as a
separate step. AI edits and the draft review moved texts with
`anchorTexts`/`reflowTexts`, and moved every text, including captions that
span several shots (slip 28: the same cut change moved the titles three
different ways). Picking an Instagram sound took two undo steps (the song,
then the snap). The three async paths each protected the studio's work in
their own way: the autopilot counted "edits since the draft" by hand, Ask
replaced the reel with no baseline check at all, and the Opus director
compared whole timelines (`sameTimeline`).

## Decision

**Commands.** `packages/core/src/commands.ts` defines the editor's document
commands (`trimClip`, `moveClip`, `splitClip`, `deleteClip`,
`duplicateClip`, `setSpeed`, `setMusic` with an optional `snap`,
`snapToBeat`, the review's `retime`/`retimeToLength`, and
`applyProposal`) and one pure `applyCommand(timeline, command, context)`
that returns `{ timeline, changes, stale? }`. `changes` lists the clips,
texts, music and other parts that differ.

**Overlay timing, written down.** v1 timelines have no attachment field, so
the attachment is derived from the saved data (`textAttachment` in
`text-timing.ts`). The rule is conservative: a text only follows a clip
when there is no doubt which one.

- A room label (`room-…`) is *managed*: `addRoomLabels` redraws it.
- A pinned text (`pin`) is *attached* to the clip it starts over when that
  clip shows the pinned asset: its path was tracked on that picture.
- A text that starts and ends inside one clip is *attached* to that clip.
- Everything else (a caption or hook across a cut, a text past the end) is
  *reel-relative*: it keeps its seconds and is only cut short at the end.

Attachment is by clip id, not asset id, so two uses of one video keep their
own titles. Pins stay source-anchored: `pin.fromMs/toMs` are untouched;
moving the text with its clip keeps `pinnedProgress` reading the same
frames.

**One retiming function.** `anchorTexts`/`reflowTexts` moved unchanged from
`ai-edit.ts` to `text-timing.ts`. `retimeTexts(before, after)` builds on
them: attached texts go back over their clip's picture (in source time for
video, so speed changes and start trims keep the frame), reel-relative
texts keep their seconds, nothing runs past the end, room labels are
redrawn when the reel has them. Every command that changes the cut, the
AI edit (`applyAiEditPlan`) and the review (`retime`) call it, so the same
cut change moves the same titles the same way. A split hands the texts
over the second half to the new piece; a trim gesture anchors every step
to the timeline before the gesture began, so dragging a handle in and back
out restores a title the drag had squeezed.

**One staleness rule.** The editor's document (`use-document.ts`) wraps the
existing `history.ts` reducer, unchanged, and keeps a generation that rises
on every change to the reel (edit, undo, redo). Commands run synchronously
against the latest state, so a caller learns at once whether its command
landed and which generation it produced. Ask, the autopilot's first cut and
polish, and the director each send the reel with the generation they read;
`applyProposal` replaces the reel only if that is still the current
generation, else it returns `stale` and changes nothing. The editor then
says "The reel changed while that was being worked out … review the reel
and ask again" (Ask), keeps the studio's version with a note (autopilot
polish), or refuses Apply (director). A director review saved in an earlier
session has no generation; it counts as made against the current reel only
if `sameTimeline` says it is the same edit, which is the one place that
comparison remains. A song a proposal chose is fetched first and set,
snapped to, in the same command: the edit and its music are one undo.

**One undo entry per action.** All of the above go through `runCommand`,
which dispatches one `apply` to the history. Picking a song and snapping
the cuts to it is one entry.

## Consequences

- AI edits no longer drag captions that span cuts along with the first
  shot they started over; they keep their seconds, as manual edits do.
- Manual trims, moves, deletes and the beat snap now move attached titles
  and redraw room labels, where before they left them at their old seconds.
- A room name landing after the autopilot's first cut has been asked for
  makes that request stale; the first cut is cheap and is asked for again
  once. Room naming that changes nothing no longer creates a new reel state.
- Not yet commands: inserting an AI shot mid-reel (`insertAiShot`), adding
  media, the luxury finish, and the text/placement edits (they do not change
  the cut). The placement callbacks belong to the placement rewrite and were
  left alone.
- The attachment is derived, not stored. Storing it (and letting the studio
  pin a caption to the reel or a clip explicitly) is a schema addition for
  later; the derivation stays as the adapter for saved v1 reels.

## What was verified

See the pull request for the exact commands and results: `pnpm check`
(lint, typecheck, all unit tests including the new `commands.test.ts`) and
the e2e suite run against a production build of this branch.
