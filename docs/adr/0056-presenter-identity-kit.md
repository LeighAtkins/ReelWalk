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
three tries): it decodes the portrait to PNG (never upscaled), asks a
Gemini text model (`AI_IDENTITY_MODEL`, default `gemini-2.5-flash`) for the
face box, cuts a square 2.2× the face so the hairline and hair length are
in, and stores a 768×768 RGB PNG at
`workspaces/<ws>/presenters/<id>/<portraitAssetId>/<claim token>.png`. The
claim records a token and the portrait it was taken for, and every write
after it (the crop, an error) is conditional on both still holding. A
PATCH that changes the portrait (or a retry) clears the token, so a worker
still cutting the old portrait cannot publish it. Keys are written once and
never overwritten, and `createAiGeneration` snapshots the exact face-crop
and full-length keys into the generation's `frameSources` at reserve time,
so a queued generation reads the bytes it was promised whatever happens to
the kit. A worker that dies on its last try leaves a lapsed claim with the
tries used up; the next scan settles it with an error, the picker shows it
as failed (not "Preparing") at once, and a Retry action (`PATCH { retry:
true }`) resets the tries. The measured face height is
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
`provider.submit`, the gate makes two Gemini text calls. The first finds
the face in the 1080×1920 composite. With no box, an empty or inverted
box, or a face under 120 px tall (`MIN_GATE_FACE_PX`), there is nothing to
judge: the verdict is a miss (`reason: "no-face"` or `"face-too-small"`)
and no comparison is made. Otherwise the composite is cropped to the face
square (2.2× the box, with the hair, at 768×768 PNG) and the second call
compares that crop, not the whole frame, with the kit's face crop (or, for
an older frame-only request, the presenter frame), returning
`{ samePerson, confidence }`. There is no Node face detector in the stack,
so Gemini supplies the geometry. Decision table (`identityDecision`): the
same person with confidence ≥ 0.6 on a measured face of at least 120 px
passes; otherwise recompose once with a stronger instruction (and, when
the miss was a face too small to judge, at medium framing with "Closer: her
head about a quarter of the way down, face at least 220 px tall", even if
wide was asked for); a second miss refunds the credit and records
`failureCode = "identity_rejected"` with both scores. A check that cannot
run counts as a miss, never a pass. Every attempt's composite is kept
(`-first.jpg`, `-first-retry.jpg`), every verdict is stored in
`identityChecks`, and the lowest accepted score in `identityScore`, so drift
can be queried over time.

**The paid call is fenced.** Composing and checking both ends can take
several minutes, longer than the 300 s claim, and stale-job recovery used
to refund any lapsed SUBMITTING row while the original worker could still
submit it. Now the worker renews its claim every 30 s and after every
compose/check attempt while it prepares (stopping, unpaid, as soon as a
renewal finds the row is no longer its own). Immediately before
`provider.submit` it sets `submitStartedAt` with a conditional update on
its lease token, `SUBMITTING` and `submitStartedAt IS NULL`; if that
matches nothing it does not submit. Recovery distinguishes the two cases,
each with a conditional update: a lapsed row without `submitStartedAt` was
never sent and is refunded, credit and budget reservation both; one with
it may have been sent and becomes `UNRESOLVED` with no refund and no retry
(ADR 0049's rule). If the original submission does return, saving its
operation moves the row from `UNRESOLVED` to `RUNNING`. Every refund on the
preparation path is conditional on the lease token and `submitStartedAt IS
NULL`.

After the fence, failures are classified, never lumped together. A
definite refusal (HTTP 4xx other than 408 whose body names a rejection
code such as `INVALID_ARGUMENT`, `PERMISSION_DENIED` or
`RESOURCE_EXHAUSTED`, so no operation exists; only the code is read, the
body is never kept) is FAILED with credit and budget returned. Anything
ambiguous (a timeout, network error, abort, 5xx, or a 4xx without such a
code) is `UNRESOLVED`: the credit is held and the shot is never resent. If
Google returned an operation but saving it fails, the save is retried with
backoff (1, 3, 9 s) without resubmitting; if it still fails, the row is
held `UNRESOLVED` with the operation name stored where the database allows
and always logged. The message on an `UNRESOLVED` take is "We couldn't
confirm whether this take was made. Your credit is held; it won't be
charged twice."

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
check), then creates the kit. No photo is committed. The tab is chosen by
exact parsed-origin equality (`https://reelwalking.com.attacker.invalid`
does not match), and before the photos are sent the script asks the tab's
own execution context for `location.origin`; the in-tab function checks it
again before uploading anything.

## Consequences

- Cost: the identity check is two text calls (find the face, then compare
  two 768 px crops), each well under a cent at Gemini 2.5 Flash list
  prices; a face crop is one such call per kit. A recompose adds one image
  call (a few cents) and a second check. None of it is metered as a credit;
  a rejected take is refunded and Veo is never called for it.
- Request size: a compose request carries three images, up to about 14 MB
  of PNG (about 19 MB base64), each under Vertex's 7 MB per-image inline
  limit. Recorded, not changed.
- A wide composite whose face is under 120 px is refused even if it is her;
  wide arrivals must keep her large enough to recognise or be cut from real
  footage.
- `UNRESOLVED` generations keep their credit and budget reservation until
  someone looks; the AI panel shows their message. They need a
  reconciliation tool (follow-up): look up the stored or logged operation
  with Google, then either resume polling or refund.
- Identity calls (after the amendment below): each check is 2 to 4 text
  calls (locate, compare, and a pixel locate and compare if the first box
  missed her), so up to 8 per composed end with a recompose and 16 for a
  take composed at both ends, plus 1 to 2 composition (image) calls per end.
  A face that cannot be judged skips the compare.
