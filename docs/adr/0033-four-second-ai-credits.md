# 0033 — A credit buys four seconds of AI video

Amends [0029](0029-ai-video-credits.md).

## Decision

A credit now buys 4 seconds of video instead of one 8-second clip. A 4-second
clip costs 1 credit and an 8-second clip costs 2. Every allowance doubles, so
the seconds included stay the same and customers get twice as many separate
clips:

| | Before | Now |
|---|---|---|
| Free trial (lifetime) | 1 | 2 |
| Agent (monthly) | 10 | 20 |
| Studio (monthly) | 30 | 60 |
| $15 top-up | 5 | 10 |

The model, resolution, audio setting and sample count stay fixed on the
server. The only choice the client gets is the length, and the API accepts only
4 or 8. The worker refuses any other length before it reaches the paid
endpoint. Day-to-night and construction timelapses default to 8 seconds
because they need the time to progress; every other move defaults to 4.

## Why

The clips are mostly used in short pieces: bridges play over 4 seconds and
bursts over 2. In practice we generated 8 seconds and used about 2–3. Veo also
drifts from the reference image as a clip runs on. On 2026-10-18 a photo-based
exterior stayed faithful for about 2 seconds, then invented geometry past the
photo's edge. Shorter clips cost half as much per try, stay closer to the
photo, and let a 4-second bridge play at natural speed instead of 2x.

## Accounting

Provider cost is reserved per second (10 cents, Veo 3.1 Fast at 1080p, silent),
so a 4-second job reserves 40 cents and an 8-second job 80 cents.

`AiGeneration` records `durationSeconds`, `credits` and, when an 8-second debit
spans two grants, `grantDebits`. Reservation plans the whole debit across
active grants (expiring first) before taking any of it. If the balance is short,
nothing is debited and the user is told how many credits the clip needs. A
refund returns exactly what each grant gave, once.

The migration doubles `amount` and `remaining` on every existing grant, so
balances keep their value. Rows created earlier default to 8 seconds and
2 credits. That matches what they were charged once balances are doubled, so a
late refund of an old job returns the right amount. During the deploy window
the old code may charge 1 doubled credit for an 8-second clip. That briefly
favours the customer and needs no correction.

## Not changed

The $15 Stripe price is unchanged. If the Stripe product description mentions a
clip count, update it there to say 10 credits.
