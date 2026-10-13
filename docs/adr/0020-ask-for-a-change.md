# ADR 0020: Asking for a change in words

Status: accepted (2026-10-13)

## Context

The editor can do everything a listing reel needs, but a photographer who
has just watched a finished export mostly wants one or two things different:
"the kitchen shot is too short", "that music is wrong for this house", "put
the price at the end". Opening the timeline, finding the clip and dragging a
handle on a phone is where people give up. The request is easy to say and
tedious to do.

Language models are now good enough, and cheap enough, to turn such a
sentence into edits, provided the edits are drawn from a fixed vocabulary
and checked before they touch anything.

## Decision

**A request is a plan of ordinary edits.** `packages/core/src/ai-edit.ts`
defines a flat list of operations that mirror the editor's own sheets (trim,
speed, look, motion, transition, fit, volume, move, remove, duplicate, text
add/edit/remove, music, music volume, snap to beat, details, room labels),
each referring to clips and texts by their number in a description of the
reel. `describeReel` writes that description; `applyAiEditPlan` applies a
plan with the same pure functions the editor calls (`trimClip`,
`updateClip`, `setMusic`, …), skipping anything it cannot do and saying
why. The output is a normal `Timeline`, so the editor applies it as one
undoable step and nothing new is rendered or stored.

**The model only plans.** `apps/web/lib/openai.ts` calls the OpenAI
Responses API with strict structured output against the plan's JSON schema;
the answer is re-checked with the zod schema before it is applied. The
fixed instructions go first so the provider caches them. The default model
is `gpt-6.1-sol` (OPENAI_MODEL switches it; `gpt-6-luna` is the cheap one).
No key: the feature is hidden, unless DEV_FAKE_AI=true, in which case a few
rules stand in so local stacks and the e2e suite can exercise the path.

**Two doors, one function.** `askForChange` in `apps/web/lib/ai-edit.ts`
does the work. The editor's "Ask" sheet posts to
`/api/reels/[id]/ai-edit` with the timeline it is showing and applies the
answer itself, so an open editor never conflicts with its own autosave. The
export screen's "Ask for a change" card calls the `askAndContinue` action,
which saves the result against the reel's revision and either starts a new
export or opens the editor on it.

**Metered per plan.** `aiEditsPerMonth` in `PLANS` (Free 5, Agent 60,
Studio 300). Every request is an `AiEdit` row with the request, the
model's note and plan, what was applied and skipped, and the token counts;
the monthly count comes from that table. A re-export after a change is an
ordinary export and counts as one.

## What it costs

A request sends about 1,200 tokens of instructions (cached after the first
call) plus 400–900 tokens describing the reel, and gets back 150–500 tokens
of plan. At gpt-6.1-sol's prices ($2 / $10 per million, cached input $0.10)
that is roughly $0.004–0.008 a request, or 25–50 cents a month for an Agent
studio that uses all 60; on gpt-6-luna it is under a cent a month. The
render that follows is the real cost (minutes of ECS time), which is why
re-exports stay on the export allowance.

## Consequences

- The vocabulary is the ceiling: the model cannot add media it has not been
  given, cut a video in the middle by content, or do anything the editor
  cannot. Requests outside it get a one-sentence note instead of a guess.
- Mood words for music depend on `SONG_MOODS`, which covers the bundled
  songs by title; uploaded songs are described by tempo only.
- The `AiEdit` log is the first place to look when an answer is poor:
  request, plan and what was skipped are all there.
- Prompt and vocabulary live in `@reelwalk/core`, so changing what the
  model may do is a code change with tests, not a prompt edit in
  production.
