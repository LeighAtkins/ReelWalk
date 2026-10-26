# 81. Australia first: A$ prices with GST, en-AU, a quiet export sheet, plan intent, and a link preview

Date: 2026-10-25

## Context

The owner is Australian and the first paid ads (Meta) will target Australian
real-estate agents. The funnel audit (ADR 0080) found a working path, but for
this audience the product read as American: prices in US dollars with "plus
tax", square feet, US dates, "open house", US sample addresses, and a link
preview with no image. It also found two things a stranger trips over on the
way to a first export and a first payment:

- The first export sheet says "2 things to fix" about the room labels and
  captions **the app itself placed**, and the button changes to "Export anyway".
  Nothing the person did produced those warnings.
- "Start free, then Agent" was the only expression of intent and nothing kept
  it: after the first export the product forgot which plan the visitor wanted.

## Decision

### 1. The export sheet only warns about text a person placed

- Room labels sat on the line itself: the first version put their centre at
  y 0.74, and Instagram's caption zone starts at y 0.74 (the bottom 500 px of
  1920), so every label failed `isInSafeArea` and the export sheet told the
  person about "text where Instagram's buttons or caption may cover it". The
  placement is fixed, not the warning: `ROOM_LABEL_AT` is y 0.68, which keeps the
  whole box above the zone (a test measures it with the critic's own geometry).
- `TextOverlay.byApp` (optional, additive, `true` only): set on the texts the app
  places itself (the room labels, the opening line of a quick cut and of the
  venue and tour drafts). `updateText` drops it when a title's x or y changes, so
  moving a title makes it the person's. `placedByApp(text)` is also true for a
  room label saved before the flag existed that still sits where the first version
  drew it (y 0.74), so existing reels stop warning too. `instagramIssues` skips the
  "unsafe" check for such text, and so does the critic's safe-zone check (it
  already left `room-` labels to the editor); a title a person types, or moves,
  is still checked.
- The export button reads **Export** whether or not the critic found something
  (it was "Export anyway" whenever there was a finding). Real findings are
  listed under a quiet "Worth a look before you export" line instead of a
  "N things to fix" title; the sheet title stays "Export for Instagram" unless the
  reel cannot be exported.

### 2. One place for the prices, in Australian dollars

`packages/core/src/plans.ts` holds `priceAud` and `priceAudYearly`, A$39 / A$390
(Agent) and A$99 / A$990 (Studio), GST included. `CURRENCY`, `PRICE_SMALL_PRINT`
("Prices in Australian dollars. GST included where it applies.") and `formatAud`
sit beside them; every page that shows a price reads them (landing, `/pricing`,
the account page, the metadata). The AI top-up is `AI_TOP_UP`: 10 credits for
A$19 (`priceCents: 1900, currency: "aud"`), and the webhook accepts only that
currency and amount, with the total either equal to the price (a GST-inclusive
Stripe price shows the tax inside it) or the price plus the tax Stripe adds.
No Stripe object is created by the code; the live AUD prices are made in the
Dashboard (they carry the lookup keys below).

### 3. GST through Stripe Tax

Both Checkout sessions (the plans and the AI top-up) set `automatic_tax:
{ enabled: true }` and keep `billing_address_collection: "auto"` and
`customer_update` address `"auto"`, so Stripe can work out the tax from the
billing address. Until a registration exists in the Stripe Dashboard no tax is
collected, so this is safe to ship before the registration.

### 4. Old USD subscriptions keep their plan

The env price ids now name the AUD prices, so a subscription bought on a USD
price no longer matches them. `planForPrice` takes the price object (a
subscription item carries it) and matches, in order: the price id against the
env ids, the price's lookup key (`agent_monthly_aud`, `agent_yearly_aud`,
`office_monthly_aud`, `office_yearly_aud`), then the price's product against the
optional `STRIPE_PRODUCT_AGENT` / `STRIPE_PRODUCT_OFFICE`. An invoice line only
names its price id and product, so `invoiceLinePlan` reads the lookup key off the
subscription's own item with the same price id. The two env vars are documented
in `.env.example`, `docker-compose.yml` and the Terraform variables.

### 5. Australian locale

- Area is **free text** (`ListingDetails.area` is a string the agent types), so
  there is nothing stored to convert: a typed "2,400 sq ft" stays as typed (user
  content is left alone). The helper that adds units to a bare number now adds
  `m²`; the placeholders, the autopilot "Add $ and m² for me" box and the sample
  hook say square metres.
