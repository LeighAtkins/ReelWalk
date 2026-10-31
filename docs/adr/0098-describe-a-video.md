# 0098 — Describe a video

Date: 2026-10-31

## Context

The owner wants to type an idea on reelwalking.com ("a viral video that looks like this", a few photos of a house, or
nothing but a concept) and get short, punchy reels ready to schedule. They also want ReelWalk's own Instagram account
to post a lot more, made the same way.

Most of the parts were already there:
- Make it for me (ADR 0021/0064) cuts uploaded footage.
- Stock search and import (ADR 0013/0070) and the starter library supply footage.
- Notes on a version (ADR 0095) run Opus over the connector's tools (ADR 0077) on the server, as the owner. They cannot
  spend AI video credits, export or post, and the app exports the version they save.
- The export screen posts and schedules.

What was missing was a way in that starts from words, with footage optional.

## Decision

A Create page at `/create` (the "Describe a video" tile on the home screen):

- **Input:** an idea (10–1,000 characters), optional photos and videos (uploaded with the editor's own uploader),
  1–3 options, and captions on or off.
- **Each option is a new reel** with the uploads already on it, under fresh clip ids. The options take different angles
  (`CREATE_ANGLES`): Fast hook, Mini story, Three reasons. So the owner picks between takes, not between re-cuts.
- **Each reel gets a create run.** This is a note (ADR 0095) whose words are the idea and whose plan says
  `mode: "create"`. It is reserved like any AI request (one of the month's requests per option), runs in the background,
  and on a save the app exports v1. So the option opens on the export screen with the idea as its first note and v1 as
  its version. Posting, scheduling and further notes work there unchanged.
- **The run has more reach than a note, and no more spend.**
  - Its tools are `get_reel`, `get_brand_kit`, `list_media`, `search_stock`, `add_media` and `apply_commands`.
  - `add_media` is bound to its reel and to its `stock` and `library` modes.
  - It has 24 tool calls (a note has 12).
  - It still never has `generate_ai_shot`, `export_reel` or the `ai:generate`/`exports` scopes.
- **The run's last line is `Caption: …`.** The caption goes on the reel unless the owner has already written one. The
  owner sees the reply without that line.
- **Starting is atomic per option.** An option that cannot start (the allowance runs out part-way) deletes its empty
  reel, unless a note was started on it; the page says how many were skipped.
- **One request, one set of options, however often it is sent.** The page sends a `requestId` (a UUID). It keeps
  the same id when Try again sends the same words and settings, and makes a new one when anything changes.
  - **The record.** The server keeps a `WorkflowRun` of kind `create`, unique per workspace and request id, holding the
    hash of the payload: the idea, the media, the options, captions and voice. No migration is needed.
  - **Derived ids.** Each option's reel id and its note's request id are derived from the workspace, the request id
    and the option's index, never drawn at random. `startNote` already answers a repeated note request id with the
    note it made, without reserving the month's allowance again.
  - **Retries.** A retry after a lost answer, or two tabs sending at once, gets the same reels and notes and spends
    nothing more. A request stopped part-way resumes: the started options are kept and the rest start. That covers
    the allowance running out and a crash between making an option's reel and starting its note.
  - **Mismatch.** The same id with a different payload is refused (409, `request_mismatch`), and nothing is made.
- **The page follows each option** through `GET /api/reels/<id>/notes` until v1 is rendered, then shows its poster
  and "Watch, change and post".

## Not in this step

These were chosen with the owner and come next, in this order:

1. **Voices and a voiceover.** Today one voice is configured per deployment (`PRESENTER_VOICE`, used only for lip-synced
   presenter takes).
   - Read `Presenter.voice` and offer a voice picker.
   - Add a voiceover over b-roll: TTS → transcribe → `syncTextToSpeech` captions.
2. **AI shots to fill gaps.** Stock comes first. When it cannot cover a shot, quote Veo drafts and generate them only
   after the owner confirms the credits. The run never spends on its own.
3. **Fictional AI presenters.** A small gallery of AI-made presenters that do not resemble real people, labelled as AI.
   This changes ADR 0056's own-photos-only rule, so it gets its own ADR.
4. **Batch scheduling.** Schedule a set of options across days with the spacing warning (ADR 0065).
5. **A reference reel.** Instagram does not hand out another account's video, so this means uploading the reel (or
   describing it) and turning what is measured into a recipe.
6. **Tutorial reels for ReelWalk's own account.** A composition that pairs screen recordings with a voiceover and step
   captions, made from this page.

## Consequences

- An option costs one AI request from the month's allowance, plus Opus tokens for up to 24 tool calls (not measured
  yet). Stock search and import keep the connector's per-person hourly limits (30 searches, 12 imports): three options
  at once fit; many more in an hour do not.
- With no stock key (`PIXABAY_API_KEY`) and no uploads, a run has only the starter library.
- The stand-in model (DEV_FAKE_AI) titles uploaded footage with the idea and finds no footage of its own, so without
  uploads it answers that it made nothing.

## Verified

- Request ids (`lib/create-reels.db.test.ts`, real Postgres, the real allowance and note reservation):
  - a lost answer and a retry;
  - two concurrent sends;
  - an allowance stop, then a resume;
  - a crash between reel and note;
  - a different payload under the same id;
  - the same id in two workspaces.
- With fresh random ids per send (the earlier code) four of these fail.


- Unit tests (`lib/create-reels.test.ts`):
  - what a create run can reach, and that note mode is unchanged;
  - the caption split;
  - the brief and title;
  - `startCreate`: uploads on every option under fresh clip ids, a refusal part-way removing its reel, bad media
    refused.
- Database tests (`lib/reel-thread.db.test.ts`, real Postgres): a create run gets its own tools and brief, is recorded
  as `mode: "create"`, exports v1, puts its caption on the reel, and leaves an owner's caption alone.
- In a browser against the dev server and the stand-in model: sign-in, the form, three options started and followed to
  their outcome, and the home tile.
