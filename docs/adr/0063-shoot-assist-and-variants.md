# 0063 - Shoot assist and variants

Date: 2026-10-21

## Context

Pro-editing area 5. Two gaps on either side of the edit:

- **Before.** Agents film whatever they think of, in whatever order, and the
  edit has to make up for it: shots too short to use, rooms missed, no
  establishing shot, phone moved too fast. Nothing in the app helped before
  the first upload.
- **After.** A finished reel goes out as one cut. Whether the hero shot, the
  presenter or a title should open it, and whether 15 or 30 s does better,
  is guesswork; Instagram's insights could answer it (ADR 0027 reads them
  live on the Scheduled page) if the same reel went out in several versions
  and the versions were kept together.

## Decision

### Shot list on the phone (`packages/core/src/shoot.ts`)

- An optional first step of a new reel: **Plan my shoot**, a tile next to
  the starter library on the home screen, opening `/new/shoot`. The agent
  picks the property type and the rooms they will film, or pastes the
  listing.
- `apps/web/lib/shoot.ts` (`planShoot`) asks the model through the existing
  provider plumbing (`structuredAnswer`, so Claude or OpenAI, inside the
  provider gate) with a strict JSON schema (`SHOT_LIST_JSON_SCHEMA`: every
  field required, no extra properties, `move` an enum). The answer is
  validated by `shotListSchema` (titles and directions length-limited, holds
  clamped to 1–8 s, at most `MAX_SHOTS` = 12, more are cut to the first
  twelve). It is one request against the plan's monthly AI allowance and is
  recorded as an `AiEdit` with no reel, like Ask.
