# ADR 0026: Keyword comment replies

Status: accepted (2026-10-15)

## Context

@reelwalking's first posts were pretty and reached almost nobody: 0
followers, 2 likes. The real-estate marketing accounts that grow (Connor
Newell's "Comment VIRAL for the full guide" carousel: 1,104 likes, 758
comments) ask for a one-word comment and answer it with a DM. Comments are
the strongest signal a post can get, and each one is a lead in the inbox.
Agents want the same thing for their listings ("comment PRICE and I'll send
the details"). Tools like ManyChat sell it; its free tier now stops at 25
contacts.

## Decision

- **Keywords per studio** (`CommentTrigger`): one word, stored upper case,
  matched as a whole word in any case ("reel!", "REEL please", not "reels").
  Each has the DM to send and an optional public reply under the comment.
- **One DM per comment** (`CommentReply`, unique `commentId`): inserting the
  row is the claim, so two instances never both answer. A transient Graph
  error deletes the claim for the next pass; anything else is kept as FAILED
  with Instagram's words. Instagram itself allows one private reply per
  comment, within 7 days.
- **Polling, not webhooks.** The scheduled post tick (EventBridge, every
  minute, ADR 0017) also runs a pass, at most every two minutes per process:
  one request reads the comments on the 10 latest posts. Webhooks need the
  Meta app live and a public verify endpoint; polling works in development
  mode and costs about 30 calls an hour per studio.
- **Instagram's own login for this part.** Private replies go through the
  Instagram API with Instagram Login (`graph.instagram.com/me/messages`,
  scopes `instagram_business_basic`, `instagram_business_manage_comments`,
  `instagram_business_manage_messages`). Meta's docs require Advanced Access
  there only for professional accounts the app does not own or manage, while
  the Facebook Login route (`/{page-id}/messages`) requires Advanced Access
  outright. Publishing stays on Facebook Login; the second token sits on the
  same `SocialAccount` (`messagingToken`), only for the account the studio
  already posts to, and is refreshed when it has under 10 days left.
- **Config:** `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` (Meta app → Instagram
  → API setup with Instagram login), redirect URI
  `https://reelwalking.com/api/instagram/messaging/callback`. Without them the
  Account section does not appear.
- **The guide** at `/guide` (public) is what @reelwalking sends for "GUIDE":
  the first second, five phone shots, cutting, readable text, captions that
  get comments, hooks, and only asks proven in ADR 0025.

## Consequences

- Other studios' accounts need Meta App Review (Advanced Access) for these
  scopes before the feature can be offered beyond our own account and
  testers; until then it is gated by the Agent plan and the config.
- The privacy policy now covers the second token and the comment data kept.
- Comments older than 7 days or past the 50 Instagram returns per post are never
  answered; a keyword added later answers recent comments that already
  name it (they are inside the window and unanswered), which is usually what
  is wanted.

## Addendum (2026-10-15, first live test)

While the Meta app is unpublished, the Instagram Login token reads only
comments by people with a role on the app: a stranger's "GUIDE" showed in
`comments_count` but not in the comments edge. The publishing (Facebook
Login) token returns it, without the username. Comments are now read with
the publishing token and sent with the Instagram Login token, which did
deliver the private reply to the non-tester who commented.
