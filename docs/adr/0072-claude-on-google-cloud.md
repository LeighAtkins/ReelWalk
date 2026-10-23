# 72. Claude through Google Cloud: a third AI provider, `vertex`

Date: 2026-10-23

## Context

The owner has Google Cloud credits. The app already spends on Google for
Veo (ADR 0029): the render worker exchanges its ECS task-role credentials
at Google STS for a federated token and impersonates a Vertex service
account, so no Google key exists anywhere. Claude, which answers every
"ask for a change", Director review, shot list, hook line and room label
(ADR 0032, 0034), is billed directly to Anthropic with an API key.

Google serves the same Claude models through Vertex AI ("Agent Platform").
Anthropic publishes an official client for it, `@anthropic-ai/vertex-sdk`,
that takes the same Messages request and rewrites it onto Google's
`rawPredict` endpoint with a Google OAuth token. Structured outputs
(`output_config.format`), effort, vision and prompt caching are all served
there; Message Batches are not (the app does not use them).

On 2026-10-23 Anthropic also announced an Anthropic-managed "Claude on
Google Cloud" route (billing through Google, the Anthropic API surface
otherwise). Its developer documentation is not out yet.

## Decision

### `AI_PROVIDER=vertex`, next to `anthropic` and `openai`

`apps/web/lib/openai.ts` gains a third provider. It is only ever chosen
explicitly: with no `AI_PROVIDER`, a Claude key still means direct
Anthropic and no key means OpenAI, as before. Rolling back is
`AI_PROVIDER=anthropic` and a deploy; the direct route is untouched.

- `vertexConfig()` is the configuration gate. It needs `GOOGLE_CLOUD_PROJECT`
  and a way to get a Google token: the federation pair
  (`GOOGLE_WORKLOAD_IDENTITY_AUDIENCE` + `GOOGLE_SERVICE_ACCOUNT_EMAIL`) that
  the worker already uses, or, for local development only,
  `GOOGLE_APPLICATION_CREDENTIALS`. Half a pair, or the SSM "unset"
  placeholder, means not configured: `isAiConfigured()` is false and the
  feature fails closed. `VERTEX_CLAUDE_REGION` defaults to `global`.
- `aiModel()` keeps reading `ANTHROPIC_MODEL` (default `claude-opus-5-5`).
  Vertex model ids are the bare first-party ids.
- `vertexAnswer()` sends exactly what `claudeAnswer()` sends. The request
  shaping (system prompt, one user turn with optional base64 images, strict
  JSON schema with the edit-plan transport of ADR 0032, medium effort,
  `max_tokens` 4096..32000) and the response decoding (refusal, truncation,
  JSON, usage with cache reads and writes) were pulled into `claudeRequest()`
  and `decodeClaudeMessage()` and are shared by both routes, so the two
  cannot drift.
- The client is `new AnthropicVertex({ projectId, region, authClient,
  maxRetries: 0, timeout: 60_000 })`, one per configuration, cached so the
  Google token inside it is reused and refreshed rather than exchanged on
  every call. `maxRetries: 0` is deliberate: inside a durable AI step an
  unanswered request must never be sent twice (ADR 0049); the callers that
  may retry (Ask, shot list) already do so themselves after checking the
  provider gate. The gate's `beforeProviderRequest()` / `providerAnswered()`
  wrap the call as on the other routes.
- `authClient` is `federatedGoogleAuth(awsCredentials(), audience, email)`:
  the same `AwsClient` configuration as the worker's `federatedVideoAuth`,
  copied into `apps/web/lib/google-federation.ts` because the web and
  worker images are built from separate trees (a shared package would need
  both Dockerfiles changed for fifteen lines). `awsCredentials()` is the
  S3 client's refreshing provider, the App Runner instance role in
  production. No Google key is created or stored.
- Errors are mapped by SDK class to `AiError`: `RateLimitError`,
  `InternalServerError` (5xx including 529) and `APIConnectionError`
  (timeouts, dropped connections, a token the Google side would not issue)
  are transient; any other `APIError` (400 schema rejected, 401/403 the
  pool or IAM refused, 404 model not served in that region) is final.
  Messages carry the status code only, never the provider body.

### Pricing

Google's list prices for Claude at the **global endpoint equal
Anthropic's** (Opus 5.5: $4 / $20 per MTok, cache read $0.20, five-minute
cache write $5; Sonnet 5.5 $2 / $10; Haiku 5.5 $0.10 / $0.50), so
`usageCostUsd()` keeps one price table. The same page lists a second rate
table, which we read as the **regional endpoints (us-east5, europe-west1,
...), 10% higher** (Opus 5.5 $4.40 / $22.00, cache read $0.22).
`usageCostUsd(model, usage, { provider: "vertex", vertexRegion })` applies
`vertexPriceFactor(region)` (1 for `global`, 1.1 otherwise). Source:
<https://cloud.google.com/vertex-ai/generative-ai/pricing#claude-models>,
read 2026-10-23 (the page is rendered client-side; the rows were read from
its embedded data). Re-check before relying on it for billing.

### Region

`global` first: Google's Opus 5.5 model page lists the global endpoint and
the `us` / `eu` multi-regions, with twice the quota at the global endpoint
(2,000 requests and 20M input tokens a minute). Set `VERTEX_CLAUDE_REGION`
to a region only if a model is not served globally; the SDK maps `global`,
`us`, `eu` and named regions to the right host.

### Terraform

