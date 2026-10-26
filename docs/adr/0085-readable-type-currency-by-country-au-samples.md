# 0085 - Readable type, prices by country, Australian samples

Date: 2026-10-26

## Context

The owner, after ADR 0081 put every visitor on Australian dollars: "Update the videos and images on the
onboarding page. Also it should only give aud pricing in Australia. Also I think the current font is
unreadable. We want people to read."

- **Type.** The display face was Bodoni Moda: high-contrast hairlines that vanish on a phone held at arm's
  length, on black. Small print on the public pages was 12.5–14 px (the price small print 12.5 px, the
  plan features and the "per month" lines 13–14 px, the top bar 14 px).
- **Currency.** Since ADR 0081 everyone saw A$ with GST, including visitors outside Australia, for whom
  A$ and "GST included" mean nothing. The original US$ prices still exist in Stripe (Agent US$29 / US$290,
  Studio US$79 / US$790, lookup keys `agent_monthly`, `agent_yearly`, `studio_monthly`, `studio_yearly`, on the
  same two products as the A$ prices, tax behaviour unspecified so the account default, exclusive, applies).
  The FOUNDING50 coupon (50% for 3 months) applies to the two products, so it works in either currency.
- **Samples.** The landing page's three sample reels were US listings, and so were the three starter reels
  a new studio gets (Lakeway TX, Seattle, the Outer Banks, in "$").

## Decision

### 1. Readable type

