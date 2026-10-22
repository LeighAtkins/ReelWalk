# 68. A designed opening: five hook patterns, one studio, one command

Date: 2026-10-22

## Context

Every reel opens on a caption over a still-ish frame. The reels that break
out open on a face mid-sentence, a camera already moving, a pattern
interrupt, or a text punch with motion. Instagram's skip decision is made in
the first three seconds, and nothing in the app treated the opening as a
thing you design and compare: the Hook sheet (ADR 0041) draws an alert, a
spotlight or a device over whatever shot happens to be first; the critic
(ADR 0062) says "nothing happens in the first second and a half" but cannot
say what the opening should be instead. The five series docs of 2026-10-21
all list the opening as the weak point they could not fix from the API.

## Decision

**An `opening` record on the timeline** (additive, `packages/core/src/timeline.ts`):
the pattern the first 1.5–3 s were cut to (`voice-in`, `motion-in`,
`text-punch`, `pattern-interrupt`, `question`), the clip the reel opens on and
its in-point, the hook line(s) and the promise (what the viewer gets by
staying). It is optional and absent on every saved reel; `hook` keeps its
ADR 0041 meaning, so the new field has its own name.

**A pure planner**, `planHook(timeline, pattern, inputs)` in
`packages/core/src/hook.ts`. It rewrites the opening through the primitives
every other cut change uses (`moveClip`, `trimClip`, `addClips`, titles
retimed by the attachment rule of ADR 0048), so the shared Remotion
composition renders it with nothing new, and one undo removes it. Measured
things (motion samples per clip, a transcript's words per asset, a frame's
mean luma, source lengths) come in as inputs; the planner reads no pixels and
no clock, so the same timeline and inputs always give the same plan.

- *voice-in*: the first speaking shot (a video with its sound on and a
  transcript) moves to the front, trimmed to 80 ms before its first word, so
  the word lands at 0 ms; the title (the line given, else the first phrase
  spoken, else the reel's name) pops at 0 ms and is opaque by 150 ms.
- *motion-in*: the clip measured to move most, started where its move is
  strongest with at least 1.5 s left to play (`strongestEarlyMotion`); with
  no samples, the pacing engine's clip energies (ADR 0059), then a photo's
  camera move. A presenter take is never moved.
- *text-punch*: the line lands as kinetic words (ADR 0061) over 300 ms,
  then the promise; the cut is left alone.
- *pattern-interrupt*: 0.6 s of the clip least like the story's first shot
  (`mostDifferentClip`: measured luma difference, then kind, room, look,
  motion; never a 360 or a presenter take), muted, then a hard cut to the
  story. Titles attached to shots move with them.
- *question*: a boxed question (a `?` added if missing) with the promise
  under it ("Watch to the end" when none is given).

Hook titles are centred at x = 0.47, inside Instagram's safe area, so a
wrapped line never reaches the right-hand button column. The planner strips
any earlier plan's texts and interrupt piece before planning, so re-planning
never stacks openings. A pattern that cannot be made (no speech, no line,
one clip) returns null with a reason the UI and API show.

**Hook rules**, `hookRules(timeline, input)` in `packages/core/src/hook-rules.ts`,
a pure exported function for the critic (W3-F) to call: no empty frame 0, a
title legible by 300 ms (`titleLegibleAtMs` mirrors the composition's
entrance times), motion or speech in the first 500 ms (camera move, a cut,
a transcribed word, kinetic type, measured samples, or a frame difference),
nothing important under the top 13 % or the right-hand buttons
(`titleGeometry` from the critic). A rule that needs a measurement it was
not given says `unknown` rather than guessing.

**One command.** `{ type: "hook", pattern, titles?, promise?, clipId?, … }`
in the document store (ADR 0048), one history entry; `pattern: null` takes
the opening out. `diffTimelines` reports `opening` changes.

**The Hook studio** (`apps/web/components/editor/hook-studio.tsx`), inside
the existing Hook sheet from the Reel sheet (phone-first rule: power where
you tap the thing it affects). Five cards, each a Remotion `Player` looping
the first 1.5 s of the shared composition under that pattern from the
card's own plan; a frames strip at 0, 0.5, 1.0 and 1.5 s through the frame
service (ADR 0047) with the titles on screen; the rules the chosen opening
passes; the hook line and the promise; "Use it" runs the command (one undo).
On opening, `measureOpenings` reads seven small grey frames across each
clip's first three seconds for motion samples and luma, the way clip energy
is measured; the cards re-plan as measurements land. The ADR 0041 drawn
openers fold under "A drawn opener instead".

**Agents.** `POST /api/reels/:id/commands` with
`{ command: { type: "hook", pattern: "voice-in", titles: [...], promise }, revision? }`
runs any document command against the saved reel through the same pure
`applyCommand` and saves at the reel's revision (409 when it moved, 400 with
the reason when the pattern cannot be made). The library's transcripts and
source lengths are filled in when the command omits them.
`GET /api/reels/:id/hook/preview?pattern=voice-in&title=…&promise=…` (or
`pattern=all`) returns, per pattern, whether it can be made and why not, the
planned `opening`, the four moments (clip, media URL, source ms, titles on
screen), the rules, and the planned timeline to save or send as a command.