- Upload confirm (also behind `/api/uploads/confirm`) checks the stored
  object's metadata (content type, size), not the file signature; the
  worker's decoder rejects anything that is not an image. Recorded, not
  changed.
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
- Review fixes (Astra): the fence in both orderings (refunded then the
  worker reaches the fence: no submit; fenced then recovery: UNRESOLVED,
  no refund), a lost renewal stopping the compose loop, recovery refunding
  only an unsent lapsed row; versioned face-crop keys published only under
  the claim (a portrait replaced mid-crop is not overwritten) and
  snapshotted into the generation; the gate refusing a null, zero-area or
  under-120 px face box without a comparison call and comparing a crop;
  exact-origin tab matching; settling a kit whose worker died on its last
  try, and Retry.
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

## Amendment (2026-10-21): the cmvi32byk false reject

**What happened.** Generation cmvi32byk000701ademkws6ou was refused with
0.05 on both composites, though both clearly show her. Reproduced locally
on the two stored JPEGs with the worker's own `faceCropRect` and
`cropFacePng`: her face measures hairline 705 to chin 805 px, ears 535 to
625 px, which is `box_2d` [367, 495, 419, 579]. That box crops to a square
that is her face. But that face is 100 px tall, under the 120 px floor, so
a correct locate would have answered `face-too-small` without comparing.
The gate compared (0.05, not 0), so the box Gemini returned was at least
120 px tall and was not her face. Two plausible readings of the first
version's `faceBox`, which was forced through a response schema, both crop
away from her: her pixel coordinates read as the 0–1000 grid lands on her
coat (192 px "face"), and an x/y swap lands on the window and her hand
(161 px). The exact box was not recorded, which is the other defect. The
kit crops from the same locate call were also loose and off-centre.

**Decision.**
- The locate call uses Gemini's own detection format: `box_2d`
  [ymin, xmin, ymax, xmax] normalised to 0–1000, y first, plus the eyes and
  mouth as landmarks, with no forced response schema. A box is used only if
  it is plausible: on the grid, non-empty, face-shaped in pixels (height
  over width 0.7 to 2.2; an x/y swap on a portrait frame is a sliver), and
  with the landmarks inside it and the eyes above the mouth.
- The compare call says whether the crop shows a face at all
  (`faceVisible`). A crop with no face is a missed locate, not a different
  person: the gate locates again, asking for pixels of the stated
  1080×1920 size, and compares that crop. If neither lands on her face the
  verdict is `locate-failed` with confidence 0, never a low identity score.
  The kit's face crop uses the same two-mode locate.
- A speaking end (a line with a voice) needs a 165 px face, hairline to
  chin, and is composed closer from the first attempt; silent takes keep
  120 px. cmvi0jk8h passed at 0.98 with a face too small for Veo to keep
  eyes and a mouth. The 165 px floor is calibrated on production: in the
  start frame of cmvi3jstp000901adp338aemf, whose take came back with good
  eyes and mouth, her face measures 180 px hairline to chin (hairline
  y ≈ 415, chin y ≈ 595, ears x ≈ 467 to 615, measured on the stored
  1080×1920 JPEG); the floor sits a little below that. An exception: a
  shouted Veo line (`voice: "veo"`) whose described end says "wide" or
  "action" keeps its framing and the 120 px floor, since it is not a held
  face that lip sync has to animate.
- The compare call also answers `eyesAndMouthRendered` (both eyes open
  with visible iris and whites, the mouth clearly formed), and a pass
  requires it.
- Every check stores its locate attempts in `identityChecks`: the mode,
  the box as read, why it was refused if it was, the crop rectangle and the
  face height, with the floor that applied. The worker logs the same line.
- Locate answers are read defensively. A malformed answer (string
  numbers, a five-number box, nested arrays, null, not JSON) is that mode's
  failure, recorded as `unparseable`, and the next mode still runs; only a
  provider error ends the check. A box with every value ≤ 1 (normalised to
  0–1, not 0–1000) is refused. When several faces come back, the largest
  plausible one is hers. A grid box that measures too small is checked
  again in pixels before the face is called too small.
- Compose wording is graded. A speaking end gets its own closer framing
  ("knees-up or tighter, the top of her head about a quarter of the way
  down, her face at least 220 px tall", aiming above the floor), with no
  blame for a previous attempt. After a face too small to judge, the retry
  escalates: waist-up, her head in the top fifth, her face at least 260 px.
  Either replaces the medium-framing text (which asks only 180 px) rather
  than contradicting it.
- The refund message says what actually went wrong: "We couldn't find her
  face clearly in the start frame", "Her face was too small to speak on
  camera (N px; needs 165)" (or "to recognise" for a silent take), "Her
  eyes or mouth weren't clearly drawn", "It didn't look like her (score
  X)", or "We couldn't check her face" when the check could not run.
- `cropFacePng` names its temp file by type: an ffmpeg without the
  `jpeg_pipe`/`png_pipe` probes cannot open an extensionless image.

**Verified.** Unit tests cover reading `box_2d`, `faceBox` and pixel
answers; the plausibility rules on her measured box and the swapped one;
the crop rectangle for her box; a crop with no face leading to the pixel
locate; `locate-failed` when neither lands; malformed, 0–1 and
multi-face locate answers; a small grid box falling through to pixels; the
165 px floor, the Veo wide/action exception and graded closer wording; a
refund message per reason; refusing a match without eyes and mouth; and
the locate record in `identityChecks`. Not verified: what Gemini actually
returns for these prompts (no live Gemini locally), so the root cause is
inferred from the stored composites and the recorded score, not observed.

