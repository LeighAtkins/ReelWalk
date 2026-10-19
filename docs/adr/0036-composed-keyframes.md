# 0036 - Compose Veo keyframes with the presenter before generating

## Context

Maya's villa reel (post-mortem, 2026-10-19) burned six takes on the same
defect: given one real exterior frame and a prompt that said "she lands in
front of the house", Veo made her rise from the ground before falling, or
morphed the facade into the living room. Every take that passed was pinned
at both ends: a start still and an end still, each a real frame with the
presenter composited in at human scale, so Veo only had to interpolate.
Those stills were made by hand with an image model outside the app.

## Decision

A shot may carry `compose`: a `presenter` frame (an owned asset and time
where she is clear and full length) and one sentence for `first` and/or
`last` saying where she is in that still and her size against a named
object. Opus proposes it from the director sheet when the real frames do
not already show what the shot needs; the schema and prompt rules in
`packages/core/src/ai-director.ts` keep it null otherwise.

The web resolves the presenter frame like the start and end frames (asset
ids only, scoped to the workspace or shared library; never a storage key
from the browser) and stores it in `frameSources` with a `role`. The worker
decodes all three with the existing bounded ffmpeg path, then asks Gemini
(`AI_IMAGE_MODEL`, default `gemini-2.5-flash-image`, through the same
Vertex credentials as Veo) for each composed end, normalises the result to
the 1080×1920 JPEG Veo expects, keeps a copy beside the take
(`…/ai/<id>-first.jpg`, `-last.jpg`) and submits the composed stills as
`image` and `lastFrame`. A composition failure refunds the credit before
anything is paid, like a frame-decode failure.

The composition prompt fixes what went wrong by hand: keep the scene's
camera, light and surfaces; keep the presenter's identity; pin her height
to the named object with real-world sizes; say whether the still is the
moment before the action or after it; no text or extra people.

## Consequences

- One image call (cents) per composed end, not metered as a credit; the
  budget it protects is the 1–2 credit Veo take.
- Rows written before this ADR have no `role` on their frame sources and
  are read as start then end, unchanged.
- The Vertex service account needs Gemini access in the same project; the
  first live run after deploy proves it.
- Identity across takes still depends on the image model honouring the
  reference; the presenter check in the director review remains the guard.