**Hook lines.** "Write me 5 hooks" in the Ask box (`hookTextRequest`) opens
the Hook studio asking the ideas route for that many lines
(`POST /api/reels/:id/ideas { kind: "hooks", count }`), on the script-mode
text path of ADR 0060 (`structuredAnswer`, no new provider); without a model
configured, `draftHookLines` writes plain questions and promises from the
reel's rooms, price and name. Tapping a line puts it in the hook-line field.

## Consequences

- Saved reels are untouched: `opening` is optional, every hook text has the
  `hook-open-` prefix and the interrupt piece a fixed id, so a reel's own
  texts are never mistaken for the planner's.
- Preview and export still share one composition; the studio's cards are
  that composition at a 9:16 thumbnail.
- The preview route describes frames; it does not render pixels, because the
  web server has no Remotion renderer or browser. An agent pulls the frames
  from the given media URL and source time with ffmpeg, or reads the
  planned timeline and renders it through the worker like any reel.
- Motion measurements are per visit in the browser; an agent sending a
  `hook` command without `motion` gets the pacing-engine fallbacks (clip
  energy, then the clip's own camera-move field), which the API's `note`
  says ("motion not measured").
- Transitions and speed stay as they were (W3-B owns them): the interrupt
  and the story's first shot are hard cuts.
- The critic does not yet call `hookRules`; W3-F wires it as a check.

## What was verified

- `packages/core/tests/hook.test.ts` (24 tests): each pattern's planner on
  fixture reels (voice-in puts the first word at 0 ms and the title at
  0 ms; motion-in opens on the measured peak with 1.5 s left; text-punch is
  legible by 300 ms; the interrupt is 600 ms, muted, hard cut, and the
  attached title follows its shot; question adds the `?` and the promise);
  every pattern on every fixture leaves frame 0 with a clip on it and a
  title legible by 300 ms and passes the zone rule; determinism and
  re-planning from a clean slate; `applyCommand` as one change set and
  `pattern: null` clearing; saved reels parse as before; the rules flag an
  empty frame, a late title, a still opening and titles in the dead zones,
  and say `unknown` rather than guess; `hookTextRequest` and
  `draftHookLines`.
- `apps/web/components/editor/hook-studio-cards.test.ts` (3 tests): the
  cards from the editor's library, the plan a card shows is what one tap
  lands through the document store, one history entry, one undo.
- `pnpm check` (eslint, typecheck, every package's tests): see the PR body
  for the run.
- Not run: the studio in a browser (no dev server in this harness), and
  the two routes against a database. The preview route's pixels are not
  rendered by design (above).
