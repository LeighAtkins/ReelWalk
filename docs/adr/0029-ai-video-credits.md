# 0029 — Meter eight-second AI video clips separately from AI editing

## Decision

Use Google Veo 3.1 Fast through Vertex AI. Every request generates one
eight-second, silent, 1080×1920 clip. The model, duration, sample count,
resolution and audio setting are fixed on the server. The initial estimate is
USD 0.80 per completed clip; re-check Google's SKU pricing before raising limits.

The free trial includes one lifetime credit per workspace. Agent ($29/month)
includes ten credits a month; Studio ($79/month) includes thirty. Yearly
subscriptions also receive credits monthly, anchored to their payment date.
Monthly credits expire without rollover. Five additional, non-expiring credits
cost $15 through a one-off Stripe Checkout payment. Existing AI editing quotas
and export quotas remain separate.

## Accounting

`AiCreditGrant` records trial, monthly and purchased grants. All grant and debit
writes lock the workspace row. A generation reserves a credit and its estimated
cost in one transaction. Its workspace/request UUID makes a retried HTTP request
idempotent. Expiring credits are used first. A terminal failure refunds the
original grant once; it does not extend an expired monthly grant.

Only paid Stripe invoices fund recurring generation. `invoice.paid` records
the invoiced plan and paid-through time, then materializes the current monthly
grant. The anniversary calculation handles month ends and leap years. An
upgrade grants only the difference; duplicate events cannot restore spent
credits. Late invoices cannot overwrite newer paid periods. Checkout top-ups
verify the exact configured price, customer, quantity, currency and paid amount,
and use the Checkout session id as a unique grant source. Record webhook
completion after handling it so failed processing is retried.

## Execution and recovery

The existing on-demand Fargate worker polls durable `AiGeneration` rows with
`FOR UPDATE SKIP LOCKED` leases. Cloudflare/App Runner requests return promptly;
generation continues when the browser closes. The readiness reconciler includes
AI jobs when starting workers. Workers stay alive while a video is outstanding.

Persist Google's operation name and poll that same operation on retries. Never
automatically repeat a submission whose result is unknown: a timed-out POST may
already have generated a billable video. Refund its user credit on interruption
but retain the spend reservation conservatively. Completed clips are copied to
the normal S3 media library, scoped to the owning workspace, and can be reused
without generating again. Reference photos are read from owned/shared media,
not arbitrary client URLs. Property details must be reviewed before publication.

## Controls and configuration

The global `AiSpendBudget` row enforces an initial **USD 240 lifetime ceiling**
(`AI_VIDEO_BUDGET_CENTS=24000`). This is shared by free and paid generations;
raise it deliberately once the pilot economics are reviewed. It is an
application control, not a limit on direct use of the Google Cloud project.
Disabling `AI_VIDEO_ENABLED` prevents new submissions. Each workspace may have
two active jobs and ten attempts per hour. The public demo cannot spend credits.

Set `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION=us-central1` and
`GOOGLE_SERVICE_ACCOUNT_JSON` on workers only (or use Application Default
Credentials). Production stores the JSON in encrypted AWS Parameter Store;
the web app does not receive it. Configure `STRIPE_PRICE_AI_TOP_UP` with the
non-recurring USD 15 price and include `checkout.session.completed`,
`checkout.session.async_payment_succeeded` and `invoice.paid` on the existing
Stripe webhook endpoint. Keep Google credentials and all Stripe secrets out of
Git, client bundles, screenshots and logs.
