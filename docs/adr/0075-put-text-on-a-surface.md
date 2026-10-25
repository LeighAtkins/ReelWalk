# 75. Put text on a surface: the surface found for you

Date: 2026-10-25

## Context

The "perspective text" look that travels on Reels (words that sit on a wall, the
snow or the sky and move with the camera; the reference was made with
Higgsfield's Katana skill) is something ReelWalk already renders: a title with
a `surface` (four corners, ADR 0043), `blend: "surface"` (ADR 0039), a track of
those corners through the shot (ADR 0052) and Check mode to look at it (ADR
0044). What it did not have is a way to get there that a person would call
easy. Someone had to find a flat surface by eye, drag four numbered corners
onto it on a phone, add posts, press Pin, and read the grade. "Suggest
corners" (ADR 0043) found one wall near the title when the title was already
on it.

The owner's rules that bear on this: power appears where the thumb taps the
thing it affects; text has no box; the house serif; the stage centre stays
clear; every feature is reachable by an agent over `POST /api/reels/:id/commands`.

## Decision

One tap on a title: **Put on a surface**, at the top of the Pin sheet. The app
looks at the shot's first frame, proposes the three best surfaces drawn on it,
and a tap lays the title on the chosen one in the house serif, with an ink
chosen from the surface, and follows it through the whole shot with the
existing tracker. One edit, one undo; the existing corner handles still fix it.

### Finding surfaces (`packages/core/src/surface-finder.ts`, pure)

`findSurfaces(gray, { aspect }, hints)` fuses two sources of candidates and
measures every one the way the tracker will meet it.

1. **Regions from a vision model** (`surface-regions.ts` is the prompt, the
   strict JSON schema and the parser). The model answers the one thing
   geometry cannot, *which* parts of the picture are flat surfaces and *what
   kind* (wall, floor, ceiling, sky, tabletop, ground, window), plus the
   horizon. It is not trusted with edges: the frame it sees carries a faint 10%
   grid, its answer is clamped and put in tl/tr/br/bl order, and every side is
   then **snapped onto a real straight edge** (below). A model that is three
   percent off costs nothing.
2. **Geometry alone**, used on its own when there is no model and as a second
   opinion when there is:
   - *Lines.* The frame is brought to about 180 px wide; edge points are the
     strongest ~11% of the gradient (threshold clamped to 14–48); a
     gradient-guided Hough transform (the one from ADR 0043, unchanged) gives
     up to 48 lines. Quads are the pairs of near-upright lines (within 25° of
     vertical, at least 16% of the width apart) crossed with pairs of
     non-upright ones (within 40° of horizontal, at least 7% of the height
     apart), intersected into corners, so the perspective is the surface's own.
     A quad is kept when every visible side lies on a real edge along at
     least half its length (mean at least 62%), with a **step** of at least 12
     grey levels between the two sides of the edge (a mortar line or plank
     seam is an edge with the same wall either side; a boundary between two
     surfaces is not), and, from edges alone, when it covers at least 8% of
     the frame.
   - *Smooth bands.* A band across the top whose row-mean gradient stays under
     4.5 grey levels (at least 10% of the frame) is "Sky or ceiling" (grey
     alone cannot tell them apart; a model label settles it); across the bottom,
     under 6 and at least 14%, "Floor or ground", given converging sides when
     a horizon is known.
   - *Horizon.* Where the weighted crossings of receding lines gather
     (`estimateHorizon`), or the model's answer.
3. **Perspective correctness.** `snapQuadToEdges` moves each side of a model
   quad onto the strongest Hough line within 6% of the frame's short side and
   10° of it that at least 45% of the side lies along; a corner never moves
   more than 10% of the frame. `convergeToHorizon` gives a floor, ceiling or
   ground region the model drew as a plain box (top and bottom within 8% of
   each other in width, nothing snapped) the sides such a surface really has: the
   near edge stays, the far edge is moved in along lines to the vanishing
   point on the horizon.
4. **Rejections, each with its reason** (returned as `rejected`): not convex,
   under 3.5% or over 93% of the frame, a corner under 22°, an edge across its
   inside (a strong supported chord of at least 30% of its diagonal, a step of
   at least 20: 0.6 or more means two surfaces, and 0.25 or more is not
   believed from edges alone), and no legible title fits.
5. **The title's rectangle.** A planar title fills the quad it is given, so the
   quad must have the title's shape: `titleAspect` is the widest line over the
   stack from the renderer's measured Cormorant advances (0.06 em tracking),
   and `fitTitleOnPlane` places a rectangle of that shape in the plane's own
   coordinates (the plane's homography), centred on the part of the plane that
   is on screen inside the safe area (3.5–96.5% across, 7–86% down: clear of
   the edge and the caption strip), up to 84% of the plane's width and 80% of
   its height, shrunk until the four corners are inside it. A line shorter
   than 39 px (2% of the frame) is refused: "THE QUIET ROOMS ABOVE THE LAKE AT
   DAWN" on a wall is not offered.
6. **Trackability is the tracker's own test.** `supportPoints` (Shi–Tomasi, at
   the tracker's 360×640) on the whole plane, and the share of the title's
   4×4 cells those points cover. At least 8 points and 25% coverage is
   `tracking: "surface"`; anything less is `"fixed"`. The surface a title
   fills is usually part of a larger wall, so tracking takes features from the
   whole plane (`TrackTarget.support`, ADR 0052's opt-in); the tracker's start
   gate and its per-frame coverage now judge the support region when one is
   given (they judged the part the title fills, which is blank on a blank panel
   of a textured wall). Nothing changes without `support`.
7. **Ranking.** total = (0.3 size + 0.4 texture + 0.3 fit) × wholeness + prior.
   Size is area/0.3 to the 0.6, 0.7× above 70% of the frame. Texture is points
   and coverage. Fit is legible line height (full score at 140 px), corner
   angles, plane shape, nothing in front. Wholeness is 1 − 0.9 × clutter, at most
   −60%. Priors: +0.04 to +0.10 for a model region, −0.12 for an edges-only quad
   when a model looked, −0.08 for a band when it did. Fixed surfaces rank 0.12
   lower. The first two are the best two; the third is the best of a kind not yet
   shown if it scores 0.4, so a sky can stand beside two walls.
8. **Style** (`surface-place.ts`, one place for the tap, the command and an
   agent): `style: "elegant"`, `font: "serif"`, no box, `size: 1`,
   `blend: "surface"`, `surface` = the title's rectangle, x/y at its centre, and
   the ink from the picture under it (`surfaceInk`): ivory `#f4eee2` or deep
   `#1b1915`, whichever contrasts more with the mean grey, with the strong
   shadow when the contrast is under 4.5 or the surface is busy (sd over 32).
   Posts, cut-outs and taps from an earlier placement are cleared.

### The tap (phone first)

`apps/web/components/editor/surface-picker.tsx`, inside the Pin sheet: **Put on
a surface** reads the frame the title starts on (through the frame service, so
fit, zoom and move are in it), sends one JPEG to
`POST /api/ai/surface-regions` (signed in, same origin, 30 looks a minute,
nothing stored), runs `findSurfaces` in the browser on the analysis frame and
draws the three candidates on the picture, numbered, with three 48 px buttons
("1. Wall · follows the camera · 12% of the frame"). A tap tracks it with the
existing Pin (`pinTitle`, whole shot) and writes everything in one
`updateText(surfacePatch(...))`, so **one undo**. The result is discarded if
the title's placement changed meanwhile (ADR 0047's version check).

### Fallbacks: never silently dropped

- A surface with nothing to follow is offered as "fixed: nothing to follow",
  and a tap places it in its perspective and says it will not follow the camera.
- If the tracker refuses ("Could not follow this surface: …", ADR 0052) the
  sheet shows its reason and a button, *Place it here without following the
  camera*; the title is not touched until a choice is made.
- No model (not configured, rate limited, unreachable): the edges alone are
  used and the sheet says so.
- No candidate at all: the sheet says what to do (another shot, a shorter
  title, the four corners by hand below).
- A photo has nothing to follow: placed, and said.

### The agent command

```jsonc
POST /api/reels/:id/commands
{ "command": { "type": "placeOnSurface", "textId": "t1", "clipId": "c2", "atMs": 5400, "pick": "wall" } }
// pick: "auto" (default) | "wall" | "floor" | "ceiling" | "sky" | "tabletop" | "ground" | "window"
// clipId defaults to the shot the title starts in; atMs to the title's start, kept inside the shot.
// { "dryRun": true } finds only: answers `surfaces` (candidates with plane, placement, tracking, ink,
//   reasons; what was rejected and why; whether a model looked and what it cost), tracks and saves nothing.
// Otherwise the answer also carries `surfaces[0].chosen` { kind, tracking: "tracked"|"fixed"|"failed", quality, notes }.
// placement.corners (8 numbers) sent by hand skips the search; so does a batch member that has one.
```

`placeOnSurface` is a core command (`Command`, in the registry the route accepts)
and is pure: it needs `placement` and writes `surfacePatch(placement)`; without
one it is refused with an explanation. The route (`lib/surface-command.ts`)
turns one without a placement into one with it: ffmpeg reads the frame and, for
a video, the shot (`lib/surface-server.ts`; `presentGray` in core draws a source
frame through the clip's fit, zoom and camera move, the analysis picture of ADR
0047), the model names regions, `findSurfaces` ranks them and the same tracker
code the editor uses (`trackTitleFromFrames`, lifted out of
`frame-analysis.ts` into core, `surface-track.ts`) follows the chosen one. A batch
resolves its surface commands in order; all land or none. The web image has
ffmpeg (the verification routes already need it); without it the answer is a 503
that says what to do instead.

### The vision call

Same `structuredAnswer` path as the room labels, the stock check and the
performance reference: no new provider. One 576×1024 JPEG with the 10% grid,
`imageDetail: "high"`, strict JSON schema `surface_regions`, at most 900 output
tokens. Instructions (abridged): portrait still from a real-estate or travel
video; mark flat surfaces where a line of large title text could be painted so
it looks part of the place; positions as fractions of the picture read off the
grid; corners tl, tr, br, bl following the surface's own edges (a slanted shape
for a wall seen from the side, not a box); choose the clear part, leave out
people, furniture, plants; only large, calm surfaces of at least a tenth of the
picture; at most six, best first; the horizon's y or null. The full text is
`SURFACE_REGIONS_INSTRUCTIONS` in `surface-regions.ts`.

**Cost per search, estimated, not measured** (no model key was available in
this work): about 1,300 input tokens (≈770 for the image at high detail, ≈520
for the instructions) and about 350 output. At the deploy's default
`gpt-6-luna` ($0.10 / $0.50 per million) that is about $0.0003; at
`gpt-6.1-sol` ($2 / $10, a short reasoning pass) about $0.01; at
`claude-opus-5-5` ($4 / $20, which always thinks) about $0.03–0.04. Every call
logs `surfaces: n regions, in/out tokens, $cost (model)` and the commands
route returns the cost, so the first live runs replace this estimate. The
geometry costs no tokens: about 0.1 s per frame on a desktop. Tracking on the
server costs ffmpeg and CPU only: 4–7 s for a 3 s shot here.

## Consequences

- A title goes from nothing to on-a-wall, tracked, in two taps and a few
  seconds, and an agent does the same in one request. The model decides
  *what is a surface*; real edges decide *where its sides are*; the tracker
  decides *whether it can be followed*. Each can be wrong without the others
  being fooled: a model quad on a blank wall is placed fixed, not "tracked".
- Sky is placed, not followed: it has no detail, and the tracker refuses to
  borrow features from elsewhere (ADR 0052's rule, kept). A sky that follows
  the camera needs far-field tracking (the rotation-only homography of the
  distant ridge applied to the sky quad); the support rule above is the first
  step but today support must contain the title's area.
- Without a model the edges alone find walls bounded by real edges and smooth
  bands, and little else in a busy interior (see "What failed").
- `placementVersion` is unchanged; a placed title is an ordinary surfaced,
  pinned title, so Check mode, the corner handles, posts and the retention
  critic work on it as before.
- No migration, no schema change (fields were added to a TypeScript command
  and a client type only).

## What was verified

Unit tests (all in `pnpm check`):

- `packages/core/tests/surface-finder.test.ts` (21): placement rectangle has
  the title's aspect in the plane's own coordinates, inside the safe area, and
  a long title or a sliver is refused; ink flips on luminance and asks for the
  strong shadow on mid grey and on a busy surface; a model quad two percent off
  is snapped within 1.4% of the true corners of a surface in perspective; a wall
  in perspective is found from edges alone (corners within 3%, far edge shorter
  than the near, `surface` tracking, title inside it); ranking puts a large
  textured surface above a small one; a blank panel is "fixed" and is dropped
  with `keepFixed: false`; a bright band is a fixed sky; a blank frame gives
  nothing and does not throw; tiny, whole-frame and bow-tie regions are rejected
  with their reasons; a plain-box floor converges on the horizon (its sides
  collinear with the vanishing point), a converging one, one that crosses the
  horizon and a thin one are left alone, a ceiling converges upward; the
  horizon is recovered from receding lines; `pickCandidate`.
- `surface-track.test.ts` (9): even sampling, speed and start offset, a title
  too brief; `presentGray` for Fill, Fit (flat grey bars) and zoom against the
  source's own pixels; a moving textured wall is followed to within 1.5 px of
  19 × 1.2 px of travel, `support` follows a title on a blank panel of a textured
  wall that fails without it, and a flat frame is refused with "Could not follow
  this surface".
- `surface-place.test.ts` (10): the command is in the registry; it writes serif,
  no box, surface blend, ink, centre, and clears posts and taps; with a track it
  writes path, pin and the shot's span; it lands in a batch as one step; it is
  refused without a placement (the message points at the route), for a missing
  text and for malformed corners or ink; `parseSurfaceRegions` orders, clamps,
  trims, drops what cannot be used, keeps six, and the schema is strict.
- `apps/web/lib/surface-command.test.ts` (8) and `surface-service.test.ts`
  (10), with the pixels and the model stubbed: dry run answers candidates and
  tracks nothing; clip and time defaults; 400s that name the problem (unknown
  text or clip, `atMs` outside the shot), 404 for media without a size, 503
  without ffmpeg; a batch keeps its order; a surface with nothing to follow is
  placed fixed and never reaches the tracker; a tracker refusal falls back to a
  fixed placement with the tracker's reason, and the corners are kept; photos
  and `track: false` are not tracked; `pick` takes the kind asked for or says
  what the frame shows; the model failing does not stop the edges.
- `surface-picker.test.ts` (3): the entry point renders in the Pin sheet above
  the manual corners, is absent without `onPlaceOnSurface`, and is disabled with
  its reason when the title is not over a shot.
- Existing `track`, `track-editor` and `track.benchmark` tests pass unchanged
  after the tracker's orchestration moved to core and `support` was judged
  where its features are.

On real footage (the snow reel's Pexels clips and the D4 villa clips, ffmpeg
frames at 360×640, the very code the route runs, `apps/web/scripts/surface-sheet.mts`
and `surface-verify.mts`):

- `assets/0075-surfaces.png`: 8 frames from 8 clips (aerial lodge, alpine
  chalet with sky, red cabin in snow, mountain window, villa living room,
  corridor, stairs, bedroom): 14 candidates, 90 ms a frame on average, each
  drawn as its plane (dashed) and the title's rectangle (filled), labelled
  "follows" or "fixed". **The model's labels on this sheet are hand-typed
  stand-ins** (`assets/0075-standin-regions.json`, rough on purpose, the kind
  of corners a model gives), not model output: no key was available.
- `assets/0075-surfaces-edges-only.png`: the same frames with no labels at all.
  This is the honest floor.
- `assets/0075-tracked.png` and `0075-tracked.json`: the best candidate on six
  clips, tracked through 3 s of the shot and drawn at the start, middle and end.
  Aerial lodge (ground, tyre tracks): good, confidence 0.98. Red cabin (plank
  wall): good, 0.91. Window view (hillside through the pane): good, 0.99, the
  quad moves with the pan. Alpine chalet sky: placed fixed (0 points of detail).
  Villa bedroom ceiling: placed fixed (10 points, 13% coverage). Villa corridor
  floor: tracked, **lost 1.8 s in** as the camera turns, so the title fades
  there (the sheet draws the held corners; the real title is hidden, o = 0).
- `assets/0075-rendered.jpg`: the window and the lodge placements written into
  a timeline with `surfacePatch` and drawn by the real composition
  (`packages/render/scripts/surface-stills.ts`, Remotion): the house serif,
  ivory ink, surface blend, on the hillside and the tyre-track circle, moving
  with the footage across start, middle and end.

## What failed or is not done

- **No live model call was made**: no key on this machine. The prompt, schema,
  parser, rate limit and cost log are written and unit-tested against stubs;
  the answer quality of a real model on the gridded frame is unmeasured, and the
  cost above is arithmetic. The stand-in labels are easier than a model's will
  be. First job after deploy: run `dryRun` on three reels and read `vision`.
- **Edges alone are weak in busy interiors.** On the unlabelled sheet it finds
  the window's hillside, a bedroom ceiling and floor band, a snow forecourt,
  and little else; it misses the blank cream wall behind the sofa and the
  corridor walls; the stairs frame gives nothing. A second review round on the
  edges-only quads is the model's job.
- **Sky does not follow the camera.** Placed fixed only (see Consequences).
- **Sky versus ceiling** from grey alone is "Sky or ceiling"; only a model label
  separates them.
- **The editor UI was not exercised in a browser** (no dev server or Playwright
  run here): the picker's flow is covered by typecheck, the markup test and the
  shared core, and the tracker refactor by the existing tracker tests, but the
  tap, the SVG overlay on a phone and `frameService` at 576×1024 are unseen.
- Server tracking reads the library's media URL with ffmpeg; it has not been
  run against the deployed CloudFront or a presigned URL.
- A title that runs across a cut is tracked on the shot it was placed in only
  (as before, ADR 0039).
- The render check is five stills, not an encoded video.
