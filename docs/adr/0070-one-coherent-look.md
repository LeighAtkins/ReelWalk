# 70. One coherent look: colour match, stock sets and a licence trail

Date: 2026-10-22

## Context

Reels built from stock read as stock. Three creators' houses sit in one
reel, each graded "warm" or "cool" from a preset, so the colour jumps at
every cut: the presets add the same cast to pictures that never agreed to
begin with. The owner's direction for wave 3 is retention, and one
coherent look is part of it.

Sourcing took half of every build in the 1000-views series. Agents
scraped Pexels through a browser looking for one coherent place with no
people and no watermark, downloaded by hand, and nothing recorded where a
clip came from or under which licence. The venue builder already searched
Pixabay server-side (ADR 0013), kept the page URL, licence and credit on
the `MediaAsset`, and nothing else in the app could reach that.

Instagram recommends original work. A stock clip posted as downloaded is
not that, and the critic (ADR 0062) had no way to tell.

## Decision

### Colour match, in core and the shared composition

`packages/core/src/look.ts`, pure:

- `colorStatsFromRgba` measures the mean and standard deviation of Y, U
  and V (BT.601, sRGB units) over a frame; `mergeColorStats` pools a
  clip's frames. The clip keeps its statistics as `clip.colorStats`, so a
  strength change or a new reference never reads pixels again.
- `matchTransform(source, reference, strength)` is Reinhard-style colour
  transfer per YUV channel (shift the mean, scale the spread, gain clamped
  to 0.5..2 so a flat clip is not pushed into noise). YUV is a linear map
  of RGB, so the three per-channel affine matches compose into one 3×3
  matrix and offset in RGB: `clip.colorMatch = { m, o }`. Matching U and V
  means is also a white balance. Strength interpolates the matrix towards
  the identity.
- `matchLook` is a document command (ADR 0048): `{ type: "matchLook",
  referenceClipId?, strength?, stats? }`. It writes any given statistics
  onto the clips, records `timeline.look = { referenceClipId, strength }`,
  and gives every measured clip the transform onto the reference's
  statistics. `referenceClipId: null` clears everything. The reference and
  unmeasured clips carry no transform. Nothing is retimed.
- `lookDistance` is the RMS of the mean differences, for the sheet, the
  API and tests; 0.03 shows at a cut.

The composition applies the match as an SVG `feColorMatrix` per clip
(`ColorMatchFilter` in `ReelComposition.tsx`), referenced from the media's
CSS `filter` before the preset grade (`clipFilterCss`), with
`color-interpolation-filters="sRGB"` because the matrix was fitted to sRGB
statistics. The preview, the worker, and the person and object mattes draw
the same matched picture; no shader, no per-pixel work. The existing
grades keep working on top, as the brief asked.

### Where the thumb finds it

On a clip's Look sheet, under the grade strip: "Match every clip to this
one". The clip the sheet is open on becomes the reference, which is how
the thumb picks it. The editor reads three frames of every flat clip's
window (`components/editor/look-measure.ts`, 15/50/85 % of the window, the
source itself with no fit, zoom or grade) and runs one `matchLook`. Once
the reel has a match the sheet shows a strength slider (one gesture, one
undo step while the sheet is open) and "Stop matching". 360 photos are a
camera sweep, not one picture, and are left out (`matchableClips`).

### Over HTTP

- `GET /api/reels/:id/look`: the reference, the strength, and each clip's
  distance from the reference.
- `POST /api/reels/:id/look { referenceClipId?, strength?, stats? }`: runs
  `matchLook` on the saved reel and bumps its revision. Clips without
  statistics are measured on the server from their poster
  (`lib/look-measure.ts`, sharp, one frame; the response says
  `framesPerClip: 1` and lists `unmeasured`). An agent that has read frames
  itself passes `stats` by clip id instead.

### Coherent stock search

`GET /api/stock/search?q=&group=creator` (`apps/web/app/api/stock/search`):

- Pixabay, through the key the deployment already has (`PIXABAY_API_KEY`;
  the ops tfvars hold no Pexels key, and none was added). Results are
  cached per instance for a day as Pixabay asks.
- Filters, cheapest first: `portrait` (default on; Pixabay has no
  orientation filter for video, so it is applied after), `minMs`/`maxMs`,
  then `people=0` and `text=0` (default on) by tags, then by frames.
- Frame checks (`lib/stock-check.ts`): the same `structuredAnswer` vision
  path the identity gate and room labels use looks at up to three frames
  of each surviving clip (the poster, plus two decoded from the smallest
  rendition with ffmpeg where one exists; the web image has none, so there
  it is the poster alone) and answers people / burnt-in text or watermark
  / the place in a few words. At most 24 clips per search are checked.
  Every clip carries `checks` with `framesChecked`, so a caller and the
  Stock tab can tell a verified clip from a tag-filtered one ("unchecked"
  chip). Without a model the tags decide.
