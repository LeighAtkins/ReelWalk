# 64. A simpler editor: one entry, tap the thing, two finishes

Date: 2026-10-21

## Context

The owner (2026-10-21): "make the app simpler". A studio could start a reel
six ways (Make it for me, New reel, the starter library, a venue, a tour
auto-build, Ask's "Cut it for me" briefs), and once in the editor it could
change the reel from a dozen global buttons (Ask, Director, Hook, Logo,
Details, Caption, AI video, Split, Floor plan, Guides…), a separate draft
review with its own Text/Timing/Music/Look/Ask, and the selection toolbars.
Power was reached by remembering which global sheet held it, not by tapping
what it changes. The house rule since Wave 2 says the opposite: simpler by
default, new power appears where the user taps the thing it affects, phone
first (412×915), thumb-sized, stage centre clear.

Other workstreams are adding pacing (W14), a presenter script (W15), motion
graphics (W16), a critic (W17), variants (W18), music picks (W13) and an
Inspect zoom (ADR 0057). Each would otherwise add one more global button.

### Audit: every entry point before this change

Frequency is how often a studio making listing reels needs it: **every reel**,
**often** (most reels), **sometimes**, **rare**. "Where now" is after this ADR.

| Entry point (before) | What it does | How often | Where it lives now |
| --- | --- | --- | --- |
| Home: "Make it for me" + form (style, facts, rooms) | Upload, rule cut in seconds, model polish (ADR 0021/0024) | every reel | Home "New reel": one tap, no form, straight to the finished cut. The form stays reachable: Reel sheet → "Make it for me again" |
| Home: "New reel" (empty timeline) | Upload into a blank editor | sometimes | Home "Edit it yourself" (the quieter tile) |
| Home: Starter library, Restaurant or café, Auto-build a tour | Other starts | rare | Unchanged |
| Draft review (ReviewBar: Text, Timing, Music, Look, Ask, full editor) | Where a made reel opened | every made reel | Removed: the made reel opens in the editor. Its parts: Words, Pace, Look in the Reel sheet; music suggestions on the music; Ask is the Ask box |
| Toolbar: Ask (sheet; "Cut it for me" on a fresh reel) | Change in words, briefs | often | The Ask box "Change anything…", always under the picture; the button at its start opens the sheet (briefs) |
| Ask sheet → "Tell Opus…" (Director) | Opus reviews, plans, makes AI shots | rare | Still in the Ask sheet; also Reel sheet → "Ask Opus"; a presenter take → Redo take / New take open the script sheet |
| Toolbar: Text | Add a title | often | Bar (nothing selected) |
| Toolbar: Music | Pick or upload a song | often | Bar (nothing selected); tap the music bar for Adjust/Replace/Suggestions |
| Toolbar: Add media | Upload or pick from the library | sometimes | Bar (nothing selected); filmstrip "+" |
| Toolbar: AI video | Generate a shot | rare | Reel sheet; a presenter take → "New take" |
| Toolbar: Split | Split at the playhead | sometimes | Clip bar (a tap on the clip); Reel sheet; `S` key |
| Toolbar: Floor plan (when the reel has one) | Plan overlay, room labels | rare | Reel sheet (when the reel has one) |
| Toolbar: Details | Listing facts, card, caption from facts | sometimes | Reel sheet |
| Toolbar: Hook | Visual hook / words behind (ADR 0041) | sometimes | Tap the first clip or the opening title → Hook; Reel sheet |
| Toolbar: Logo | Logo corner | sometimes | Reel sheet |
| Toolbar: Caption | Instagram caption | every reel (before posting) | Reel sheet |
| Toolbar: Guides | Safe-area guides | rare | Title bar; Reel sheet |
| Toolbar: Delete reel | Delete | rare | Reel sheet |
| Header: Close, title, save state, Check, Export | | every reel | Unchanged |
| Transport: Play, timecode, Undo, Redo, Full screen | | every reel | Unchanged |
| Preview: tap title (select), double-tap (edit), drag, resize, corners | Direct manipulation | often | Unchanged; a tapped title gets the title bar below |
| Clip bar: Split, Trim/Length, Speed, Volume, Motion, 360 view, Look, Zoom, Cover, Fit/Fill, Transition, Duplicate, Earlier, Later | Clip tools | often | All kept; Trim, Speed, Zoom, **Replace** (new) lead, then Hook on the first shot, then the rest |
| Title bar: Edit, Timing, Pin, Guides | Title tools | often | Edit (style), **Particles**, **Walk-through** (both open Edit at that part), Pin, Timing, Hook (opening title), Guides |
| Music bar: Adjust, Replace | | sometimes | Kept, plus Suggestions (Instagram picks, was review-only) |
| Filmstrip: tap/double-tap/drag/trim handles, "+" lanes | | often | Unchanged |
| Look sheet: Luxury finish | Refined/modern grade + type contrast | rare | Kept; "Make it premium" builds on it |
| Review Timing (pace, length) | Shot pace, reel length | sometimes | Reel sheet → Pace; finishes set it too |
| Review Look (one look, all clips) | | sometimes | Reel sheet → Look; finishes set it too |
| Review Text (all texts, room labels) | | sometimes | Reel sheet → Words |

Nothing was removed. Every capability above is still one or two taps away,
and every e2e selector that moved was updated (below).

## Decision

### One entry

The home screen's main tile is "New reel". Pick the shots and the reel goes
straight from the upload to a complete first cut with music, titles and a
hook. That first cut is the rule cut from the fast draft (ADR 0024), and
there is no form. The editor opens on the finished cut.

**No silent AI spend.** Only the rule cut runs by itself, and it uses no AI
allowance. The model's polish waits behind a chip on the finished cut that
says what it costs: "Polish with AI (uses 1 of N left)", with N from this
month's allowance. The chip shows only while the reel is still exactly that
cut. When tapped, the polish lands as one undoable proposal against that
cut's generation (`polishDraft`, ADR 0048).

**No double cuts.** `?auto=1` is cleared as soon as the editor mounts. The
cut runs only when the picked files are waiting in this tab
(`hasPendingFiles`) and nobody has cut the reel yet. A reload, a second tab
or an old link opens the reel as it is.

Rooms are still named while the shots upload. The cut waits up to six
seconds after the last upload for those names, never longer.

"Edit it yourself" (the old New reel, `new-reel-input`) is the quieter tile
for an empty timeline. The style-and-facts form still ships: Reel sheet →
"Make it for me again".

The full-screen draft review (ADR 0022) had no way in left, so it is
removed, along with `?review=1`. Its choice sheets stay: Pace, Look and
Words in the Reel sheet, Suggestions on the music.

### Tap the thing: one control registry

`apps/web/components/editor/controls.ts` is a pure registry. A control
declares:

- its id and label, with an optional `ariaLabel` when the label is a short
  form;
- its targets (`reel` | `clip` | `presenter` | `text` | `music`);
- its order;
- its place (`bar`, or `more` for the Reel sheet);
- a `when` rule.

`targetsFor(selection, presenter)` maps what is selected to targets.
`controlsFor(targets, context)` returns the ordered, de-duplicated list. The
editor binds a handler (icon, action, pressed, disabled) to each built-in id
and renders the bar from the list. The old hand-written toolbars are gone.

- **Nothing selected:** Text, Music, Add media, Pop, Premium, Reel. Pop and
  Premium are announced as "Make it pop" and "Make it premium". All six fit a
  412 px phone without a swipe, and the phone spec measures that.
- **Reel sheet ("This reel"):** Pace, Look, Words, Hook, Details, Caption,
  Logo, Floor plan, AI video, Ask Opus, Split, Guides, Delete reel, and "Make
  it for me again".
- **A clip:** Trim/Length, Speed, Zoom and Replace lead. Hook shows on the
  first shot. Then every clip tool it had.
- **A presenter take:** Redo take and New take, then the clip's tools. Both
  open the script sheet (ADR 0060).
  - A clip counts as the presenter when a script placed it (`script-…`), or
    when its generation was composed with her kit (`isPresenterTake`, read
    from the generation's shot).
  - AI b-roll is an ordinary clip.
- **A title:** Edit (style), Particles, Walk-through, Pin, Timing, then Hook
  for the opening title, then Guides.
  - A callout (ADR 0061) shows no Particles or Walk-through.
  - Shine, kinetic type and callout controls are inside Edit.
- **The music:** Adjust, Replace, Suggestions (where Instagram's sounds are
  on). The Music sheet carries Energy and On the beat (ADR 0059) and Popular
  now (ADR 0058).

**Replace** is new. `replaceClipSource` (replace-clip.ts) puts other media
in the clip's place.

- The clip keeps its id, its look, zoom, fit and transition, and its length
  as far as the new source allows.
- Titles keep their seconds.
- A title pinned to the old picture loses its pin.

**Ask is one box.** "Change anything…" sits under the picture whenever the
deployment has AI.

- What is selected scopes it. The placeholder becomes "Change this
  title…/shot…/the music…", and the request sent starts with what was
  tapped. For example, a tapped title sends "About the title “Just listed”:
  …".
- Sending opens the Ask sheet with the words and runs them, and drops the
  keyboard. Outcome, questions, notes and Undo work as before (ADR 0020).
- The button at the start of the box opens the sheet empty, with the briefs
  and the Director.

**Mounting points.** `control-extensions.tsx` exports `EXTENSION_CONTROLS`:
a control spec plus a `Panel` component. The editor adds them to the
registry and puts the control in the right selection's bar (or the Reel
sheet). It shows the panel in a sheet with `timeline`, `clip`, `text`,
`runCommand`, `apply`, `now`, `seek`, `toast` and `onClose`.

The file records where the parallel work landed:

| Work | Where it lives |
| --- | --- |
| Popular now | Music sheet |
| Energy and On the beat | Music sheet |
| Script mode | Presenter sheet |
| Motion graphics | Title's Edit sheet |
| Critic | Export sheet |
| Variants | Export page |
| Inspect | Magnifier in the transport bar |

A new feature that changes one thing appends one entry there.

### Two finishes

`packages/core/src/finishes.ts` defines `FINISHES.pop` and
`FINISHES.premium`, and `applyFinish(timeline, id, options)`. `applyFinish`
is a pure function behind a document command:
`{ type: "applyFinish", finish, music?, speechAssetIds?, clipEnergy?, songMap? }`.
A finish is therefore one undo step through the same path as every other
change.

| | Make it pop | Make it premium |
| --- | --- | --- |
| Music mood | energetic, upbeat, bright, nu disco, popular | piano, luxury, calm, classy, smooth, cinematic |
| Type | `headline`, Archivo (sans), pops in, strong shadow, at least size 1 | `elegant`, Cormorant (serif), fades in, soft shadow (quiet captions) |
| Pace | Energy 0.85 through the pacing engine; 2 s shots if the song has no tempo | Energy 0.3; 3.5 s shots if no tempo |
| Look | `vivid`; clears the soft lens | `golden` with 0.28 lens softness; motion untouched |
| Drawn hook | sans | serif |

`applyFinish` works in this order:

1. Look.
2. Song. It is set the way the setMusic command sets one: snapped to, then
   onto the bar when On the beat is on.
3. Pace.
   - With a tempo, `paceTimeline` runs at the finish's energy, with the
     measured clip energy and song map the Energy control uses. That gives
     sections, a hero on the drop and On the beat (ADR 0059).
   - Without a tempo, every shot is retimed to the finish's shot length.
4. Type last, so room labels redrawn by the pace are restyled too.

**What a finish never touches**

- **Held clips.** A clip `heldByPace` holds (an AI take, or a video whose
  own speech is heard), or a script's take, keeps its window and its place.
- **A song the studio picked.** `music.autoPicked` is a new optional field.
  It marks songs chosen by Make it for me (rule cut, polish) or by a finish.
  Only those, or no song, may be replaced.
- **Crafted titles.** These are left exactly as they are: titles that are
  pinned or on a surface, painted titles, extruded titles, callouts, kinetic
  titles, shining titles, status tags, and the hook's own words.
- **Title size.** No title is made smaller than the studio set it.

The song itself comes from `POST /api/reels/:id/finish`, which picks with
`pickFinishSong`.

- It picks from the same list Ask and Make it for me use (`context()`):
  Instagram's sounds where the studio can use them, else the library with
  the studio's own songs first.
- It returns `null`, meaning keep the song, when the studio picked the song,
  when an automatic pick already fits the mood, or when nothing fits.
- The editor fetches a picked Instagram sound the usual way, using the
  song's `songFields`, then runs the one command.

`currentFinish()` marks which button is on.

## Consequences

- No migration. One optional field, `music.autoPicked`, is added; existing
  reels lack it, which reads as "the studio's choice". Saved reels open and
  render exactly as before.
- The draft review and `?review=1` are gone (nothing linked to them).
- The Ask box costs one 44 px row under the picture. The bar with nothing
  selected went from twelve scrolling buttons to six that fit.
- A finish cannot pace a reel that is mostly held clips (talking takes) by
  much. That is intended: the line matters more than the pace.

### E2E selectors that moved

- **`ask-for-change`, `ten-asks`:** the global "Ask" button became `ask-box`
  plus `ask-box-send`, with `ask-box-open` for the briefs.
- **`ten-asks`, `reels`:** Logo, Details, Caption and Delete reel are now
  reached via "Reel" → dialog "This reel", under the same button names.
- **`autopilot`:** there is no form on the way in. The test covers:
  - the editor opening on the cut;
  - the polish chip and its allowance text;
  - "Make it premium" plus Undo;
  - Pace from the Reel sheet;
  - the style and facts form again ($ and sq ft) via "Make it for me again";
  - export.
- **`phone-placing`:** a new test checks that all six reel tools are inside a
  412 px screen and at least 44 px tall.

## What was verified

- **Unit tests.**
  - `packages/core/tests/finishes.test.ts` covers styling and look, never
    shrinking a title, crafted titles left alone, held clips with and
    without a tempo, pacing at the finish's energy with On the beat, the
    song switch, one command, and `pickFinishSong` (the studio's song kept,
    auto picks, Instagram).
  - `apps/web/components/editor/controls.test.ts` covers the registry rules,
    including presenter detection and callouts.
  - `autopilot-flow.test.ts` covers polish-later.
- **`pnpm check`** (lint, every package's typecheck, every unit test) passed
  after the rebase onto main (with #204, #206, #207, #208, #210, #211 and
  #212).
- **CI e2e on a Pixel 7 viewport** passed before the review fixes: 38 tests,
  none flaky. The first CI run caught a real phone bug: the wrapper holding
  the Ask box and the toolbar had an `auto` grid column. It grew to the
  toolbar's full scrolling width and put the far clip tools off the screen.
  The wrapper now pins `minmax(0, 1fr)`. The final run's result is in the PR.
- **Not done.** No local run, and no person has looked at the phone layout.
  Docker ports are broken on this machine, so the only check on layout is
  CI's Playwright run.
