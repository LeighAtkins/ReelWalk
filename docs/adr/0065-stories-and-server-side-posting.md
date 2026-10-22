# 0065 - Stories, and every Instagram post published on the server

Date: 2026-10-22

## Context

@reelwalking's ten reels each stopped at 113–188 views: Instagram's first
seeding batch and nothing after it. The owner wants a Story with every
reel, which the app could not post: the Instagram client only ever created
`media_type: "REELS"` containers. Two reels posted 24 minutes apart on the
night of 2026-10-21 split one seeding batch between them.

The same night a post was lost. "Post to @reelwalking" created the
container on the server, then relied on the export page polling
`continueInstagramPost` every five seconds, which called `media_publish`
when Instagram reported the container `FINISHED`. Closing the tab ended the
polling, and nothing else would ever publish the container. Scheduled posts
never had this problem: ADR 0017's publisher claims and advances
`ScheduledPost` rows on the server, ticked by the web process's loop and by
EventBridge, and keeps a container across a failed publish call so a post
cannot appear twice.

## Decision

**An immediate post is a scheduled post whose time is now.** `startInstagramPost`
writes a `ScheduledPost` row with `publishAt = now`, gives the publisher one
tick so the container is created before answering, and returns the row's id.
`continueInstagramPost` reads the row (and gives the publisher a tick when
the row is due, so an open page sees progress in seconds rather than at the
next minute), and nothing depends on it being called: the loop and
EventBridge carry the post to `PUBLISHED` or `FAILED` on their own. The
export page keeps its `[data-testid=instagram-published]` element with the
permalink and the `.error[role=alert]` on failure, so the owner's posting
scripts are unchanged. Idempotency is the publisher's: a lost answer to
`media_publish` keeps the container, and the next check finds it
`PUBLISHED` without a second call (`story-sequence.test.ts` proves it).

The brief asked for publishing to move into the render worker, reusing the
durable AI jobs of ADR 0049. It is kept in the ADR 0017 publisher on
purpose: workers are Fargate tasks started on demand that exit when idle,
so a worker would have to be started at 09:00 for a few HTTP calls and kept
alive, or restarted, through the minutes Instagram takes to process a
video; ADR 0017 rejected that for the same reason, and its claim-token
state machine already gives the durability and single-publish guarantee the
brief wants. The worker's part is what it is good at: rendering the story cut.

**Stories.** `ScheduledPost.kind` is `REEL` or `STORY`; a story row may name
the reel row it follows (`afterPostId`). The publisher advances both with
one state machine; two gates were added in front of a story's first step:

- *the reel first:* a story with `afterPostId` is not started until that row
  is `PUBLISHED`; it waits (re-checked every 30 s) while the reel is
  scheduled or publishing, and ends `FAILED` if the reel failed or was
  cancelled (`storyGate`). Cancelling a waiting reel cancels its waiting story.
- *the video first:* a post whose render job is still `QUEUED` or `RUNNING`
  waits for it, for an hour after its time at most (`renderGate`).

A story container is `media_type=STORIES` with `video_url` and
`is_ai_generated` and nothing else (`storyContainerParams`): Instagram's
media reference marks `share_to_feed`, `audio_name` and `cover_url` as
Reels-only and says stickers (links, polls, locations) cannot be published
through the API; a video story runs 3–60 s and 100 MB. Publishing is the
same `media_publish`. The Graph request bodies for reels, stories, status
and publish live in `packages/core/src/instagram-publish.ts` and are tested
without a network.

**The story cut.** `planStoryCut` (core, `stories.ts`) derives a timeline from
the export's frozen payload: the opening up to the last cut between 8 and
12 s (the whole reel when it is 12 s or shorter; a cut at 10 s when no shot
ends in the window), titles clipped to it, a facts card placed at the end
left out, then a two-second plate. The plate is a new additive timeline
field, `endCard: { text, durationMs }`, drawn by the shared composition
(`EndCardView`: a near-black card, one line of the Cormorant serif in
ivory, the @reelwalking house style) over the last two seconds; under it
the last kept shot plays again, silent, so every frame has footage and no
new clip kind was needed. Saved reels have no `endCard` and render as
before. The cut is a `RenderJob` of the new kind `STORY` with
`sourceJobId` naming the export and no reel of its own, so a story cut is
never taken for a reel's latest export (the export, share and featured pages
read `reel.renderJobs`). It is queued like an export, rendered by the worker
through the REEL path, and left out of the plan's monthly export count.

**Where it is offered.** On the export page, "Also post a Story" (on by
default) applies to both Post now and Schedule: the cut starts rendering
when the post is made, and the story row follows the reel row. "Post a
Story now" posts the cut, or the whole reel when it is 60 s or shorter, on
its own. On /scheduled a waiting reel has the same tick box (adding renders
the cut and queues the story; removing cancels it), story rows are listed
with their reel's title, and a story waiting for its reel says so.

**Spacing guard.** When scheduling, `spacingWarning` names the nearest post
or story of the account within an hour of the chosen time; the form shows
it once and offers "Schedule anyway", which resends with `confirmSpacing`.
A story following the reel being scheduled is not a neighbour.

**Migration (additive, not applied by ship.sh):** `RenderJobKind.STORY`,
`RenderJob.sourceJobId`, `ScheduledPostKind`, `ScheduledPost.kind`
(default `REEL`), `ScheduledPost.afterPostId`, two indexes.

## Consequences

- No post depends on a browser any more. Post now takes one tick's work
  before answering (the container call, a second or two), then the page is
  free to go.
- A story goes out a few minutes after its reel: its container is created
  only once the reel is `PUBLISHED`, and Instagram then processes it. That
  is the "never before" the owner asked for, at the cost of not pre-warming
  the container.
- A story cut is a second render per post. On the owner's unlimited plan
  that is worker time only; on metered plans it is not counted as an
  export but does take one of the plan's concurrent renders while it runs.
- The plate's words come from the connected account's username at the
  moment the cut is made; a renamed account keeps the old plate on cuts
  already rendered.
- Stories carry no sound, caption or link: the API does not allow them. The
  UI says so next to the tick box.
- `exportsThisMonth` leaves `STORY` jobs out; the account page's export
  count and the concurrency counts still include them.

## What was verified

- `pnpm check` (lint, typecheck of every package, every package's tests)
  passes. New tests: `packages/core/tests/stories.test.ts` (hook choice on
  cuts, mid-shot trim in source time at speed, short reels, titles clipped
  and dropped, facts card and cover handling, limits),
  `packages/core/tests/instagram-publish.test.ts` (reel and story bodies,
  what a story never carries, publish and status), spacing cases in
  `schedule-time.test.ts`, and `packages/db/tests/story-sequence.test.ts`:
  the reel-then-story sequence against an in-memory stand-in for the two
  tables and a pretend Instagram that records every call (create → poll →
  publish → story create → poll → publish, in that order, with the reel's
  publish answer lost once and no second publish call; a story whose reel
  failed, whose cut failed, and a cancelled reel cancelling its story).
- The Postgres-backed claim tests (`scheduled-posts.test.ts`) are skipped
  without `DATABASE_URL`, as before; the claim SQL did not change.
- Not verified: a rendered story cut (no worker stack on this machine), a
  real Graph API call with `media_type=STORIES` (no network, no Meta
  credentials here), and the Playwright suite (`scheduled-posts.spec.ts`
  was made to accept the spacing guard but not run).
