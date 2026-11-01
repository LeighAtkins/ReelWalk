# 0102 — Style references: follow a reel's style

Date: 2026-11-01

## Context

The owner wants ReelWalk to make reels "like this one": they see a reel on Instagram whose style works (its pace, its
hook, how its titles move) and want their own reels to follow it with their own footage and words. ADR 0098 named "a
viral video that looks like this" as an input to Create, but nothing could take a reference in or read it.

The first reference (2026-10-31, @softgirlnocode, "16 ways to hook viewers with a title", 13.8 s) shows what reading
one involves: a talking-head hook with a typewriter caption, a hard cut at 1.87 s to a 4×4 grid of labelled demo tiles
lit one family at a time (dots, line art, drop-ins, pixels), and a dark outro card from 9.73 s. Its sixteen title
effects are the gaps ReelWalk cannot draw yet.

**How a reference gets in.** Instagram serves reels to signed-in viewers only, its terms forbid automated collection,
and its official API reaches only the connected account's own media. A link downloader would break the terms, get
accounts flagged and break whenever Instagram changes its page. The owner downloaded the first reference with
Instagram's own Download and shared the file; that is the flow ReelWalk asks for.

## Decision

A **style reference** is a video the owner downloaded and shared, read once into a **style recipe**.

- **In.** `/references` ("Follow a reel's style" on the home screen) explains the steps: in Instagram, Share, then
  Download (or a screen recording), then upload the saved video here. The upload uses the editor's own uploader; then
  `POST /api/references { mediaAssetId, sourceUrl?, title? }` registers it. A pasted link is kept as a note of where
  the reel came from (http(s) only, 500 characters) and is never fetched.
- **Never footage.** `StyleReference` (new table) points at its `MediaAsset` one to one. `mediaScope()` leaves out any
  asset that is a reference, so no library, picker, command, create run or export can place it in a reel.
- **Read in the worker, once.** Registering starts a durable `reference-read` step (`startWorkerStepRun`, request id
  `reference-read:<id>:v1`), so the same reference never starts two readings and a failed reading can be asked again.
  The step (`apps/worker/src/reference-read.ts`):
  1. **Measures, free.** ffmpeg's scene cuts at 0.3 (`parseSceneCuts`, `shotsFromCuts` merging the two-frame flash a
     cut scores twice), motion per shot from the render checks' 72×128 grey frames (`motionSamples`, `withMotion`), the
     beat grid (`analyseAudio`), and the words (the upload's own transcript, or Whisper now). Only the first 90 s.
  2. **Keyframes, free.** JPEGs 432 px wide at `keyframeTimes`: every 250 ms through the first 3 s (hooks and title
     animations live there), then every 500 ms, plus 150 ms into each shot, thinned evenly to 40. Kept under
     `workspaces/<ws>/references/<id>/`. The measurements and keys are saved as `analysis` with status `reading`
     before anything is paid for, so a failed reading never measures again.
  3. **Reads, one paid request.** `readReference` (web, `lib/reference-read.ts`) sends the keyframes at high detail
     with the measurements and transcript to the configured model through `structuredAnswer` (the workspace's AI
     switch) and the step's provider gate. The model lists every title once: text, when it shows, its box, its effect
     (ReelWalk's own animations, the sixteen named effects, or `other` with a note), its look and colour, and whether it
     is a caption of speech; plus the reel's format and up to five notes. `parseReferenceRead` clamps and cleans the
     answer; `assembleRecipe` joins it to the measurements. Status `ready`, or `failed` with the error.
- **The recipe** (`styleRecipeSchema`, `packages/core/src/style-recipe.ts`): shots with motion; pacing (shot count,
  median and mean shot, cuts per second, first cut); speech (words, words per minute, first word, spoken share, text);
  beat (BPM, share of cuts within 60 ms of a beat); titles; format; notes. `describeRecipe` is its plain summary and
  `recipeGaps` the title effects ReelWalk cannot draw yet.
- **Shown and shared.** `/references` follows each reference until it is read, then shows the summary, a shot strip,
  the titles and the gaps. The connector gets two read-only tools, `list_references` and `get_reference`, so an
  assistant (and next, the create run) can follow a recipe: match its pacing, title timing, placement and hook with the
  owner's own footage and words, and the nearest ReelWalk effect where there is a gap.

## Not in this step

1. **The sixteen effects** (dots, line art, drop-ins, pixels) as native title animations in the renderer, the timeline
   schema, the editor and the connector. The recipe already names them, so a reference's gaps close as they land.
2. **Follow this style on Create**: pick a ready reference with the idea and footage; the create run reads the recipe.
3. **Share to ReelWalk from the phone**: a web app manifest with a share target, so Android's share sheet can send the
   saved video straight here. iOS Safari has no share target, so upload stays the way in there.
4. Deleting a reference (its keyframes go with it) and re-reading one with a newer reader version.
