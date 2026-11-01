# 0106 — The board: several looks side by side

Date: 2026-11-01

## Context

The owner's reference reel 5019 (13.77 s, 1080×1920, 30 fps) shows the sixteen title effects (ADR 0103) as a
quick compare-and-choose demo, led by its voice. Measured frame by frame:

- **0–1.73 s.** A presenter talks to camera, waist-up, with big gestures. "really good" types out in a thin white sans
  at the top left, then "title" in a bold yellow, with a cursor.
- **1.73–1.8 s.** The text goes and the full frame shrinks into the first panel of a board. The other three panels of
  that column fade in below it, top to bottom.
- **1.8–9.73 s.** An off-white board of 4×4 panels, **one column of four on screen at a time**. It slides to the next
  column at about 3.45, 5.3 and 7.3 s, roughly 0.2 s each slide. Each panel:
  - is a wide strip, 0.925 of the frame wide and about 2.7:1, with rounded corners and a soft shadow;
  - has a tiny grey label above it ("Dot Hop");
  - is cropped from the same presenter footage, mirrored in later columns;
  - shows "try this" in white over the effect's keyword in yellow, arriving with that effect.

  All four panels of a column play at once.
- **9.73–13.77 s.** The board dims to about a quarter. A white Instagram glyph pops in at the centre and the handle
  fades in under it, then the glyph pulses through the brand gradient.
- **Sound.** Voice only, ending at 11.4 s: four lines, one per column ("…try it with a dot?", "…this line art…",
  "…this drop-in effect?", "…pixels effect?").

ReelWalk could not draw any of the middle section. A reel has one track of full-frame clips with titles over them.
The first demo therefore showed the sixteen effects one after another, full screen, over a flythrough. The owner
judged it not close enough: it misses the point of the reference, which is seeing four looks at once to pick one.

## Decision

**A board is a layer of the reel** (`timeline.board`, `boardSchema` in core). It is drawn over the clips and under the
titles from `startMs` to `endMs`. The clips under it still set the reel's length and sound, and panels are always
silent.

- **Grid.** `rows` × `columns` (up to 6 × 6). The panels are listed column by column, top to bottom.
- **One column on screen at a time.** Column times come from `columnAtMs`, or equal shares when it is absent. Each
  change is an eased slide of `slideMs` (default 220).
- **The entry.** Over `entryMs` (default 250) the full frame shrinks into the first panel: its rectangle, corners and
  shadow ease from the frame to the panel, and the background fades up behind it. The rest of the first column fades
  in `staggerMs` apart. When the first panel shows the same footage and time as the clip under the board, the hand-off
  is seamless.
- **Panels.**
  - Footage from the library, playing from `sourceStartMs` when its column arrives and holding its last frame.
  - A crop about `focusX` and `focusY`, with `zoom` and `mirror`.
  - `fit: contain` keeps portrait footage whole over a softened background copy, positioned by the same focus controls.
    The default remains `cover`, preserving existing boards. This avoids cutting a presenter out of a wide panel.
  - A `label` above the panel.
  - A `title`: a `lead` line in the text colour and a `keyword` in the accent colour, on the `left` or `right`. The
    keyword arrives `delayMs` after its column with any of the sixteen effects, typed out, a quick fade, or none.
- **Geometry.** Taken from the reference: panels 0.925 of the frame wide, stacked between 8.4% and 90.6% of its height
  with gaps of 3.7% for the labels, never taller than 16:9. The defaults are the reference's colours: background
  `#f8f6f1`, white lead, `#f2df3a` keyword, grey labels, 22 px corners.
- **Outro (optional).** From `outro.atMs` the board dims to `dimTo` (default 0.25). The Instagram glyph pops to 112%
  and settles in 350 ms, the handle fades in from 250 ms, and the glyph pulses through the brand gradient.
- **Shared timing.** `boardFrame` and `boardPanelEntryOpacity` in core say what moves when. The Remotion `BoardView`
  draws it, so the editor preview and the export are the same frames.

**Editing.**
- One command, `setBoard {board | null}`, sets or removes the whole board as one undoable step.
- It is refused when the board is invalid or runs past the reel's end.
- Saving already refuses media from another workspace, and `referencedAssetIds` now includes the panels' footage, so
  that check and the export cover them.
- The connector's `apply_commands` lists it, and `get_reel` summarises the board.
- The editor's Reel menu has a **Board** sheet:
  - add a 2×2 board from the reel's own footage;
  - set the start, end, grid and column times;
  - per panel, set its footage, label, lead, keyword, effect, side and mirroring;
  - choose fill/crop or fit-whole-shot framing and adjust its horizontal/vertical position; lead text can use two lines;
  - turn the outro on with a handle;
  - remove the board.

**Not a flattening.** Each panel is its own footage, crop and title, drawn live. The board is never baked into a video
outside the editor, so every word and effect stays editable.

**Release order.** Deploy the board-capable worker and update the PC worker before enabling board creation in the web
app. An older timeline parser may silently discard an unknown optional `board` field; its payload-readability check
alone does not prove that it will draw the board. Verify the actual worker image before the first board export.

## Not in this step

1. Dragging panels or the board's columns on the canvas. The sheet edits the fields.
2. Showing every column at once (a zoomed-out view of the whole grid). The reference never does, and on a phone
   sixteen panels at once would be too small to read.
3. A board-aware retention check (titles too small inside panels, a column too short to read its four keywords).

## Readability after owner review

The white and yellow titles blended into the warm room footage. Boards can now set `textShade` (0?0.9, default 0 for existing boards): a dark gradient behind the words fades out before the presenter. It follows the title side and enters with the panel, preserving the seamless first frame. The Board sheet exposes its strength. Narrated demos should time each column to its spoken explanation and leave the settled words visible; keep the narration on the underlying editable clips rather than baking it into the board.
