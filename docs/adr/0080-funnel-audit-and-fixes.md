# 80. Funnel audit and fixes: first-party sign-up tracking, and what a stranger trips over

Date: 2026-10-25

## Context

The owner wants paid ads (Meta first, aimed at real-estate agents and listing
photographers in the US, Australia and the UK), but only once the funnel works.
Before spending, a brand-new visitor was walked through it on production:
landing, plans, sign-up, a first reel from four phone clips, a free export,
the upgrade to Stripe Checkout (backed out before paying), the emails and the
legal pages, on a 412×915 touch phone and at 1440×900, in an isolated browser
context with no session. The findings and screenshots are in
`output/funnel/funnel-audit-2026-10-25.md` (hybrid checkout).

The funnel itself is short and works: sign-up needs no email verification and
reaches the signed-in home in seconds, four clips become a watchable first cut
in about twenty seconds, a free export finishes in about two and a half minutes.
What was missing for ads was measurement: nothing recorded where a sign-up came
from or whether it exported or paid, no UTM or click id (`gclid`, `fbclid`) was
read anywhere, and the page's CSP (`script-src 'self'`) would block any ad
pixel. A few small defects sat on the path as well (below).

## Decision

### First-party funnel events

- `FunnelEvent` (new table): `name`, `userId`, `workspaceId`, optional unique
  `eventKey`, `data` (JSON), `createdAt`. Four names: `signup`, `first_export`,
  `checkout_started`, `subscribed`. No email or name is stored; the foreign
  keys are `ON DELETE SET NULL`, so account deletion leaves anonymous counts.
- `recordFunnelEvent` (`lib/funnel.ts`) never throws into the request it is
  counting. `eventKey` makes once-per-thing events idempotent
  (`signup:<user>`, `first_export:<workspace>`, `subscribed:<subscription>`), so
  Stripe redelivery cannot double count. Each event copies the user's stored
  attribution into its `data`, so a row is self-contained for an export to an ad
  platform later.
- Recorded in: `signUp` (auth-actions), `queueReelExport` (the first REEL job of
  a studio), `startCheckout` after the Checkout Session exists, and the Stripe
  webhook's `checkout.session.completed` (plan, interval, subtotal, total,
  currency; amounts in cents as Stripe sends them).
- `GET /api/admin/funnel?days=30` (admins only, 404 otherwise) returns the
  counts in total and per `utm_source` / `utm_campaign`.

### UTM and click-id capture without cookies

`lib/attribution.ts` reads an allow-list (`utm_source|medium|campaign|content|term`,
`gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `ttclid`; values trimmed,
control characters stripped, 200 characters at most). The landing page, `/pricing`
and their header and plan buttons append what they received to their `/signup`
links; the sign-up page puts it in hidden fields; `signUp` stores it in the new
`User.attribution` column and carries it on its own error redirects. The
parameters live only in the URL the visitor already followed: **no cookie, no
local or session storage, no script**, so nothing here needs a consent banner.

### Small fixes found on the path

- The export page overflowed a 412 px phone for every Free export: the
  "Post straight to Instagram with Agent" button (`white-space: nowrap`) sat in a
  two-column grid whose tracks could not shrink, widening the layout viewport to
  532 px so the video, the text and the Share button were cut off. The grid now
  uses `minmax(0, 1fr)`, buttons may wrap, and the upsell takes the full row.
- The export sheet and the in-progress screen said "1080×1920" to Free users
  whose export is 720×1280; both now avoid naming a size (the result page names
  the real one).
- Account deletion left a studio's thumbnails and its render checks and audio
  sidecars in storage (four thumbnails survived a test account's deletion): it
  now also deletes the keys it can compute beside each object.
- Open Graph and Twitter tags, a `sitemap.xml` (and its line in `robots.txt`),
  `/guide` allowed for indexing, a description that says what the product does.
- Terms and Privacy now say what is true: payments through Stripe, AI
  providers, the single sign-in cookie and no tracking cookies, the attribution
  and funnel events above, how to ask for access or deletion, and contact
  `hello@reelwalking.com` instead of a personal address.

## Consequences

- **A migration is needed and is not applied by `ship.sh`** (additive: one
  nullable column on `User`, one new table). Until it runs on production, sign-up
  would fail on the missing column: apply `20261025020000_funnel_events` before or
  with the deploy.
- No third-party script runs. When the owner wants a Meta Pixel or Conversions
  API, the events here are the source: browser pixel needs a consent banner for
  the UK/EU (and the CSP must allow it); the Conversions API can be fed from
  `FunnelEvent` server-side, but Meta wants the click id (`fbclid`, kept) and
  the `_fbp`/`_fbc` cookies or a hashed email to match, which is the owner's
  decision.
- Attribution is first-touch only if the visitor stays on links we control. A
  visitor who copies the bare address, or comes back another day, is "(none)".
  That is the price of having no cookie.
- Deleting an account anonymises its events rather than deleting them, so
  historical sign-up counts stay accurate; the privacy page says so.

## What was verified

See the PR description for commands and results. Not verified: the new code
against a running database (no local stack was started for this change), the
Meta side, and a real phone's file picker.