`var.ai_provider` accepts `vertex`. The App Runner web service now receives
`GOOGLE_WORKLOAD_IDENTITY_AUDIENCE`, `GOOGLE_SERVICE_ACCOUNT_EMAIL` and
`VERTEX_CLAUDE_REGION` (`var.vertex_claude_region`, default `global`) in
addition to the `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` it already
had. The worker task definition is unchanged. No secrets are added.

### The side-by-side check

`apps/web/scripts/compare-ai-providers.mts` (`pnpm ai:compare`) sends the
same three real prompts the app sends, an Ask change on a two-room reel,
the draft review's text critique and five hook lines, to `anthropic` and to
`vertex`, and prints both JSON answers with token usage, seconds and
list-price cost. It refuses to run unless both sides are configured, names
the missing variables without printing values, and never prints a key. It
sits next to `director-smoke.mts` rather than in `.tools/`, which is
gitignored in this repo.

## Google-side steps before switching (owner, console or gcloud)

The workload identity pool was set up for Veo so that only the worker's
task role may use it (ADR 0029: "The identity provider is restricted to the
ReelWalk worker role"). The web app has a different AWS identity, the App
Runner instance role `reelwalk-web-instance` (`aws_iam_role.web_instance`).
Until the Google side admits it, the first Vertex call from the web app
fails with a 401/403 mapped to a final `AiError`, and nothing is billed.
In the Google project that owns the pool:

1. **Pool provider attribute condition.** On the AWS provider of the
   workload identity pool, widen the condition to admit the web instance
   role as well as the worker task role, for example
   `attribute.aws_role == "arn:aws:sts::<account>:assumed-role/reelwalk-worker-task" || attribute.aws_role == "arn:aws:sts::<account>:assumed-role/reelwalk-web-instance"`
   (match whichever attribute mapping the provider already uses; the
   existing worker clause shows the shape).
2. **Allow the web role to impersonate the service account.** Grant
   `roles/iam.workloadIdentityUser` on the Veo service account
   (`GOOGLE_SERVICE_ACCOUNT_EMAIL`) to the principal set for the web role,
   `principalSet://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/attribute.aws_role/arn:aws:sts::<account>:assumed-role/reelwalk-web-instance`.
3. **Let the service account call Claude.** The account has Vertex AI User
   (`roles/aiplatform.user`) on the project for Veo; that role covers
   `rawPredict` on publisher models, so nothing more is needed for the
   role itself. Confirm the project has **enabled the Claude models in
   Model Garden** (each Anthropic model is enabled once per project, with
   the usage terms) and that **quota for Claude Opus 5.5 at the global
   endpoint is non-zero** in the Vertex quotas page.
4. **Terraform.** Set `ai_provider = "vertex"` in `terraform.tfvars`
   (project, audience and email are already set for Veo) and apply. The
   deploy script refuses a plan that changes the worker environment; this
   change touches only the web service.
5. **Prove it before trusting it.** Run `pnpm ai:compare` from a machine
   with both an Anthropic key and `GOOGLE_APPLICATION_CREDENTIALS` for the
   project (`gcloud auth application-default login`), or run the smoke
   check with `AI_PROVIDER=vertex` after the deploy, and compare the
   answers and costs. Then watch the first real asks in the admin usage
   page.

Rollback at any point: `ai_provider = "anthropic"`, apply.

## Consequences

- With `vertex`, Google is the data processor for the editing prompts and
  the frames sent for vision; with `anthropic` it is Anthropic. The owner
  decides which agreement covers the app's users.
- No Message Batches on Vertex. Unused today; a future batch feature would
  need the direct route or Google's batch prediction.
- Server-side features follow Google's rollout, not Anthropic's: the
  availability table should be checked before adopting a new beta on this
  route.
- The web image gains `@anthropic-ai/sdk`, `@anthropic-ai/vertex-sdk` and
  `google-auth-library` (the worker's version). The SDK types its
  `authClient` against google-auth-library 10 while the app uses 11; the
  cast is documented in code and would fail loudly on the first call, not
  silently.
- The Anthropic-managed "Claude on Google Cloud" route is the likely
  follow-up once its developer documentation exists: by its description it
  is a base-URL and authentication change on the direct route, with Message
  Batches and same-day feature parity, billed to the Google account. The
  `vertexAnswer` / `claudeAnswer` split, with the shared request and
  decoder, is the seam where that would go.

## What was verified

- `pnpm check` (lint, typecheck of every package, all tests) and
  `pnpm --filter @reelwalk/web build` pass; see the PR for the output.
- `apps/web/lib/openai-vertex.test.ts`: 15 tests with the Vertex SDK and
  Google auth mocked: explicit selection and the no-implicit-vertex rule,
  configuration detection (pair, half pair, placeholder, ADC), the client
  options (project, region, federated auth client from the app's AWS
  credentials, `maxRetries: 0`), client reuse, the request body (model,
  `max_tokens`, system, strict JSON transport, medium effort, base64 image,
  rejection of remote image URLs), usage accounting, refusal / truncation /
  bad JSON as final errors, SDK error mapping without echoing bodies, and
  pricing at the global endpoint and a region.
- `packages/core/tests/ai-provider.test.ts` (the direct route, 7 tests)
  still passes against the shared request and decoder.
- `terraform fmt -check` and `terraform validate` pass on the changed files.
- The compare script refuses to run with no configuration and names the
  variables only.
- **Not verified:** a real call to Claude on Vertex. No Google project
  credentials are available to the agent, and the pool does not yet admit
  the web role. The first live run is step 5 above.
