# 55. The presenter walks through the words, and particles on the title's plane

Date: 2026-10-21

## Context

Two asks from the owner after the snowy-lodge reel:

1. **Walking through the words.** `text.behind: true` (ADR 0039) draws the
   presenter matte above the title for the whole shot. The owner wants the
   title to start in front of the presenter (she is far from camera, behind
   the words) and, as she walks toward camera, for her to pass through the
   plane and end in front of them.
2. **"It feels a bit stock."** ALPINE VIEWS pinned in the sky, FIRESIDE and
   WARM UP: the owner asked for particle effects so the titles feel grounded
   in the scene rather than stuck on it.

Since ADR 0046 the scene evaluator (`packages/core/src/scene.ts`) owns where
a title is and `sceneLayers()` owns what draws above it; the person matte is
deterministic and versioned (ADR 0051). Both features have to sit on those
without changing the tracker, the segmentation or the command layer.

## Decision

### Schema (additive, `textSchema`)

- `passMs?: number`: reel time (ms) at which the presenter passes in front
  of this title. Read only with `behind: true`.
- `passFadeMs?: number`: how long the crossing takes, default 160 ms.
- `particles?: { kind: "snow" | "embers" | "dust"; density?: 0.2–2 (default 1); seed?: number }`.

Saved reels have none of these and render exactly as before: no field is
reinterpreted, nothing is written back.

### Walking through: an opacity on the presenter layer, not a state machine

The footage underneath already shows her. So "she is behind the words" is
the presenter matte drawn at opacity 0 above the title (the title covers
her), and "she is in front" is the matte at opacity 1. The crossing is

    passOpacity(text, reelMs) = clamp((reelMs − passMs) / passFadeMs, 0, 1)

1 for a plain `behind` title and for a title that is not `behind` (where
`passMs` is ignored). It is a pure function of the reel time, read from
`useCurrentFrame()` the same way `evaluateTitle` reads it, so a scrubbed
preview, a still and the export agree.

One presenter matte per clip is shared by every `behind` title on it
(ADR 0046), and one opacity cannot serve a title that is crossing and one
that is not. So `sceneLayers()` now orders group 0 as:

1. `behind` titles without `passMs`, each followed by its tapped objects;
2. the shared presenter matte of every clip one of *those* overlaps;
3. each passing title, its tapped objects, then a presenter matte of its
   own (`{ kind: "person", …, pass }`), above that title alone.

