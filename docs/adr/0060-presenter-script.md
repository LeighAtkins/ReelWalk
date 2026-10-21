# 60. Script mode: a presenter across the whole reel

Date: 2026-10-21

## Context

Pro-editing area 2. The pieces for a presenter who speaks in a reel exist:
the identity kit and the gate before Veo (ADR 0056), voiced takes with a
`line` and `voice: veo | lipsync` (ADR 0038), composed keyframes (ADR 0036),
the director's quote-and-approve pattern and run budget (ADR 0034/0037), and
one command boundary for changes to the cut (ADR 0048). What did not exist
was a way to say "she says these three things, at the start, in the middle
and at the end" without composing each shot by hand or through Opus, and
without her clothes, light and voice changing from take to take (the villa
reel's two takes came back as two different women).

## Decision

**Where it lives.** A "Presenter" button in the timeline's header (top left,
mirroring the zoom buttons top right), shown once the reel has clips. Not a
new global menu: it is on the thing it changes. It opens the Presenter sheet:
the kit picker (the existing `PresenterPicker`), two to four lines (one is
accepted too), where each plays, what she wears, her voice, the quote and
Generate.

**Placement is pure** (`packages/core/src/script.ts`). `scriptSlots` lists
every cut as a place a take can go, with its plate: the end of the clip
before the cut (so the cut into her take matches), else the start of the
clip after it; 360 photos and generated (`ai-`) clips are never plates.
`planScript` opens with the first line, closes with the last, and puts the
ones between at the cut nearest their even share of the reel, preferring a
change of room, keeping order and leaving room for later lines. With too few
cuts a line shares the previous line's place: the two takes play back to
back. The studio can move any line to another cut (a select per line, with
the plate's thumbnail and a strip of numbered marks over the reel).

**Continuity, in every prompt.**
- *Outfit.* One description per script ("a cream linen blazer, white tee,
  light jeans"; default: the clothes in her full-length kit photo), turned
  into one sentence repeated word for word in every composed still and every
  Veo prompt. It is stored on the script: in each generation's
  `shot.script.outfit`, and the editor remembers the last outfit per kit
  (`localStorage`) so the next script starts with it. Not on the kit: that
  needs a Presenter column and a migration, and the kit's routes belong to
  the identity work in flight (fix/identity-gate).
- *Light.* When Generate is tapped the editor reads each plate through the
  frame service at 48×85 and `lightFromLuma` says where the key light is
  (left, right, behind her, or even). The still and the prompt say so ("the
  key light comes from the left of the frame … her shadow falls to the
  right like the furniture's"). A frame that cannot be read falls back to
  "light her like the room".
- *Walking in.* `scriptContinuity`: when two takes are back to back, the first
  ends with her walking out to the right and the next starts with her
  stepping in from the left edge, "continuing from the previous shot". The
  composed still for that take puts her mid-stride at the left edge.
- Every take: medium framing, the workspace's kit (`compose.presenterId`), the
  plate as the first frame, so the identity gate runs as for any composed
  shot. Gate internals are untouched. Since the gate's amendment (#205)
  wants a speaking face of 165 px or more with both eyes and the mouth
  rendered, the still's description asks for exactly that ("her face large,
  sharp and front-lit, both eyes and her mouth clearly visible"). Room (40)
  and outfit (120 characters) are bounded so the description always fits
  the schema's 600 characters whole, never cut mid-sentence.

**Voice.** One voice per script (the schema has `voice` on the script, not the
line). Default `veo`: Veo's own audio; the worker's `voicedPrompt` adds the
line and the Australian accent, and our prompt adds "her same warm
Australian voice in every take". `lipsync` is offered only when the web is
told it is configured (`LIPSYNC_ENABLED=true`, alongside `VOICE_ENABLED`;
the sync.so key lives only on the worker), and the server refuses it
otherwise.

**Credits.** `scriptQuote`: a line of up to seven words is a 4-second take,
longer ones 8 seconds; every take is voiced (ADR 0038's extra credit). The
sheet shows the per-line and total quote and the balance before Generate.
`POST /api/reels/:id/script` takes `{ script, quotedCredits, approved: true }`
(same origin, signed in, reel in the workspace), rebuilds every prompt,
duration and credit from the lines with `buildScriptShots`, and refuses a
quote that differs ("The credit quote changed"). It refuses to start a
script the balance cannot finish (half a script is not what was approved).
Each take goes through `createAiGeneration` with `exactPrompt: true` and a
request id derived from the workspace, script id and line
(`scriptGenerationRequestId`), so the reservation's idempotency (ADR 0034)
means a retried approval never charges a take twice.

**Two at a time.** The credit reservation allows two generations in flight
per workspace. The route starts what fits and returns the rest as
`waiting`; the editor keeps the approved script (localStorage, per reel) and
a hook (`useScriptRun`, mounted with the editor, not the sheet) polls
`/api/ai/generations` every 10 s, finds the script's takes by
`shot.script.id`, and sends the same approval again when a slot frees. A
take that fails is refunded by the existing path and is not retried (a
retry is a new script and a new approval).

**Placing them: one command, one undo.** When every take has landed or
failed, the button shows a dot, a toast says so, and "Put N takes in the
reel" runs one `insertPresenterTakes` command (`commands.ts`, one new case
that calls `insertPresenterTakes` through the same `retimeTexts` as every
cut change). Each take goes after the clip its script chose (before the
first for the opening); if that clip has since been removed, at the cut
nearest where it was. Back-to-back takes keep their order. A take plays
whole at 1×, `volume: 1` (her voice), graded like its plate's clip, with the
plate's room. Clip id `script-<assetId>`, so placing twice changes nothing.
Titles attached to a clip follow it; captions across cuts keep their
seconds (ADR 0048's rule).

**Writing the lines.** "Write them for me" asks the existing ideas route with
`kind: "script"`, the rooms in order and the titles on the reel as the
editor has it. With no model configured it returns `draftScriptLines`
(greeting, rooms, call to action).

## Amendments after review (Opus, PR #206)

- **A lost response never charges twice.** The approved script, with its
  id, is saved (localStorage, per reel) *before* it is sent
  (`startScript`). A dropped response leaves it in place and the editor's
  next poll sends the same approval, so the same request ids. It is
  forgotten only on a definite refusal (a 4xx other than 401/408/429) when
  the server shows nothing was made for that script id.
- **A script always ends.** A refusal after some takes were made (the
  balance spent elsewhere between takes, a kit or plate gone) marks the
  takes not yet started as "not started (no credit used)" and the script
  settles. "Stop here" is offered whenever it has not: it places the takes
  that are ready (one command, one undo) and starts no more; takes being
  made finish and stay in Media. The hourly generation limit is a pause
  (`paused: "hourly"`, the takes wait and start by themselves later), as is
  a full workspace (`paused: "busy"`); a lost worker wake no longer fails
  reserved takes (the next poll wakes it).
- **Progress from the script's own rows.** `GET /api/reels/:id/script?scriptId=`
  derives the script's request ids on the server and returns exactly those
  generations (status, error, failure code, finished asset) and the
  workspace's in-flight count. The sheet uses it, not the workspace's
  last-20 list, so an old script is never stuck as "waiting".
- **Every shot is checked before it is sent.** `buildScriptShots` parses
  each shot with `aiShotSchema`, the schema the worker reads it back with,
  and throws `ScriptShotError` (the route answers 400) rather than sending
  one the worker would read without its voice (a silent take charged as
  voiced). Lines are cleaned before anything else sees them: quotation marks
  and line breaks removed (the worker quotes the line in Veo's prompt),
  spaces collapsed, at most 20 words. A generated (`ai-`) plate is refused.
- **An approval lasts an hour.** After that, waiting takes are not started
  until the studio taps "Carry on · N credits" (the credits still owed).
- **What happened to each credit is said honestly:** returned (failed),
  held (could not be confirmed, ADR 0056: never charged twice), made but
  missing from the library, or never used (not started).
- Verified: `pnpm check` passes; `script.test.ts` 20 tests (cleaning,
  the word cap, the `ai-` plate, `ScriptShotError`), `script-routes.test.ts`
  12 (the script's own rows by derived ids, hourly pause, a lost wake,
  refusals keeping started takes, request ids distinct between scripts),
  `script-flow.test.ts` 13 (saved before sent, the same id sent again after
  a lost response, forgotten only on a definite refusal with nothing made,
  stopped scripts settle, Stop here places what is ready, credit wording,
  answer classes, approval expiry).

## Consequences

- No migration. `aiShotSchema` gains an optional `script` object (additive;
  saved rows and older shots parse as before).
- A script keeps going only while an editor tab of that reel is open (in
  that browser: the approval is in its localStorage), like ADR 0037's run. Takes already started finish regardless and stay in the
  library.
- The outfit is per script and per browser, not per kit. A kit-level
  `outfit` (a Presenter column) is the follow-up once the identity work has
  landed.
- The light measure is a coarse left/right/behind split of one frame's
  luminance. It cannot see a key light from above or colour temperature;
  the instruction still asks the image model to match the room.
- Veo's voice is not a fixed identity: "one voice" across `veo` takes is a
  prompt, not a guarantee. Lip sync (one fixed voice) waits on the sync.so
  key.
- A 4-line script on a 1-clip reel puts three takes back to back at the
  opening; the studio can move them.

## What was verified

- `pnpm check` (lint, typecheck of every package, all tests) passes.
- `packages/core/tests/script.test.ts` (17 tests): plates and slots (360 and
  generated clips skipped), the plan for 1–4 lines (room change preferred,
  order kept, back to back when short of cuts), the quote, the outfit
  sentence word for word in every still and prompt, light per plate, walking
  in/out, one voice, shots accepted by `aiShotSchema` with kit, medium
  framing and plate, compose text under 600 characters at the longest
  room, outfit and light without a cut sentence (a first draft was cut
  mid-sentence; the test caught it), `lightFromLuma`,
  placement (including a removed anchor clip and back-to-back order), the
  command retiming titles and being idempotent.
- `packages/core/tests/script-routes.test.ts` (7 tests, generation mocked):
  login, origin, approval and reel ownership; a wrong quote and an
  unaffordable script start nothing; lip sync only when configured; the
  server's own exact prompts and stable request ids go to
  `createAiGeneration`, two at a time; sending the approval again carries on
  without charging a take twice; a lost race for the last slot waits instead
  of failing.
- `apps/web/components/editor/script-flow.test.ts` (5 tests): take states
  from the generations list, when to start the next take, failed takes left
  out, and placing all takes through the editor's document store as **one
  history entry that one undo removes**.
- Not verified: any live Gemini/Veo/sync.so call (none were made), the
  sheet in a browser at 412×915, the light measure on real plates, and the
  ideas route's live model answer.
