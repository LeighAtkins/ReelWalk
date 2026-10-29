# 0095 - Notes on a version: the back-and-forth on the export screen

Date: 2026-10-29

## Context

The owner, 29 Oct: *"I'd like to do more editing through the actual app. Ideally the making-video back-and-forth, I can
do it inside reelwalking."* Today each round goes through the orchestrator, builder agents and outside judges: 20–90 min
a round, watched on a CDN page, with the timeline out of sight (ReelWalk-hybrid `output/inapp-cocreate/plan.md`).

What main already has:

- **Ask for a change** (ADR 0020, Opus per 0032). It turns one request into a plan of 27 operations. That is fewer than
  the 37 document commands (`COMMAND_TYPES`), and it keeps no memory between requests.
- **The connector's tools** (ADR 0077): `get_reel`, `apply_commands` with `dryRun`, `get_frames`, `get_checks`,
  `get_audio_trace` and the rest. These are exactly what the builder agents use, but they are only reachable from
  outside the app.
- **Render checks and the Judge view** (ADR 0071): the opening, the loop point and the checks of each export.
- **Credits.** `generate_ai_shot` quotes first, and the director's approval needs `quotedCredits`. But
  `POST /api/ai/generations` spends without a quote, so an agent inside the app must never be able to reach it.

## Decision

**What the owner does.** On the export screen (phone first), a *Notes* card holds a box: "show the desk earlier", "make
the titles bigger". *Make the next version* sends the note. The card then lists the reel's versions, newest first. Each
version shows:

- the note that made it and the agent's one-line answer;
- four frames of its opening (0, 0.5, 1, 1.5 s) and four up to the loop point (the Judge view's moments);
- its render checks, folded into one line (blocked, N warnings, or clear);
- *Watch*, which opens that version on this screen (`?v=<exportId>`);
- *Go back to vN*.

A note that changed nothing gets its own line in the thread with the reason. The page refreshes itself while a note
works or its version renders, so the phone can sleep.

**What the server does** (`lib/reel-notes.ts`, `lib/reel-thread.ts`, `POST|GET /api/reels/:id/notes`):

1. **Start.** `startNote` checks AI is on and the month's AI requests (`aiEditBlockedReason`; a note counts as one).
   It allows one working note per reel. It records the note and starts an `AiJob` (ADR 0021), then answers at once.
2. **The agent.** Opus 5.5 (`aiModel()`, `claude-opus-5-5` by default) runs a tool loop through a new provider call,
   `claudeToolTurn`, next to `structuredAnswer`. It uses the same AI switch, provider gate, and direct or Vertex route,
   and is Claude only. The system prompt and the tools are one cache breakpoint, and the conversation is auto-cached.
   The history is sent back unchanged, thinking blocks included. The agent acts as the person: `runAsUser`, the
   connector's own `runTool`, and its per-person rate limits. Its brief names the reel, its versions and the last five
   notes with their answers. That is the thread's memory.
3. **The rules, enforced in code, not in the prompt:**
   - **Tools.** Only `get_reel`, `get_brand_kit`, `list_media`, `get_audio_trace`, `get_frames`, `get_checks` and
     `apply_commands` (`NOTE_TOOLS`). There is no `generate_ai_shot`, `get_ai_shot`, `export_reel`, `add_media`,
     `search_stock` or `create_reel`, and nothing in this module can reach `/api/ai/generations`.
   - **Scopes.** The scopes are `reels:read` and `reels:write` only, with no `exports` and no `ai:generate`. Even a
     spending tool that slipped into the list would be refused by `runTool`, and `noteToolSpecs` drops any tool that
     needs either scope.
   - **This reel only.** Every `reelId` is bound to the note's reel, and every `exportId` must be one of its exports.
   - **Dry run first.** A saving `apply_commands` must carry a revision and exactly the command list that was dry-run
     earlier in the same note. The revision guard answers 409 if the owner edited meanwhile.
   - **At most 12 tool calls.** After the twelfth, the next turn is sent with `tool_choice: none`, so the agent must
     answer.
   - **Arguments are checked** against the tool's zod shape before it runs.
4. **Export.** When a batch was saved, the server queues the export itself (`queueReelExport`). The agent cannot export.
   Leaving the export out of the loop keeps a note's cost and time bounded: the agent never polls a render. That render
   becomes v(n+1).
5. **Record.** The note is stored as an `AiEdit` row:
   - `request` is the note and `note` is the answer;
   - `plan` is `{ kind: "note", status, fromExportId, toExportId, revisionBefore, revisionAfter, calls, costUsd }`;
   - `applied` is the change lines, and the token counts are stored too.

   Each note logs one JSON line: `event: "reel-note"`, the tokens (with cache read and write) and `costUsd` at list
   price.

**Versions are the reel's REEL exports.** They are numbered v1… in order of creation. A version is the *current cut*
when its payload timeline has the same `timelineGeneration` as the saved reel. *Go back to vN* saves vN's payload
timeline as a new revision (`saveReelFor`, so the editor can undo it like any save). It renders nothing: vN's export is
already there to watch and post (`?v=`).

**No new table.** Notes are `AiEdit` rows with a `kind`, the way the director stored its plans (ADR 0034). Versions are
`RenderJob` rows, which already carry the frozen timeline and the checks. The job is an `AiJob` with `kind: "note"`
(a string column). So there is no migration.

**The stand-in.** `DEV_FAKE_AI` runs `fakeNoteTurn` through the same loop, tools and guards. "bigger" scales every title
by a quarter, and "earlier" starts the first clip a second later in its file.

## Consequences

- **Cost.** The plan estimated $0.20–0.40 a note. The local proof on a copy of "Does it fit?" ep 1, with Opus 5.5 live,
  came in lower:
  - **$0.0496** for 2 calls (read and frames), no change. Of 16.8k input tokens, 9.9k were cache reads.
  - **$0.0665** for 4 calls (read, frames, dry run, apply), exported. Of 32.8k input tokens, 24.9k were cache reads.

  No credits are spent, and the render counts as one export on the plan.
- **A baked reel can still be re-cut.** The first proof note, "show the desk earlier", came back with "changed nothing,
  it is one rendered clip". It was right that the framing cannot change, but it missed that the clip could be split and
  reordered. The instructions now say so. The owner's follow-up ("open on that desk close-up from about 6 to 9 s") then
  gave v2, cut 6–9 s, 0–6 s, 9–12 s.
- **What a note can't do.** It can only change what is in the app timeline. A note about something drawn inside a baked
  clip (a three.js render, a title burnt into the file), new footage, a voice or an AI shot gets "changed nothing,
  because…". Phase 3 brings quoted AI shots into the thread through the director's `quotedCredits` path.
- **Not durable.** The agent runs in the web process (the in-process `AiJob` path). A deploy mid-note loses it; after
  15 minutes the thread shows it as failed and nothing was exported. Moving it onto the worker's durable steps (ADR 0049)
  needs the connector tools to run without Next.js. That is a follow-up.
- **Not yet built** (phases 2–5 of the plan):
  - the LLM retention and glitch judges;
  - *Save as rule* and per-workspace rules (the agent gets the house style, `STYLE_HINTS`, only);
  - Approve vN;
  - the `add_note` / `get_thread` connector tools.
- **Vertex.** The `cache_control` at the top of the request is the Claude API's automatic caching. The Vertex route sends
  the same body and is unproven live, like the rest of ADR 0072.