- Grouping (`groupStock` in `packages/core/src/stock.ts`): by creator,
  then into shoots. Stock sites have no location field, so one place is
  inferred: a creator's clips whose tags overlap (Jaccard ≥ 0.34) or that
  were uploaded together (ids within 200 of each other, any tag shared) are
  one set. The label is the checked place when there is one, else the
  shared tags. Larger sets first, so one tap adds the most footage of one
  place.

`POST /api/stock/import { ids }` (at most 12) copies a set into the
library through `lib/stock-import.ts`, which the venue builder now uses
too. Add media gets a "Stock footage" segment (`components/editor/stock-picker.tsx`):
search, sets with a thumb strip, "Add the set", or tap clips across sets
and add those. Imported clips land on the end of the reel.

### Licence record

Nothing new is stored. An imported stock asset already carries `sourceUrl`
(the clip's page), `license`, `attribution` ("Video by X on Pixabay") and
`createdAt` (the import time). `stockSource(asset)` reads those back into a
`SourceRecord` { source, id, creator, url, license, importedAt }, and every
`LibraryAsset` now carries it as `source` (null for your own uploads).
`GET /api/reels/:id/sources` lists a reel's stock clips once each with the
clips that show them and the caption lines (`sourcesCaption`). The export
page shows "Sources" when the reel uses any. No migration.

### Transform check

`transformScore(clip, { texts, clipStartMs, sourceDurationMs })` in core is
a weighted sum, capped at 1, of how a clip differs from its file: recut
(how much of the source was cut away), speed, grade, colour match, zoom,
move, a title over it (more with particles), transition in, lens
softness. `untouched` is set below 0.25. `untouchedStockClips(timeline,
isStock, durations)` names a reel's stock clips that went out as
downloaded; the sources route returns `transforms` per clip and
`untouched`, which is what the critic (W3-F) consumes.

## Consequences

- Saved reels are unchanged: `colorStats`, `colorMatch` and `look` are
  optional additions to the v1 schema; a reel without them renders as
  before.
- A match fits means and spreads, not a full histogram: it removes the
  cast and exposure jump at a cut, which is what shows. It cannot make a
  night shot look like day, and at strength 1 a very flat clip only gets
  the clamped gain.
- Clips added or retrimmed after matching keep their old transform (or
  none) until "Match every clip to this one" is tapped again, which
  re-measures everything. The server route measures from one poster frame,
  the editor from three frames of the window; the two can differ on a
  clip that changes a lot.
- The frame checks cost one vision call per clip (24 per search at most)
  and are only as good as the model's answer; a tag-only result is
  marked, not hidden. Grouping by tags and ids is a heuristic: a creator
  who tags everything the same way becomes one set.
- Pixabay only. Adding Pexels means a key in ops and a second adapter in
  `lib/stock.ts`; the core module is already source-neutral.
- `transformScore` weights are a judgment, not a measurement of
  Instagram's rule; the critic should treat `untouched` as a prompt to
  edit, not a verdict.

## What was verified

- `packages/core/tests/look.test.ts` (12 tests): statistics of synthetic
  casts, transparent-pixel skipping and striding, frame pooling; the match
  moves a source's means and spread onto the reference within tolerance,
  is the identity at strength 0 and halfway at 0.5, clamps the gain on a
  flat source, writes a valid `feColorMatrix`; the command matches every
  measured clip and keeps the grades, re-runs on a strength change without
  new statistics, clears, changes the reference, rejects an unknown or
  unmeasured reference and leaves the reel untouched, leaves an unmeasured
  clip alone; sample points.
- `packages/core/tests/stock.test.ts` (11 tests): grouping by creator and
  shoot, consecutive uploads, checked-place labels; tag and check filters,
  portrait and length; the licence record off an asset, a reel's sources
  and caption; `transformScore` zero for an untouched clip, adding up and
  capping, counting a colour match, and `untouchedStockClips`.
- `apps/web/lib/look-strip.test.ts`: three synthetic rooms of one scene,
  "warm", "cool" and "flat", decoded with sharp as the server does, matched
  to the warm one and measured again: distances fall from 0.06–0.10 to
  under 0.012 and the luma spread comes to the reference's. With
  `LOOK_STRIP_OUT` set it writes the before/after strip,
  `docs/adr/assets/0070-look-strip.png`.
- `pnpm check` (lint, typecheck, tests) green; see the PR for the run.
- Not run: the editor against a browser (the Look sheet, the Stock tab and
  the export page were typechecked and lint-clean but not driven by hand
  here), the stock routes against the live Pixabay API and vision model,
  and a worker render of a matched reel. The composition change is a CSS
  filter on the same elements the grades already filter, which the
  worker renders with Chromium as the preview does.
