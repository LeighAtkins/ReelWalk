# ADR 0016: Transactional email, password reset, feedback and featured reels

Status: accepted (2026-10-12)

## Context

ADR 0012 left password reset as "email Leigh", there was no way to tell us
anything from inside the app, and reposting a customer's reel on
@reelwalking had no record of permission. All three need the app to send
email and to remember a few more things about people and reels. The
deployment is App Runner with an instance role (ADR 0015), so a provider
that takes IAM rather than an API key keeps secrets out of the picture.

## Decision

- **Amazon SES (the v2 API)** sends as `ReelWalk <hello@reelwalking.com>`,
  reply-to the same address. `infra/terraform/email.tf` creates the domain
  identity with Easy DKIM and puts `ses:SendEmail` on the App Runner
  instance role; the three DKIM CNAMEs are a Terraform output for
  Cloudflare. Production access (leaving the SES sandbox) is a one-off
  request made by hand; the file says how. `apps/web/lib/email.ts` is the
  only sender. Without `EMAIL_FROM` it logs the message and keeps it for
  `/api/dev/mailbox` (on when `DEV_MAILBOX=true`), which is how Compose, CI
  and the Playwright suite run without AWS.
- **Password reset** is a link, not a code. `/forgot` takes an email and
  always answers "if that address has an account we sent a link";
  the attempt counters (`AuthThrottle`, three per address an hour, twenty
  per network) run whether or not the account exists, so neither the
  answer nor the timing says which it was. The link carries a random
  token; `PasswordReset` stores its SHA-256, an expiry an hour out and
  `usedAt`. Spending the link sets the password, deletes every session of
  that user and signs the current browser in. A new request replaces an
  older unused link.
- **Feedback** is a form, not a mailto. A Feedback tab and a card on the
  account page post to one Server Action, which stores a `Feedback` row
  (studio, user, message, the page it came from, whether we may reply)
  and emails `hello@reelwalking.com`. The row is written first, so a mail
  failure loses nothing. Legal pages keep a plain `mailto:` for people
  who are not signed in.
- **Featured reels** are opt-in, per reel, revocable. Next to a finished
  export (the export screen and the owner's own share page) a checkbox
  reads "Let ReelWalk feature this reel on @reelwalking and our site" with
  a handle to credit; the text says the same box withdraws it. The `Reel`
  carries `featureConsent`, `featureHandle` and `featureConsentAt`.
  Posting through the app fills in the handle from the connected Instagram
  account. `/admin/featured` lists consented reels with download links for
  accounts named in `ADMIN_EMAILS`; everyone else gets a 404, so the page
  does not advertise itself.

## Consequences

- Env added: `EMAIL_FROM` and `ADMIN_EMAILS` (both set by Terraform for
  App Runner; Compose sets `DEV_MAILBOX=true` and names the demo user as
  admin so the suite can check the list).
- Until SES production access is granted, mail reaches only verified
  addresses; the app behaves the same and logs the SES error.
- Reset links are as strong as the inbox they land in, which is the
  trade every emailed reset makes; the hour and the single use bound it.
- Consent is a snapshot. Before reposting, check the box is still ticked
  on the day; the admin page says so.
- Magic-link sign-in would reuse `sendEmail()` and a table shaped like
  `PasswordReset`; nothing here prevents it.
