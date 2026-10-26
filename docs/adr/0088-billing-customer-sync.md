# 0088 - Billing follows the customer, not the event

Date: 2026-10-26

## Context

Billing works in production and must keep working. Three gaps, from a review against the owner's reference
(t3dotgg/stripe-recommendations):

- **Out-of-order events.** Every subscription webhook re-read *one* subscription (the event's) and wrote what
  it meant onto the workspace. Stripe does not promise delivery order. A customer who cancels and resubscribes
  can receive `customer.subscription.deleted` for the old subscription after the new one is active; the old
  code then wrote Free over a paying customer until the next event for the new subscription.
- **"Reload if it has not."** After Checkout the account page relied on the webhook having landed already.
  It usually had, but the page said so in its copy, and a slow webhook showed the Free plan to someone who had
  just paid. The same for AI credit top-ups.
- **The failed-payment email** printed `$39.00` with no currency, for A$ and US$ customers alike (ADR 0085).

Also, the billing env (keys, eight plan price ids, top-up ids, product ids, landing samples) was read through
scattered `process.env` reads, each repeating Terraform's `"unset"` rule.

## Decision

### 1. One customer-level sync

`syncWorkspaceBilling(customerId, workspaceHint?)` (`apps/web/lib/billing-sync.ts`) lists all of the
customer's subscriptions (`status: "all"`, auto-paginated, newest first) and picks the one that governs access
(`governingSubscription`): one selling a known plan in good standing (active, trialing, past_due) beats any
in good standing, which beats anything else; the newest wins among equals. It writes `plan`,
`stripeSubscriptionId`, `planRenewsAt` and `stripeCustomerId` with exactly the old meanings: Free clears the
subscription id and renewal date, the customer id stays for the portal, and the comped plan
(`compedPlan`/`compedUntil`) is never touched. The workspace is found by customer (or any of its subscription
ids), then by a subscription's `metadata.workspaceId` or the checkout's `client_reference_id`, as before.

Every subscription-affecting webhook branch calls it: `checkout.session.completed` (subscription mode),
`customer.subscription.created/updated/deleted`, and `invoice.paid`. Unchanged: the funnel "subscribed" event
(still keyed by the session's subscription), `applyAiTopUp`, `notifyPaymentFailed`, and `applyAiInvoice`,
which still receives the subscription the invoice billed (its existing guard skips an invoice from a
subscription that no longer governs). The branch also accepts `customer.subscription.paused`, `resumed`,
`pending_update_applied`, `pending_update_expired` and `invoice.payment_action_required`, which the live
endpoint does not send today; if they are added they need no code.

The list call does not pass `expand: ["data.items.data.price"]`: subscription items already carry the full
price object, and asking Stripe to expand a non-expandable field is an error.

### 2. Eager sync on the success page

Checkout's `success_url` now carries `&session={CHECKOUT_SESSION_ID}` (plans and top-ups). The account page
calls `confirmCheckoutReturn` (`lib/billing-return.ts`) before reading the plan or balance. The id only says
which session to look at: it must match `cs_…`, and the retrieved session's customer must equal the signed-in
workspace's `stripeCustomerId`, or it is ignored. For a plan it runs `syncWorkspaceBilling`; for a paid top-up
it calls the webhook's own `applyAiTopUp` (one grant per `checkout:<session id>` under the workspace lock, so
page and webhook together grant once). On success the page says "Your plan is active." / "Your credits are
added."; on anything else (mismatch, Stripe error, more than 5 s) it shows the old message and the webhook
does the work. The page never errors on this path.

### 3. Currency in the failed-payment email

`invoiceAmount(cents, currency)` in `lib/stripe.ts` uses the app's `formatCharge`: "A$39", "US$29",
"A$32.50" (whole dollars without cents, as everywhere else in the app); any other currency as "12.00 EUR".

### 4. Typed env (`apps/web/env.ts`)

`@t3-oss/env-nextjs` with zod over the Stripe secret and webhook secret, the eight plan price ids, the two
top-up ids, the two product ids, the four `SAMPLE_REEL_*` lists and `APP_URL`. **Every variable is optional**:
each one's absence already switches something off, so no missing variable can stop production booting.
`"unset"` and `""` are cleared before parsing (so they read as absent with validation on or skipped);
validation is skipped under `NODE_ENV=test` or `SKIP_ENV_VALIDATION`. Values are read when used and re-parsed
only when one changes, so behaviour matches the direct reads (tests that set `process.env` keep working).
At boot `instrumentation.ts` logs warnings for values that are set but look wrong (a price id not `price_…`,
a webhook secret not `whsec_…`, a key not `sk_`/`rk_`, an `APP_URL` without a scheme); never fatal, never
printing a value.

Migrated: `lib/stripe.ts`, `lib/billing-ai.ts`, `lib/sample-reels.ts`, and the webhook's secret.
`billing-actions.ts` had no direct reads. **Left for a follow-up** (about 90 reads): `lib/app-url.ts`
(`APP_URL`, which today would treat `"unset"` as a host, so moving it is a behaviour change to make on
purpose), `lib/email.ts`, `lib/auth.ts`, `lib/storage.ts`, `lib/queue.ts`, `lib/openai.ts`,
`lib/google-federation.ts`, `lib/instagram*.ts`, `lib/stock*.ts`, `lib/ai-video.ts`, `lib/render-*.ts`,
`lib/scheduled-post*.ts`, `lib/site.ts`, `lib/workflows.ts`, `lib/mcp/http.ts`, `app/auth-actions.ts`,
`app/login/page.tsx`, the `app/api/**` routes (ai, presenters, director, script, uploads, scheduled-posts,
dev/mailbox) and `next.config.ts`.

## Consequences

- A late or reordered subscription event can no longer drop a paying customer to Free; each event costs one
  `subscriptions.list` call instead of one `retrieve`.
- A customer with two live subscriptions (possible today, see below) is governed by the newest paid one,
  where before the last event decided.
- The account page after Checkout makes up to two Stripe calls, bounded at 5 s, only when the URL has a session id.

Stripe-side settings this does **not** change (for the owner): subscribing the endpoint to the five extra
events above, and the Dashboard's "limit customers to one subscription" setting in Checkout settings
(`startCheckout` already sends existing subscribers to the portal, so this is defence in depth).

## What was verified

- `apps/web/lib/billing-sync.test.ts` (Stripe and Prisma stubbed): the late-deleted scenario stays on the new
  plan; all-ended writes Free and keeps the customer; the hint finds a first checkout's workspace; the
  picker's ranking; the success page ignores another customer's session and malformed ids, confirms by syncing,
  grants through `applyAiTopUp`, and returns false on a Stripe error and on a 5 s stall.
- `apps/web/lib/env.test.ts`: `"unset"` and `""` read as absent with validation on and skipped; boots with
  nothing set; the source is not mutated; values follow `process.env`; warnings name but do not print values.
- `apps/web/lib/stripe.test.ts`: A$/US$ formatting of the email amount.
- `packages/db/tests/billing-sync.test.ts` (Postgres, runs in CI): the late-deleted scenario against a real
  workspace row, and a top-up granted by the success page then by the webhook adds 10 credits once.
- `pnpm check` and `next build` (see the PR).
