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

1. **Start.** Every AI request that spends the month's allowance reserves through one function, `reserveAiEdit`: Ask,
   the director, Plan my shoot and notes. Each creates its `AiEdit` row there, *before* any model call. The reservation
   is one transaction under a transaction-scoped advisory lock per workspace, which is safe on the transaction pooler.
   It counts the month and creates the row together, so requests of any kind racing for the last slot can never pass the
   allowance. Ask and Plan my shoot used to write their row after the model answered.

   **What the reservation stands on:**
   - **One database timestamp.** The transaction's `now()` both picks the month that is counted and stamps the row's
     `createdAt`. A request made across midnight UTC is counted in the month it is stamped in.
   - **A key, where the request has one.** A durable step is keyed `step:<id>:g<generation>` (ADR 0049), and an
     in-process job by its id. A replay of the same step, say after the worker died before submitting, finds the row it
     reserved and reuses it. It is never charged twice, and never refused for want of a second slot. A new generation
     is a new request.
   - **Charged even when the model fails.** Ask (and "Make it for me", which calls it) and Plan my shoot now charge
     their request even when the model fails or gives a bad answer. They charge once per request, never twice on
     retries. The director and notes already worked this way: "requests made this calendar month, whatever came of
     them".

   A note's reservation also runs its own checks under the same lock, *before* the allowance is counted:
   - a retry of the same request id gets the same note, refused for another reel or other words, so the last allowed
     note can be retried;
   - the reel's notes whose time is up are expired, and a live one refuses (one working note per reel).

   Then it creates the note and its `AiJob` (ADR 0021) together. The note's times come from the database's clock. The AI
   switch and availability are checked before the reservation; the allowance is not. The run starts after commit, and
   the route answers at once.
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
   - **Dry run first, at the same revision.** A saving `apply_commands` must carry a revision, and a dry run of exactly
     that command list must have passed *at that revision*. After a 409 (the owner edited) or after any save, the agent
     needs a new dry run: an absolute-time `splitClip` checked against one cut never lands on another.
   - **Times, held at the write.** A note stores, in database time:
     - `deadlineAt`, 10 minutes: no model turn after it;
     - `saveBy`, 30 s earlier: no save after it;
     - `expiresAt`, a minute later: no export after it, and from then it can be expired.

     Saves are fenced inside the save itself. The agent's saves run inside a save fence (`lib/save-fence.ts`). In the
     save's own transaction, `saveReelFor` takes its locks in one fixed order, the note's row and then the reel's:
     1. Lock the note (`FOR UPDATE`) and check it is still `working`.
     2. Lock the reel's row.
     3. With every lock held, check `clock_timestamp() < saveBy`. That is the time now, not the transaction's start,
        which can be long before a lock wait ends. It is closed at the instant itself.
     4. Write the reel, then check the clock again, and roll back if the time is up.
     5. Record the new revision and the saved command lines on the note.

     A slow tool, rate limit, validation step or lock wait cannot slip a save past the time, or past an expiry.
   - **At most 12 tool calls.** After the twelfth, the next turn is sent with `tool_choice: none`, so the agent must
     answer.
   - **Arguments are checked** against the tool's zod shape before it runs.
4. **Export.** When a batch was saved, the server queues the export itself; the agent cannot export.
   - Leaving the export out of the loop keeps a note's cost and time bounded: the agent never polls a render.
   - The export is of exactly the revision the note saved (`queueReelExport(…, { revision })`). If the owner saved in
     between, nothing is exported and the note says why, rather than shipping the owner's edit as the note's version.
   - The export is fenced the same way, in the same lock order. `commitReelExport` creates the job and its outbox
     message in one transaction, which:
     1. locks the note and checks it is still working;
     2. locks the reel's row (`FOR UPDATE`, held until the job is written) and validates the revision there, so an
        owner's save waits for the export instead of slipping in between;
     3. checks `clock_timestamp() < expiresAt` before creating the job, and again after it (rolling back if late);
     4. records the job's id on the note.

     A note that expired, or whose time ran out, creates no job. Expiry is decided by `clock_timestamp()` too, and waits
     for a note whose row is held, never overtaking it. Every write takes the note's lock before the reel's, and expiry
     takes only the note's, so the locks cannot form a cycle.
   - The created job's id is the one recorded, not "the newest job". That render becomes v(n+1).
5. **Record.** The note is stored as an `AiEdit` row:
   - `request` is the note and `note` is the answer;
   - `plan` is `{ kind: "note", requestId, status, deadlineAt, saveBy, expiresAt, fromExportId, toExportId,
     revisionBefore, revisionAfter, calls, costUsd, error? }`;
   - `applied` is one line per saved command, and the token counts are stored too.

   **Facts are committed with their effects.** The saved revision and lines go in the save's transaction, and the job's
   id in the export's. A restart between an effect and the run's report can therefore never lose either. The **status**
   moves only from `working`, to one of:
   - `exported`;
   - `saved` (changed, not exported, with the reason);
   - `no-change`;
   - `failed`;
   - `expired`.

   A provider or tool failure part-way keeps what the run had done, spent and saved (`NoteRunError.partial`). A change
   that was saved is still exported, and the note says Opus stopped before summing up.

   Expiry is one conditional `UPDATE` by the database's clock, so eligibility is decided at the write, under the row's
   lock. An expired note's reply is built when it is *read*, from its current facts: "saved revision N", "its version
   was queued", or "changed nothing". It is never stored at the moment of expiry, so it can't go stale. Expiry frees the
   reel for the next note.

   Each note logs one JSON line on every path: `event: "reel-note"`, the status, any failure (including a failure to
   record the note), the tokens (with cache read and write) and `costUsd` at list price. The log line is in a `finally`
   block, so it can't be skipped.

**Versions are the reel's REEL exports.** They are numbered v1… in order of creation. A version is the *current cut*
when its payload timeline has the same `timelineGeneration` as the saved reel. *Go back to vN* saves vN's payload
timeline as a new revision. It uses `saveReelFor`'s exact mode, with the same access, validation and revision checks and
the editor can undo it like any save. Exact mode does not keep the current text fields that the incoming timeline omits:
a plain save would carry v2's font, blend or brand over into v1. It renders nothing: vN's export is already there to
watch and post (`?v=`). The thread reads the newest 50 notes and the 6 newest versions, numbered from the first.

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
- **Not durable.** The agent runs in the web process (the in-process `AiJob` path). A deploy mid-note loses the run.
  After its deadline the note is expired, with what it had committed: "saved revision N, not exported" or "changed
  nothing". Nothing can save or export for it after that. Moving it onto the worker's durable steps (ADR 0049) needs the
  connector tools to run without Next.js. That is a follow-up.
- **Not yet built** (phases 2–5 of the plan):
  - the LLM retention and glitch judges;
  - *Save as rule* and per-workspace rules (the agent gets the house style, `STYLE_HINTS`, only);
  - Approve vN;
  - the `add_note` / `get_thread` connector tools.
- **Vertex.** The `cache_control` at the top of the request is the Claude API's automatic caching. The Vertex route sends
  the same body and is unproven live, like the rest of ADR 0072.
