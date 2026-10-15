# ADR 0027: Post insights on the Scheduled page

Status: accepted (2026-10-15)

## Context

The first @reelwalking post did badly and we could not say why: the
publishing connection (Facebook Login) has no insights permission, so views,
reach and watch time were only visible in the Instagram app. Judging hooks
(ADR 0026's growth plan) needs those numbers next to each post.

## Decision

- The Instagram Login connection from ADR 0026 also asks for
  `instagram_business_manage_insights`. Existing connections get a
  **Reconnect Instagram** button on Account; the Scheduled page says when a
  reconnect is needed (Graph error 10).
- Each posted reel on the Scheduled page shows one line: views, reached,
  average watch time, then likes, comments, saves and shares when non-zero
  (`insightsLine` in core). Read live from `/{media-id}/insights` on page
  load, one request per post (at most 30); nothing is stored.

## Consequences

- No history: the numbers are what Instagram says now. A nightly snapshot
  table is the next step if we want trends.
- Other studios get this with the same Meta App Review as ADR 0026.
