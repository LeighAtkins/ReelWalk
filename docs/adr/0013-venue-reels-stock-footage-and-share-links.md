# ADR 0013: Venue reels, stock footage and share links

Status: accepted (2026-10-07)

## Context

The editor and the tour auto-build were built for listings. The same
machinery (a timeline, vibes, beat snapping, the details card) fits any
small business that wants a reel every week, and restaurants are the
clearest case: a menu is already a shot list. Two things stood in the way:
most venues have no footage, and sharing from the app only worked where the
browser could attach a file to the share sheet (HTTPS).

## Decision

**Venue reels** (`packages/core/src/venue.ts`). A `VenueVibe` is a complete
treatment, like a tour vibe: song, look, cut length, hook, label style, call
to action, caption and hashtags. `buildVenueReel()` turns the user's clips,
dishes and prices into a timeline: hook first, a dish label per clip in tap
order, cuts snapped to the song's beat, clip audio ducked under the music,
and the existing details card closing with the price, address and handle.
The builder lives at `/new/venue` and the result is an ordinary reel.

**Stock footage** comes from Pexels, which is free and credits the creator.
Search runs server-side with `PEXELS_API_KEY`; importing copies the MP4 and
poster into the workspace's own upload prefix and records the source URL,
licence and credit on the `MediaAsset`. The credit joins the caption. Without
a key the tab explains how to get one and the rest of the builder works.

**Share links.** A reel can get a random `shareToken`; `/r/<token>` is the
one public page in the app: the latest export, the caption with a copy
button, a Save button and a step into Instagram. No sign-in, Open Graph
video tags for messengers, `noindex`. Turning the link off deletes the token
and every copy of the link with it. The share sheet still comes first where
it works; the link is the path that works everywhere.

## Consequences

- Restaurant and café reels reuse the render composition unchanged: the
  details card shows "from $12" where a listing shows the price.
- Stock clips are stored per workspace, so storage grows with imports; the
  2 GB upload cap applies.
- A share link exposes the export to anyone holding it. Links are long and
  random and can be revoked, which is the same trade every "anyone with the
  link" feature makes.
- Direct publishing through the Instagram Graph API is the next step once a
  Meta app exists; the `SocialAccount` table is in place for it.