- Dates and numbers shown to people use `en-AU` ("4 Oct, 07:08 UTC"). The
  schedule-time maths (`zonedLocalToUtc` and friends) are untouched: they use
  `Intl` only to read time-zone fields and never display anything.
- Prices of listings stay "$" (in Australia that is already the local dollar);
  what *we* charge is always written A$.
- Copy: Australian spelling, "open home" for the open-house style and its hook,
  "kerb", "suburb"; the autopilot's request, the sticker words ("open home",
  "auction", "under offer") and the caption prompt know the same terms; the landing page's drawn screens show an Australian listing
  (a fictional Bronte NSW address, 270 m², "Open home Saturday 11 to 11:30").
  realestate.com.au and Domain are not named; a user's reel is theirs to put on any
  listing.

### 6. Plan intent: sign up first, offer the plan after the first export

"Start free, then Agent" (and Studio) links to `/signup`, never to checkout. The
link carries `intent_plan` and `intent_interval`, which ride the existing
attribution parameters (ADR 0080): they are validated to a paid plan and a real
interval, stored with the user in `User.attribution`, and copied onto the
funnel events, with no new column and no cookie. One link per interval, shown by
the same CSS switch as the prices.

After the first **successful** export of a Free studio the export page shows one
card: "Want this every week? Agent plan: 40 exports a month, no watermark, AI
polish." (the plan the visitor picked, else Agent), the price with "GST included",
a checkout button and "Not now". It is shown once per studio: a funnel event
`upgrade_prompt` with the unique key `upgrade_prompt:<workspace>` is written when it
is first shown, so a reload, a second export or a second device does not bring it
back. The checkout button records `from: "first-export"` on `checkout_started`.
It is hidden when billing is off, on a paid plan and on a comped plan.

### 7. A link preview

`apps/web/public/og/reelwalk-1200x630.png`, built by
`e2e/scripts/build-og-image.mjs` (Playwright's Chromium, the app's own Bodoni
Moda and Archivo, a sample reel's poster frame from the CDN the landing page
plays): a phone showing a real sample-reel frame beside "Your listing, as a reel,
in a minute." The sample posters carry US listing details, so the script redraws
the frame's details card with an Australian listing in the same place and size
(`--keep-card` leaves a real Australian export untouched). The image is named in
the root layout's and `/pricing`'s `openGraph` and `twitter` tags (twitter card
`summary_large_image`), `/og/` is public in the proxy and allowed in `robots.txt`.

### 8. The founding offer

A quiet line in the house serif under the paid plans on the pricing page:
"Founding agents: half price for your first 3 months with code FOUNDING50."
Checkout already has `allow_promotion_codes`. The code itself is a Stripe
promotion code the owner made; nothing here creates it.

## Consequences

- **No migration.** `byApp` lives in the timeline JSON, the plan intent in the
  existing `User.attribution` JSON, the "shown once" marker in `FunnelEvent`.
- **Set `STRIPE_PRICE_*` to the AUD price ids and `STRIPE_PRODUCT_AGENT` /
  `STRIPE_PRODUCT_OFFICE` to the two product ids at deploy.** Without the product
  ids, an old USD subscription whose price carries no lookup key resolves to Free
  on its next webhook (it keeps working until then). The AI top-up price id
  (`STRIPE_PRICE_AI_TOP_UP`) must be the A$19 price; a USD top-up session still in
  flight at the switch is refused as "Unexpected AI top-up purchase" and needs a
  manual grant.
- The Stripe prices should be tax-inclusive ("GST included"); the webhook
  accepts either behaviour for the top-up.
- Reels saved with room labels at y 0.74 keep their labels where they are (and no
  longer warn); labels are redrawn at y 0.68 the next time the cut changes or
  room labels are switched on.
- `planForPrice` now has a looser match than "the env ids": a price whose lookup
  key or product says Agent or Studio is that plan. Both come from Stripe-signed
  webhook payloads and server-side retrieves, never from a request.
- A sample reel's poster is a US listing; the landing page's sample videos still
  show their US details. Replacing them with Australian exports is the owner's
  call and a content change only.

## What was verified

See the PR description for the commands and results. Not verified: the new code
against a live Stripe account (no Stripe objects were created here), the Open
Graph image through Meta's and X's link debuggers (needs the deployed URL), and
the Stripe Tax calculation (no registration exists yet).
