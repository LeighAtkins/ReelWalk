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

## Amendments after review (GPT-6 Astra, PR #191)

- **The autopilot polish is made from the accepted first cut's input.** When
  the first cut had to be asked for again, the polish used to be made from
  the original reel yet applied against the retry's generation, so a clip
  removed meanwhile could come back. `autopilot-flow.ts` keeps the input of
  the first cut that landed and makes the polish from it.
- **Reel-relative texts get their seconds back within one change.**
  `retimeTexts` restores a reel-relative text that the change only cut
  short (same start, earlier end) or dropped off the end, from `before`,
  then clamps to the new length. A trim dragged in and out, or AI steps that
  shorten the reel on the way, no longer shorten a spanning caption. Texts
  deleted or retimed on purpose (`kept`, `except`) are left alone.
- **A plain attached title stays inside its clip.** After reflowing, an
  unpinned attached title is cut at the end of its clip, or of the run of
  pieces continuing the same source (a split), so a trim never pushes it
  over a cut where the next command would class it as reel-relative.
  Pinned titles keep running past the cut, as tracked.
- **Gesture baselines live as long as their undo step.** The document is a
  framework-free store (`document-store.ts`, rendered by `useDocument` with
  `useSyncExternalStore`). A keyed command continues a gesture only when the
  history will merge it into the same entry (same key, nothing in between,
  a `drag:` key or inside the 800 ms window, now exported from
  `history.ts`). Undo, redo and reset end it; opening or closing a sheet
  calls `endGesture`.
- **No silent no-ops.** `applyCommand` catches a failing command and checks
  its result against `timelineSchema` before it can enter the history; it
  returns `rejected` with the reason, and the editor says the change could
  not be made. A command that changes nothing returns the timeline as it
  was (no undo step). `addRoomLabels` now skips label windows too short to
  use before validating them, which made a 3x speed-up of a short named clip
  fail silently.

## Amendments after the second review (Opus, PR #191)

- **Where a title belongs is decided once, from the timeline before the
  change.** A plain title is cut at its clip's end only when it sat inside
  that clip before and this change shortened or moved that clip (the cut
  point is the end of the pieces continuing it when the change was a
  split). A title that already ran on over the pieces of a split keeps its
  length through later trims, speed changes and duplicates. The review's
  pace and length (`retime`, `retimeToLength`) never cut titles; that is
  the one way they differ from a trim of the same windows.
- **A refused proposal is a failure everywhere.** `proposals.ts`
  (`landProposal`) is the one way Ask, Make it for me and the director
  apply what they bring back; a stale or invalid proposal returns a reason
  and a message, and each path reports it (no "Here is a first cut",
  "Polished" or "Applied" over a rejection; the director loop stops).
- **The Trim sheet is one gesture per opening**, with a `drag:` key, so a
  paused slider keeps one undo step and one baseline.
- **The text limit.** `addRoomLabels` never takes a reel past `MAX_TEXTS`;
  a command on a reel that was already invalid is let through with a
  `warning` so the reel stays editable.
- A rejected drag says so once per gesture, not on every pointer move.

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

- `pnpm check` passes: lint, typecheck of every package, and all unit tests
  (core 408, including 31 in `commands.test.ts`; web 21, in
  `document-store.test.ts`, `autopilot-flow.test.ts` and `proposals.test.ts`, which drive the
  store the editor uses; the existing
  `ai-edit`, `text-follows` and `review` tests pass unchanged).
- `commands.test.ts` proves: the same cut change through `trimClip`, an AI
  plan applied with `applyProposal`, and the review's `retime` gives the
  same title times; picking a song with `snap` is one state change equal to
  the old two steps; a stale proposal is refused and changes nothing; an
  attached text follows a moved clip and a reel-relative caption does not;
  two uses of one video keep separate titles; split, duplicate, speed and
  delete keep pinned titles on their tracked frames (`pinnedProgress`); a
  trim dragged in and back out restores the title.
- `next build` of `apps/web` succeeds.
- Not verified: the Playwright e2e suite. On 2026-10-21 Docker Desktop's
  published ports returned empty replies or dropped connections from the
  host (nginx on :8080, Postgres on :5432, by 127.0.0.1, the LAN address and
  host.docker.internal alike), so neither the compose stack nor a server
  built from this branch could reach the database. Restoring it needs a
  Docker Desktop / WSL restart, which was not done while other agents were
  using the stack. The editor's Ask, autopilot, director and music flows
  have therefore not been exercised in a browser.