`personLayerOpacity(layer, reelFrame, fps)` is 1 for the shared matte and,
for a passing title's matte, `passOpacity` inside the title's window
(its plan entry's frames) and 0 outside it, so a passing title's matte
never covers another title. The renderer wraps that matte in `PassFade`, an
`AbsoluteFill` at that opacity. `stackTitles` (the editor's tap targets)
ranks passing titles after the other `behind` titles so a tap still selects
what is drawn on top.

Unchanged on purpose: the title's own placement (`evaluateTitle`), its
tapped object mattes (still directly above it, below its presenter), its
`endsBeforeShot` tail (title opacity, independent of the matte) and the
matte's pixels (`PersonMatteView` is mounted exactly as before, only inside
a wrapper). The cost: a clip with both a passing and a plain `behind` title
segments the presenter twice; a clip with only a passing title still
segments once (the shared matte is not mounted for it).

### Particles: a pure field in the title's plane

`packages/core/src/particles.ts`:

- `particleField({ kind, density, seed, timeMs, box })` returns the particles
  of one title on one frame. The box is the title's own: plane px
  (`rect.width × rect.height`) for a surface title, the text box for a screen
  title, grown by 30% of each side (and, for a single line, a quarter of its
  width above and below), at least 32 px. Positions come from an integer hash
  of (seed, particle index, slot); motion is a function of time. No
  `Math.random`, no state.
- **Depth sells it.** Each particle has a depth 0–1 from the hash. Near
  (> 0.7) particles are large and soft and always draw in front of the
  letters; far (< 0.35) ones are small and faint and always behind; mid ones
  are crisp and split by a per-particle bit (40% in front).
  - snow: near 7–14 px at 1080 under a soft blur at 60% with a faint cool
    shadow (1 px offset, 25% `#1a2a3a`) so it reads on a white sky; mid
    3–6 px crisp; far 1.5–3 px at 45%. 25–45 px/s down, a 10–20 px sine sway,
    drawn as a 1.3:1 ellipse along its velocity so it turns as it sways.
  - embers: a 1.5–3 s life (fade up, rise 30–60 px/s with a sway and a
    flicker, fade out, born again lower down elsewhere: each life's start is
    the hash of its cycle number); near 4–7 px with an 8–12 px blurred halo
    at 35%, mid 3–6 px with a smaller one, far 1.5–3 px at 45%; warm
    `#ffb15c → #ff6a2a`.
  - dust: 3–6 px, 35–50%, warm near-white `#fff4dc`, 5–10 px/s in any
    direction with a slow wander.
  - Counts at Medium (density 1): 70 snow, 50 embers, 35 dust; Thick (1.8)
    1.8×; Light 0.5.
- `particleSvg(field, layer, id, blend)` writes one `<svg>` per layer and blend
  pass: a halo group (blurred), a soft group (near particles) and a crisp
  group. Embers have two passes: halos normal-blended, so the glow shows on a
  bright background, and sparks in a pass the renderer screen-blends.
  Snow and dust are one normal pass.

`TextView` draws the back layer before the words and the front layer after
them, as siblings of the text element with the title's own transform: for a
surface title the placement's `placed` homography followed by
`translate(−margin)`, so the field warps and travels with the tracked plane;
for a screen title the same centre, rise, scale and rotation as the words.
They take the title's visible opacity (entrance × placement); only the
ember sparks are `mix-blend-mode: screen`. Being part of the title layer, they sit under the
title's occluders: the presenter of a `behind` title covers them too. They
are not inside the plane's clipping box, so they are not cut at a chosen
surface's edge.

### Editor

In the text sheet (where `behind` is set), when "People in the shot pass in
front of this text" is on: "She passes in front at ▸ 0:09.3" with **Use this
frame** (the playhead's reel time) and a clear (×); unticking `behind` clears
the crossing. A **Particles** row (No particles / Snow / Embers / Dust) and,
when on, a three-step density (Light 0.5 / Medium 1 / Thick 1.8). All
thumb-sized `.segmented` buttons, saved by the sheet's existing
`updateText` apply path, so undo and autosave are unchanged.

### Acceptance harness

The smoke fixture now carries `passMs: 900` on the `behind` title (w1,
WELCOME, on the reader clip), embers on the window title (s2) and snow on a
screen title (t2). The attachment probe drops a title's particles (they are
not glyphs; the probe measures where the letters are).

The first run used `passMs: 1200` and failed s2's attachment check at frame
37: s2's woodpile object matte (tapped at 1 s) draws above every `behind`
title (ADR 0046's group order), and with WELCOME exposed until 1.2 s that
matte's footage pixels showed over WELCOME's letters in s2's probe and not
in the still without s2. Before this change the presenter matte covered
WELCOME there with the same footage, so nothing showed. The fixture now
crosses before the tap's first tracked frame; the order itself is listed
below.

## Consequences

- Behind titles can tell a small story without keyframes: one moment, set
  from the frame the author is looking at.
- A passing title is drawn above the shared presenter, so where it overlaps
  a plain `behind` title on the same shot it draws on top of it.
- Particles are cheap (one SVG per layer, at most 120 circles) and identical
  in preview and export. They do not react to the scene (no occlusion by
  objects other than the title's own occluders, no lighting).
- Known gap, inherited from ADR 0046's order: a tapped object of *another*
  title (group 1) draws above every `behind` title, passing or not. While a
  passing title is in front of the presenter, such an object matte can show
  footage over its letters where the segmentation reaches them. Fixing it
  means clipping an object matte to its own title's region, which belongs
  to the mattes work.
- Not done: a passing title whose presenter walks *away* (in front, then
  behind) would need a second moment; per-particle depth of field; particles
  that collide with the plane.

## What was verified

- `packages/core/tests/pass-particles.test.ts` (16 tests): the crossing ramp
  before, at, during and after `passMs`, the 160 ms default and a custom or
  zero fade, no `passMs` ⇒ 1, not `behind` ⇒ 1; a saved title without the new
  fields parses without them; `sceneLayers` carries `pass` only when `passMs`
  is set, the passing presenter is 0 outside its title's window, the layer
  order with a shared and a passing title, no shared matte for a clip whose
  only behind title passes, `stackTitles` agrees; particles: same frame ⇒
  identical SVG string, another frame or seed ⇒ another, every centre inside
  the field over a minute at density 2, the 30% margins, counts 70/50/35
  and 1.8×, near in front and far behind (fixed), sizes, blur bands and
  colours per depth, snow at 25–45 px/s and embers rising, an ember's life
  and respawn, the normal/screen passes, and a snapshot of one frame per kind.
- `pnpm check` (lint, typecheck of every package, all tests) passes.
- The render smoke with acceptance (`SMOKE_COMPARE=1 pnpm --filter
  @reelwalk/render smoke`, on Windows with imageio-ffmpeg's ffmpeg and
  Remotion's ffprobe): 15 frames drew, MP4 4.91 s with video and audio,
  preview against export ok on all ten frames (SSIM 0.980–0.993, worst
  block ≤ 14.8; frame 19 has WELCOME over the reader, frame 37 the reader
  over WELCOME), the three planar titles on their planes (drift ≤ 1.1 px).
  The first run, with the crossing at 1.2 s, had frame 37 mid-crossing (the
  presenter at 21%): preview against export ok there too (SSIM 0.983, worst
  block 6.2); it failed s2's attachment check as described above. Baseline (report-only) differs at
  frame 19, where WELCOME now covers the reader before her crossing; the
  committed references were not updated.
- Stills of the crossing (COME IN on the reader clip, frames 20 to 60) and of
  one frame per particle kind at 1080, drawn with `renderReelStills`; the
  crossing reads as intended. After the coordinator's review the first
  particle cut was too quiet to read on a phone; the depth bands above are
  the second cut, re-rendered at 1080 and checked at 2×.