- `--display` is **Playfair Display** (OFL 1.1, `@fontsource-variable/playfair-display` 5.3.0, already the
  renderer's serif since ADR 0083) at weight 500–600. Bodoni's optical-size settings go with it. Display
  headings are never below 22 px (the account cards' and the Judge view's h2 move from 17 px to 22 px; the
  first-export message from 19 px to 22 px).
- Body stays Archivo at 16 px, line-height 1.5. On the landing and pricing pages nothing is below 15 px, and
  only small print (`.fine`, the sample caption, "a month, billed monthly", the price small print) is at
  15 px; the top bar, the interval switch, plan descriptions and features, the footer are 16 px; feature
  lists breathe at 1.45.
- Sign-up, sign-in and account (`.auth`, and `.readable` on the account and signed-in pricing pages): labels
  16 px, `.small` 15 px, usage labels 15 px, paragraphs 1.5. The editor keeps its denser layout; its `.small`
  goes from 13 to 14 px and the home page's welcome and empty-state text to 16 px.
- Contrast is measured, not eyeballed: `apps/web/lib/readability.test.ts` computes WCAG contrast from the
  tokens in `globals.css` (ivory on noir 16.99:1, stone on noir 7.59:1, ivory on soot 15.80:1, stone on soot
  7.05:1, noir on ivory buttons 16.99:1; all above 4.5:1, so the colours stay) and reads the stylesheets for
  the size, weight and line-height rules above.
- A missing `}` after `.hook-drawn > summary` (since #214, ADR 0068) had nested every later rule in
  `globals.css` under that selector: the render checks, the Judge view and the first-export message were
  unstyled in production. The brace is closed and the readability test fails if the stylesheet's blocks do
  not balance.

### 2. A$ in Australia, US$ everywhere else

`apps/web/lib/currency.ts` resolves a currency from evidence, strongest first:

1. `rw_currency` cookie: the visitor's own pick on the pricing toggle.
2. A CDN country header (`CF-IPCountry`, `X-Vercel-IP-Country`, `CloudFront-Viewer-Country`,
   `X-Country-Code`). App Runner behind envoy sets none of them today; they cost nothing to read if a CDN
   is put in front later. Cloudflare's `XX` and `T1` are ignored.
3. `rw_country` cookie, written by `COUNTRY_SNIPPET` in the browser: `AU` when the time zone is
   `Australia/*` or any of `navigator.languages` ends in `-AU`, otherwise `ZZ`. A year, the whole site.
4. Nothing: US$, `source: "default"`.

`AU` gives A$; every other country gives US$. Pages are server-rendered in the resolved currency. To
avoid a flash on a first visit with no evidence, prices are written in **both** currencies
(`<InCurrency aud=… usd=…/>`) inside a `CurrencyScope` whose `data-currency` attribute a CSS rule uses to
show one; the scope inlines the snippet as its first child, so when the server had no evidence it places
the visitor from the time zone and corrects `data-currency` before anything below it paints. The root
layout inlines the same snippet so the cookie exists for every later request (account, checkout). The
snippet is a string, so the test runs exactly what ships.

The pricing section has a quiet "Prices in AUD · USD" toggle (`components/currency-toggle.tsx`): it writes
`rw_currency` (a year) and flips the scope's attribute; the next request, and checkout, use the pick.

Prices: `PlanDef` gains `priceUsd` / `priceUsdYearly` (29 / 290, 79 / 790); `planPrice(plan, interval,
currency)`, `yearlyPerMonth(plan, currency)`, `formatCharge(amount, currency)` ("A$39", "US$24.17"),
`priceSmallPrint(currency)` ("Prices in US dollars, plus applicable tax.") and `taxNote(currency)` ("GST
included" / "plus tax") live in `packages/core/src/plans.ts`; the AI top-up is `aiTopUp(currency)`: 10
credits for A$19 or US$12. The founding line names the discounted Agent price in the shown currency.

Stripe: `STRIPE_PRICE_{AGENT,OFFICE}_{MONTHLY,YEARLY}_USD` and `STRIPE_PRICE_AI_TOP_UP_USD` sit beside the
A$ ids (`.env.example`, `docker-compose.yml`, Terraform `stripe_price_*_usd`). `priceForPlan(plan, interval,
currency)` reads them; `startCheckout` and `buyAiCredits` charge the resolved currency. US$ is offered only
once both US$ monthly prices are set (`isCurrencyAvailable`); until then, with billing on, everyone is shown
and charged A$ (`chargeableCurrency`), so a page never shows a price checkout cannot charge. The top-up
button is hidden for a US$ visitor until `STRIPE_PRICE_AI_TOP_UP_USD` is set. `planForPrice` matches the
US$ env ids too, and the original US$ prices' lookup keys. The top-up webhook takes the session's currency,
requires the line to be that currency's configured price at that currency's amount (A$19 or US$12, the
total either equal to it or it plus the tax Stripe adds), and refuses anything else.

Tax: the A$ prices are GST-inclusive (ADR 0081). The US$ plan prices have tax behaviour "unspecified", which
Stripe resolves with the account's default, **exclusive** (read from the live account's tax settings), so
"plus applicable tax" is what Checkout does; a tax behaviour cannot be set per session for an existing
price. Nothing in Stripe was created or changed.

### 3. Australian samples

<!-- SAMPLES -->

## Consequences

- **No migration.**
- **Set at deploy** (the orchestrator): `stripe_price_agent_monthly_usd = "price_1UPiyz96AWCJOOvnmGnYqxjz"`,
  `stripe_price_agent_yearly_usd = "price_1UPiz096AWCJOOvnLg0CGJ7q"`, `stripe_price_office_monthly_usd =
  "price_1UPiz196AWCJOOvnaESWzSoe"`, `stripe_price_office_yearly_usd = "price_1UPiz296AWCJOOvn3GNpfvt5"`,
  `stripe_price_ai_top_up_usd` = the US$12 price. Without the four plan ids the site behaves as before (A$
  for all).
- A visitor can pick either currency; both are real, correct prices, so nothing here is a trust boundary.
  A subscriber's account page shows prices in the visitor's currency, not necessarily the one their
  subscription was bought in (Stripe's portal shows the real one).
- The checkout funnel event carries `currency`.
- The Open Graph image (`e2e/scripts/build-og-image.mjs`, ADR 0081) still draws its wordmark in Bodoni; it
  is a built PNG and is left as is.
- Visitors in New Zealand or Malaysia see US$; an Australian on a US-English phone abroad sees US$ until they
  switch (the toggle is on the pricing page).

## What was verified

See the PR description for commands and results.