- Whenever the model cannot be used (not configured, the stand-in, the
  allowance used up, no answer, an answer that does not fit), the agent gets
  `standardShotList`: the rooms in walk order, arrival and the front door
  first (no exterior for an apartment), each with the house way to film it
  ("Walk through the front door slowly, phone at chest height, and hold 3 s
  on the first view inside"; "Phone at counter height, slow pan left across
  the kitchen island"), capped at 12 with the view kept as the ending. It
  is deterministic; rooms are read from the listing (`roomsFromListing`)
  when none were picked. The page says which list it is and why.
- The list is a column of thumb-sized checkboxes, kept in `localStorage` so
  it survives the camera app, a reload or a dropped signal mid-shoot.
- **Matching uploads to shots** (`matchUploadsToShots`): the picked files are
  put in capture order (`File.lastModified`, which phones set to the capture
  time; then the name); the n-th file is the n-th ticked shot (every shot
  when none was ticked); files beyond the list have no room. The reel is
  created and the editor opens exactly as from New reel or Make it for me,
  with the files in that order. Each file's room travels with it
  (`setPendingFiles(id, files, rooms)` → `roomHintFor` in `upload.ts` →
  `confirmUpload`'s new optional `room`, stored on `MediaAsset.room`, an
  existing column), so the clip knows its room through the existing
  `clipFromAsset` and room labels and the autopilot's walk order use it. The
  editor itself is unchanged.

### Variants (`packages/core/src/variants.ts`)

- From one finished reel, **3 hooks × 2 lengths** (15 and 30 s) as sibling
  reels. `buildVariants` is pure and deterministic, and every step is a
  document command through `applyCommand` (ADR 0048), so titles move as they
  do in the editor:
  1. the lead shot is moved first (`moveClip`): **hero** = the studio's
     cover frame, else the exterior, aerial, view or pool, else the first
     shot; **presenter** = the first video whose transcript (ADR 0035) has
     words inside the part the reel plays; **title card** = the reel's own
     opening;
  2. shots beyond what fits at 1.5 s each are dropped (`deleteClip`),
     evenly through the walk and always keeping the last (the ending); a
     dropped shot's own titles (attached by ADR 0048's rule) go with it;
  3. the rest is brought to length with the existing `retimeToLength`
     (W14's `pace` command is not on main; nothing in the pacing internals
     changed). The presenter's line keeps its own length, up to 45% of the
     variant, and is cut between words, not inside one; the rest gets the
     remaining time (`retimeToLength` asked for the rest's share), then the
     line is trimmed back (`trimClip`) and the cuts go back on the beat
     (`snapToBeat`) unless that would cut her mid-word;
  4. the opening is set: the title variant opens on the listing's facts
     card when it has a price or address (placement `start`, or `both` when
     it also closed the reel), else on a serif headline (`variant-title`)
     with the details' price and address, the first headline, or the reel's
     title (never a default "Reel 3"), replacing the old opener; hero and
     presenter variants move a facts card at the start to the end so the
     picture opens the reel. A drawn hook (ADR 0041) and words-behind
     titles were made for the source's first shot and are dropped when that
     shot no longer opens the reel. The hero variant's cover is the hero.
- A variant that cannot be made is skipped with a reason shown to the
  studio: no one speaking (presenter), nothing to put on a title card, a
  30 s version the footage cannot fill (less than 3 s longer than the
  15 s), or a duplicate of another hook.
- Variants refer to the source's media assets and the source's own clip
  ids; no media is copied and no asset rows are created. The source reel is
  not changed.
- `/reels/[id]/variants` (a **Variants** button on the export screen, next
  to Keep editing) makes the set, then shows it as a 2-column grid of
  thumbnails with each one's real length, hook and 15/30 s, export status,
  and **Export all** (queues an export for each variant with none running
  and none newer than its last edit, through the same checks and limits as
  Export: `queueReelExport`, extracted unchanged from `exportReel`). Each
  card opens the variant's editor, or its export screen once exported,
  where it is posted or scheduled like any reel. At most 5 sets per reel.

### Which one wins

- `VariantGroup { workspaceId, sourceReelId?, createdAt }` and
  `ReelVariant { reelId (pk), groupId, hook, lengthS, views?, reach?,
  mediaId?, insightsAt? }`: **additive migration
  `20261021030000_reel_variants`** (two new tables, indexes and foreign
  keys; no existing column touched). A set survives its source reel being
  deleted (`SetNull`); a variant's row goes with its reel.
- The Instagram scaffold already publishes scheduled posts (`ScheduledPost`
  with `mediaId`) and reads insights (`postInsights`, ADR 0027, with the
  Instagram Login connection's insights permission). The variants page finds
  each variant's latest published post through its render job, reads its
  numbers at most every 10 minutes, and **stores** plays (`views`) and
  reach on the variant. `variantWinner` names the variant with the most
  plays (then reach) once two or more have numbers; a tie is no winner.
- When numbers cannot be read the page says why, and that the set is kept
  to compare later: none posted yet; posted but no Instagram Login
  connection; or the connection needs a reconnect for the insights
  permission. Stored numbers are shown when Instagram cannot be asked.

## Consequences

- The shot list costs one AI request when the model is used; the standard
  list costs nothing and is always there.
- Capture-time matching assumes the agent filmed in the list's order and
  picked only the clips they meant to. A clip filmed out of order gets the
  neighbouring shot's room; the room is a hint the studio can change
  (`setClipRoom`), and Ask still names unnamed rooms.
- Each set adds up to six reels to the studio's reel list (named
  "<title> · Hero shot first · 15 s"). Deleting a variant reel removes it
  from its set.
- A 15 s variant of a long reel plays shots of 1.5 s; the variants are a
  starting point for the studio, who can open and change any one.
- Insights are read when the variants page is opened, not on a schedule;
  a nightly snapshot (ADR 0027's follow-up) would give trends.
- **The migration is not applied by ship.sh**; it must be deployed with
  `prisma migrate deploy` before this code runs against production.

## What was verified

- `pnpm check` passes (lint, typecheck of every package, all unit tests:
  core 60 files / 616 tests, web 23, worker 175, render 68, db 7 run and 30
  skipped without a database).
- `tests/shoot.test.ts` (13): the schema accepts and normalises a model
  answer, caps at 12, rejects empty lists, unknown moves, missing fields,
  overlong text and NaN holds; the strict JSON schema requires every field
  and allows no others; the standard list's walk order, numbering, apartment
  case, 12 cap with the view kept, rooms from a listing, determinism;
  matching by capture time, by ticked shots, extra files, ties by name.
- `tests/shoot-plan.test.ts` (4): `planShoot` with the provider mocked asks
  for `shot_list`, records one request, falls back to the standard list on
  a bad answer, no answer, a used-up allowance or the stand-in.
- `tests/variants.test.ts` (17): hero, presenter and title choices; six
  variants from a 12-shot reel, all schema-valid; determinism; variants use
  only the source's assets and clip ids and leave the source untouched;
  each opens on its hook; even dropping keeps the ending and drops the
  dropped shots' titles; every variant within -15%/+10% of 15 or 30 s with
  no shot under 1 s; the presenter's line is finished or cut between words;
  short reels have no 30 s version and say why; skipped hooks give reasons;
  facts-card placement per hook; the winner rule.
- `packages/db/tests/variants.test.ts`: the migration is additive (only
  creates the two tables, their indexes and keys; no DROP, RENAME or ALTER
  COLUMN). A Postgres test of the grouping through Prisma (create a set,
  source deleted keeps the set, a variant reel deleted removes its row) is
  written but skipped here: no database was reachable (Docker Desktop not
  running).
- Every migration in `packages/db/prisma/migrations`, this one last, applied
  in order to an in-memory Postgres (PGlite 0.3, outside the repo); then
  rows were inserted and deleted by hand: deleting the source reel left the
  set with `sourceReelId` null, deleting a variant reel removed its
  `ReelVariant`, deleting the workspace removed both tables' rows.
- `next build` of `apps/web` succeeds; `/new/shoot` and
  `/reels/[id]/variants` are built as dynamic routes.
- **Not verified:** the pages in a browser, the shot list against a live
  model, Export all against a running worker, and insights from a real
  posted variant.
