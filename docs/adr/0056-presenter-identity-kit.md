# 0056 - Presenter identity kit

## Context

AI presenter takes kept coming back with a distorted or different face.
The composed keyframes stored beside the last four jobs
(`workspaces/<ws>/ai/<job>-first.jpg`) showed three causes:

1. **Reference chaining.** `compose.presenter` pointed at a generated take
   whose own reference was a generated take, three hops deep
   (cmvf5ivdt → cmvf5truu → cmvgx1hlq). Each hop re-synthesises the face;
   by the third she was a different woman with long hair. The one take
   composed from a first-generation asset came back right.
2. **A tiny identity cue.** `compose()` sent one full 1080×1920 frame as
   the presenter reference. In wide shots her head was 60–70 px tall, about
   2% of the pixels, and the frame was a 4:2:0 JPEG that halves the colour
   resolution of that face. Gemini composited a soft 65 px face and Veo
   animated it: the identity was invented.
3. **No guard.** ADR 0036 left "the presenter check in the director
   review" as the guard, which runs after the paid Veo call.

## Decision

**A presenter kit per workspace.** `Presenter { workspaceId, name,
portraitAssetId, fullBodyAssetId, faceCropKey, faceHeightPx, voice?,
isDefault }` (additive migration `20261021020000_presenter_kits`; a partial
unique index keeps one default per workspace). Both photos must be the
workspace's own JPEG/PNG uploads: never the shared starter library, never a
generated take. `GET/POST /api/presenters` and `PATCH /api/presenters/:id`
are scoped to the session's workspace like assets, with the same origin
check as the other mutating routes. The first kit is the default.

The worker makes the face crop (`processPresenterKit`, in the AI loop,
leased like a generation, three tries): it decodes the portrait to PNG
(never upscaled), asks a Gemini text model (`AI_IDENTITY_MODEL`, default
`gemini-2.5-flash`) for the face box, cuts a square 2.2× the face so the
hairline and hair length are in, and stores a 768×768 RGB PNG at
`workspaces/<ws>/presenters/<id>/face.png`. The measured face height is
kept; under 400 px the kit still works but the picker says a closer
head-and-shoulders photo would hold her likeness better. MediaPipe was
not used: the render package runs it in the browser, not in Node.

**Compose uses the kit, never a generated clip.** `aiComposeSchema` gains
`presenterId` (preferred), `framing`, and `allowGeneratedReference`.
`presenter: frame` stays for older callers, but a frame whose asset id
starts with `ai-` is rejected with "Pick the presenter kit, not a generated
take — faces drift when takes are chained." unless
`allowGeneratedReference: true` is passed. The check is in the schema and
again in `createAiGeneration`, because the director route builds its shot
without parsing. Director approvals use the picked kit, else the
workspace default, whatever frame Opus named; with no kit, a null
presenter asks the studio to set one up, and a generated one is refused.

With a kit, `frameSources` carries the full-length still (`presenter`) and
the face crop (`face`). The worker sends Gemini three images (scene,
full-length, face) and the instruction "match the face in the third image
exactly (eyes, nose, mouth, hairline, hair length and colour)". Everything
the image model reads is decoded as PNG (`rgb24`); a frame Veo receives
unchanged stays the JPEG it always was, and only the final composite is
converted to the JPEG Veo needs.

**Framing.** `compose.framing` is `medium` unless asked for or the
description says "wide": head about a quarter of the way down, knees near
the bottom edge, so the face is at least 180 px tall at 1080×1920. The
director prompt tells Opus to leave `presenter` null (the kit), never to
name an `ai-` asset, and to use medium for any spoken line; the structured
output schema gains a nullable `framing`.

**Identity gate before paying.** After each composed end and before
`provider.submit`, a Gemini text call gets the composite and the kit's face
crop (or, for an older frame-only request, the presenter frame) and returns
`{ samePerson, confidence, faceHeightPx, faceBox }`. The face is located in
the same call (the box gives the face height; the model's own pixel count
is only a fallback) rather than cropped first, since there is no Node face
detector in the stack. Decision table (`identityDecision`): same person
with confidence ≥ 0.6 passes; otherwise recompose once with a stronger
identity instruction; a second miss refunds the credit and records
`failureCode = "identity_rejected"` with both scores. A check that cannot
run counts as a miss, never a pass. Every attempt's composite is kept
(`-first.jpg`, `-first-retry.jpg`), every verdict is stored in
`identityChecks`, and the lowest accepted score in `identityScore`, so drift
can be queried over time.

**Lineage.** `AiGeneration.referenceDepth`: 0 for the kit or real footage,
the source take's depth + 1 for a generated reference (a take from before
depths were recorded counts as 1). The director sheet shows a warning badge
on a proposal that would be made from an AI take, with its depth, and
`/api/ai/generations` returns `referenceDepth`, `identityScore` and
`failureCode`.

**Seeding.** `apps/worker/scripts/seed-presenter.mjs` uploads two local
stills through a signed-in tab (via CDP) with the app's own upload API,
exposed as `POST /api/uploads` and `/api/uploads/confirm` (thin wrappers
over the existing `createUpload`/`confirmUpload` actions, with an origin
check), then creates the kit. No photo is committed.

## Consequences

- Cost: the identity check is one text call with two images, well under a
  cent at Gemini 2.5 Flash list prices; a face crop is one such call per
  kit. A recompose adds one image call (a few cents) and a second check.
  None of it is metered as a credit; a rejected take is refunded and Veo is
  never called for it.
- A shot with composed stills now needs a kit (or an explicit
  `allowGeneratedReference`). Existing saved reels are unaffected: this
  only changes what new generations are made from. Generation rows saved
  before this change are read back leniently (`parseStoredAiShot`) so an
  in-flight take keeps its voice and draft.
- Saved director reviews whose shot had compose with a null presenter used
  to drop the compose silently; they now keep it and use the kit.
- The gate trusts a model's judgement of identity; 0.6 is a starting
  threshold to tune from the recorded scores. It cannot catch drift Veo
  introduces while animating; the director review still checks the take.
- The local stills available today are full-length (face about 100–130 px
  in a 941×1672 frame), below the 400 px portrait bar; the kit says so. A
  real head-and-shoulders photo is the next improvement.

## What was verified

- `pnpm check` (lint, typecheck, all tests) passes.
- Unit tests: schema (rejecting an `ai-` reference, the explicit opt-in,
  framing default), compose payload (three PNG parts in order, the face
  instruction, the stronger retry), frame decoding (PNG for references and
  scenes to compose, references not cropped or upscaled), the gate's
  decision table and the worker's pass / recompose / reject / unavailable
  paths with Gemini mocked, face crop geometry and the kit worker, lineage
  depth, and route ownership for `/api/presenters`, director approvals and
  `createAiGeneration`.
- The migration was applied, with all earlier ones, to a scratch database
  in the local Postgres container; the partial unique index refused a
  second default kit.
- The seeding script's `--dry-run` reads the two local stills (941×1672
  PNG/JPEG).
- Not verified: any live Gemini call (none locally), the face crop on a
  real portrait, the gate's scores on real composites, the editor UI in a
  browser, and the seeding script against a real tab.
