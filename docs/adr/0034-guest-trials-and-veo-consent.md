# ADR 0034: Guest drafts, account trials and Veo consent

Status: implemented for review; not deployed.

Visitors start a private studio without an email or card. The existing upload,
room-label and first-cut editor runs there. Guest sessions last seven days.
Anonymous creation is limited to three studios per network per 24-hour window;
the counter and studio creation commit together. Guests use existing Free
storage/editing limits and the lifetime two-credit AI video allowance.

At export, an email and password claim the same user and workspace. Uploads,
reels and credit history retain their ownership. Guest sessions are invalidated
and a normal session is issued. A compare-and-set prevents a second claim from
restarting the trial. An existing email cannot be overwritten.

Claiming starts seven days of Agent access through compedPlan/compedUntil.
Regular new signups receive the same trial. Unused AI credits are retained,
not refilled. trialStartedAt identifies these trials so exports require a paid
plan after expiry; legacy free workspaces are unchanged. Existing Instagram
plan gates admit Agent trials. There is no automatic billing or paid conversion.

The intake accepts pasted listing text and displays extracted facts for checking.
An exterior-photo suggestion accompanies the refined cut when suitable media
is available. Model requests use the existing editing allowance and provider.

Veo defaults to ASK. Manual generation requires explicit approval from the
cost-labelled Generate button. AUTO is available only to paid workspaces:
Workspace.plan is checked, never its temporary effective/comped plan. Each
automatic generation rechecks consent server-side, so downgrades immediately
remove automatic authority. Existing request UUID idempotency, refunds,
concurrency limits and the global video budget remain unchanged. Creative
redos consume credits; no automatic paid retry loop is added.

Generated assets remain editable library media. A completed automatic suggestion
can be added while its panel is open. Closing the browser retains the asset in
the library; this does not provide durable automatic timeline assembly or
automatic video quality acceptance. Suggestions use the existing background
AI mechanism and can fail across a web restart; the real-footage cut survives.
PDF/portal ingestion, stabilization, feature tracking and automatic generated
video review remain separate work and are not advertised as implemented.

## Validation

- Core policy tests cover trial expiry and paid-only automatic consent.
- Postgres tests cover concurrent starts, ownership and credit preservation,
  duplicate-email refusal and single-use claiming.
- Mobile checks cover guest intake, a first draft, signup at export, returning
  to the same reel, no debit for suggestions, explicit debit, automatic paid
  debit and downgrade refusal.
- Browser checks use local storage/model stand-ins. Video jobs remain queued
  in an isolated database with no provider dispatch or paid generation calls.
- Migration SQL is applied to a fresh scratch Postgres database.

## Deployment

Apply additive migration `20261018020000_guest_users` before the new web image.
It adds User.isGuest, Workspace.trialStartedAt and Workspace.aiVideoMode.
Existing accounts stay registered; existing workspaces retain plans and default
to ASK. No balance migration or Stripe price change is included.

Model wire schemas use supported structural constraints; bounded fields are
validated locally after the response, following the
[Claude structured output guidance](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
