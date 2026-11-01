# 0105 — Gemini Omni Flash: 360p drafts first, final once the reel is confirmed

Date: 2026-11-01

## Context

Shot plans (ADR 0104) made every take at full price. On the first demo, most of the spend went on takes that were
thrown away:

- a presenter blocked three times by the safety filter;
- flights that morphed one room into another;
- a flight the video service would not start.

The owner pays for every second Google makes. They asked for the reel to be made cheaply first, reviewed and changed
until it is right, and only then made at full quality.

Gemini Omni Flash 1.1 (`gemini-omni-1.1-flash`, August 2026) fits that:

- Its 360p tier is reported at about $0.03 a second, against about $0.15 at 1080p.
- It takes a start and an end frame.
- It can extend an earlier take with that take's footage as context, not just its last frame, which is the best guard
  against drift.

Three facts shape how it is used:

- **No upscaling an earlier take.** Resolution is set when a take is made (1080p and 4K are Google's upscale of its
  720p). A final is a new take of the same shot, made again and checked again.
- **No pay-as-you-go on Vertex.** On Vertex the model is offered only on provisioned throughput or fixed quota. So it is
  called on the Gemini API's Interactions endpoint, with the deployment's Gemini API key.
- **Extension invents speech.** Extending a take that has speech near its end makes up words at the end (the owner's
  warning).

## Decision

**A second video model, per take.** `aiShotSchema` gains `engine: "veo" | "omni"` (Veo when absent) and `extendOf`: an
earlier Omni take of the workspace to carry on from instead of frames.

- **Web.** `createAiGeneration` reserves an Omni take at its own price: `aiOmniCostCents`, 3¢ a second at 360p and 15¢
  at 1080p. A draft costs one credit, as Veo's does.
  - Omni drafts keep their end frame (Veo's draft model has none) and their spoken line: Omni makes the sound with the
    picture.
  - The switch is `AI_OMNI_ENABLED` on the web. The worker needs `GEMINI_API_KEY`.
- **Worker (`omni-video.ts`).**
  - A take is one interaction: image parts for the start and end frames, then the prompt with its length in words;
    `response_format` `{ type: "video", aspect_ratio: "9:16", resolution }`; `background: true`; `store: true` so it
    can be extended later; `previous_interaction_id` to extend.
  - It is stored as operation `omni:<interaction id>` and polled through the same loop as Veo. Composing and the
    identity gate run before submission as for any take.
  - The take's length is measured with ffprobe, not assumed, and it is sized by tier (360×640 or 1080×1920).

**Drafts first, in shot plans.** A plan has an `engine`. Omni is the default where it is set up. An Omni plan starts in
the `draft` phase:

1. **Drafts.** The storyboard and every take are made as before, but each take is a 360p draft, checked by the motion,
   landing and continuity checks and retried cheaply.
2. **Review.** When every shot has a kept draft, the draft reel is assembled and the plan waits for `draft-review`. The
   owner watches it and asks for changes as redos with notes. Only the shots changed (and the shots continuing from
   them) are drafted again, and the reel is assembled again.
3. **Finalise.** The owner says the whole reel is right with `finalize`. Each kept draft is kept as `draftAiShotId`,
   and every shot is made again at 1080p, in order and checked the same way, with continuing shots carrying on from the
   finals. Then the final reel is assembled.

**Extend or start fresh** (`extendFrom`). A continuing shot carries on from the previous take with scene extension only
when all of these hold:

- the plan runs on Omni;
- the shot has no planned end still (extension takes no end frame);
- the previous take has no speech in its last `EXTEND_SPEECH_CLEARANCE_MS` (3 s), read from its transcript's last word.
  A voiced take with no transcript counts as speaking to the end.

Otherwise the shot starts fresh from the previous take's real last frame as a still.

**Sound.** In the assembled reel only shots with a line keep their sound. Every Omni take comes with generated audio,
which would fight the music.

**The planner** now also states two lessons from the demo:

- never use the word "nude" in any sense, and don't describe revealing clothing (it blocked the presenter twice);
- an end frame must show the same place as its start, including what is seen through openings.

## Turning it on

Terraform carries it (`infra/terraform`):

- `gemini_api_key` (sensitive) goes into Parameter Store as `GEMINI_API_KEY`, which the worker task reads as a secret.
- The web gets `AI_OMNI_ENABLED`, true exactly when the key is set.
- An empty key is stored as "unset", and the worker treats that as no key.

There are two ways to sign. With `gemini_api_key` set, the worker uses the key. Without one, set
`omni_enabled = true`: the worker signs with its own Google credentials, the Application Default Credentials or the
workload identity Veo already uses. The request carries `x-goog-user-project` set to `GOOGLE_CLOUD_PROJECT`, and that
project needs the Generative Language API enabled. No key is created or stored.

Either way, turning it on is one line in the ops checkout's `terraform.tfvars`, then the usual `bash infra/deploy.sh`.

## Amendment: refusals are refusals (2026-11-01, first live take)

The first live Omni draft was refused with HTTP 403, and the take was left UNRESOLVED with its credit held. Veo's rule
counts a submission as refused only when the error names a rejection code; the Interactions endpoint's 403 named none.

- For Omni, any 4xx except a timeout is a refusal (`omniRefused`), and so is a request that never left because the
  worker had no credentials to sign it (`OmniNotSent`). Both return the credit.
- The error now carries Google's codes, never its text: the canonical status and the details' reasons, such as
  `SERVICE_DISABLED`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT` or `IAM_PERMISSION_DENIED`, or `NON_JSON_BODY` when the body is
  not JSON. The next refusal names what to fix.

The organisation's policy disallows API keys, so Omni runs only with the worker's own Google credentials. The 403's reason
turned out to be `ACCESS_TOKEN_SCOPE_INSUFFICIENT`: the owner's own token, with only the cloud-platform scope, got the
same refusal from the Gemini API. So Omni's token asks for `GEMINI_SCOPES` (cloud-platform and
`generative-language.retriever`), and Veo's is unchanged. The worker's service account also needs
`roles/serviceusage.serviceUsageConsumer` on the project its requests are billed to.

## Not in this step

1. A live comparison of Omni and Veo on the same flight. The worker's first Omni take is the first real request, so
   `videoOf` reads the video from the response wherever it sits.
2. Seedance (BytePlus or fal) and self-hosted models (LTX-2.5 on a local GPU) as further engines, for unmetered drafts.
3. Omni's conversational edits ("make the violin invisible") as a way to fix one part of a take without remaking it.
