# 0090 - Motion-hidden cuts, rebuilt the reference way, and recipe 5 ("a day at")

Date: 2026-10-26

## Context

The owner sent five reels whose editing he loves; they were measured frame by frame in
`ReelWalk-hybrid/output/references/` (report.md, recipes.json, capabilities.md).

**Motion-hidden cuts.** In reels 1, 2 and 4, 37 of the 88 shot changes are hidden inside camera motion (capabilities gap #1). On the
same morning we had retired our own versions (ADR 0082): the whip (ADR 0028/0083) and the speed-ramp transition
(ADR 0073/0074).

The owner's decision: "you can bring it back but it's gotta look nice — ours looked and sounded bad."

| | What ours did | What the references do (measured) |
|---|---|---|
| Blur | An 8-frame smear centred on the cut | Directional, along the actual motion vector |
| Footage | Clips with little real motion | The join sits inside real fast camera motion; flow is 4–26× the reel's median after the join |
| Speed | — | The incoming clip starts fast and eases to 1×, so the ramp is on the incoming side only |
| Sound | An automatic whoosh | Music only |

Re-measured here in reel frame widths a second:
- The references' incoming side runs 0.3–2.4 after a blur-masked join, against a reel median of 0.02–0.04.
- The outgoing side runs 0–3.3.

**Recipe 5, "a day at"** (reel 5, DZThJZ5Sa3Z, music only). It needs:
- beat-locked cuts (71 % within ±70 ms);
- wides alternating with details;
- a median shot of 1.64 s, with 3–6 s payoff holds;
- golden hour giving way to dusk;
- the reveal, the house lit at dusk, landing as the music returns after a break (gap #6);
- tiny, calm, centred type (cap height 1.25–2 %);
- one grade.

The song-section analysis (ADR 0059) finds intro, build, drop and outro, but nothing finds a stop followed by a return.
Nothing orders clips by time of day (gap #7).

## Decision

### `motionCut`: a hard cut inside real motion, refused otherwise

**Schema (additive).**
- `TRANSITIONS`, the kinds a person or the AI may pick, is unchanged.
- A new `MEASURED_TRANSITIONS = ["motionCut"]` joins it in `SAVED_TRANSITIONS`, which the clip schema accepts.
- `clip.motionCut` holds:
  - the measured motion either side (`out`, `in`: dx and dy in reel frame widths a second, zoom in scale growth a second);
  - the ease-out (`rampFrom`, `rampFrames`);
  - the clip's speed and ramp from before the cut (`base`).
- Without that record, a `motionCut` clip draws as a plain cut.
- The retired `whip` and `speedRamp` still read as `cut` (`migrateTransition`), and nothing offers them.

**Made only from measurements (`packages/core/src/motion-cut.ts`).**
- `judgeMotionCut` offers the cut only when both sides move at least **0.3** reel frame widths a second at the cut. The references' slowest incoming side after a join measured 0.3, and a zoom counts as half its rate, as in ADR 0086's `magnitude`.
- The incoming side must also reach 0.6 at its ramped first frame.
- The directions must be ones the eye can follow:
  - two pans or tilts within 60° of each other;
  - push into push, or pull into pull;
  - a pan resolving into a push (reel 1, 12.51 s).
- Turns are refused, because an orbit has no single blur direction.
- Every refusal names the measured speeds and says to keep the hard cut on the beat. **The refusal is what separates this from the retired whip.**
- Flow comes from ADR 0086's sample contract (`samples[].flow {dx, dy, zoom}` in source frame widths a second).
  - `flowNear` reads the 300 ms of each clip next to the cut.
  - `reelFlow` scales a cover-cropped landscape source to the reel's frame: a 16:9 clip moves about 3.2× faster across the 9:16 crop than across its source.

**The ease-out runs through the clip's own speed ramp (ADR 0067).**
- The incoming clip plays from `rampFrom` (2.5×) down to 1× over `rampFrames` (8) frames on a quadratic ease-out, written as ramp keys.
- Its `speed` becomes the curve's mean, so the tail plays at exactly its earlier speed.
- Its source window grows by what the ramp eats, so its length on screen, every later cut and every title stay put.
- When the source has too little footage after the clip, `rampFrom` eases down in 0.25 steps to 1.5. Below that, the cut is refused.
- Every reader of a clip's source time (`mediaWindow`, the frame service, pacing) already follows `clip.ramp`.
- The clip's own sound fades where the ramp runs fast (`rampGain`), and the music is untouched. Nothing is time-stretched across the cut's audio.
- **No sound is added.**

**The blur follows the measured vector (`cutBlurAt`, drawn by `render/src/reel/motion-cut-blur.tsx`).**
- **Sizing.** A frame moves `speed × width / fps` px, and a 180° shutter blurs half of that. The incoming side adds:
  - what the ramp's extra speed would have smeared (the footage already carries its native 1× blur);
  - plus one native blur at the join, fading over four frames, so the blur eases off with the ramp rather than stepping.
- **The outgoing side keeps its own blur.** It adds only half, then one, native blur on its last two frames, along its own vector.
- **Ceilings:** a 42 px sigma at 1080 wide, and a zoom spread of 0.14.
- **Drawing:**
  - A pan within 12° of an axis is one anisotropic `feGaussianBlur` with duplicated edges.
  - A diagonal turns the layer onto the motion's angle, blurs along it, and turns back, scaled by three sigmas so the corners never read clear.
  - A push or pull uses ADR 0074's zoom blur (`zoom-blur.ts`, brought back from history unchanged): chained `feDisplacementMap` stages.
- **Same in Player and export.** It is all SVG filters through CSS `filter: url(#…)`, which the phone Player and the worker's Chrome draw the same way. There is no WebGL and no HTML-in-canvas path.
- The layer is always mounted the same way, so the video under it never remounts.

**The 12-frame cap (ADR 0083) holds, and the series is untouched.**
- A motion cut uses no `TransitionSeries` overlap: `planCuts` reads it as `none`. Each clip blurs its own frames: 2 outgoing and at most 10 incoming (8 by default).
- So the cut stays on its frame, nothing is borrowed from handles, and the whole effect spans at most 12 frames.

**Reachable two ways:**
- **Command:** `setMotionCut { clipId, motion?: { out, in }, analyses?: { [assetId]: { samples, width, height } }, rampFrom?, rampFrames?, on? }`. The HTTP commands route (`POST /api/reels/:id/commands`, ADR 0048 registry) accepts it.
  - Without `motion` it reads the ADR 0086 `analyses` at the cut.
  - `on: false` takes the cut off and gives the clip its speed and ramp back at the same length.
- **Guards:** `setTransition` and `updateClip` refuse `motionCut` (pointing to `setMotionCut`). Choosing another transition first takes a motion cut off.
- A duplicate or a split piece never inherits the record.

### Recipe 5, "a day at", as a planner preset (`packages/core/src/a-day-at.ts`, `reentry.ts`)

**`planDayAt(base, shots, music, lines, newId)` → `{ timeline, report }`:**
- **Cut beat.** The song's beat, halved or doubled into 600–1000 ms. Every shot is a whole number of cut beats from frame 0. The opening shot is one beat, as reel 5's 0.84 s.
- **Shot lengths.** Ordinary shots follow a pattern of 2, 1, 2, 2, 3 … beats (median about 1.5 s at 80 BPM). The reveal holds about 4.4 s and the last shot about 5 s.
- **Order.**
  - Day, then golden hour, then dusk; wides and details alternate within each light.
  - An empty sky plays in the music's break (at most four beats).
  - The reveal follows: a shot marked as the reveal, else the brightest dusk wide.
  - Then the rest of the dusk shots, ending on a held shot.
- **Time of day** is the caller's tag (an analysis, the director, the agent). Without one it is guessed from the clip's ADR 0070 colour statistics (luma and V−U warmth), and the report says so.
- **Without dusk footage** it makes the reduced "daylight" variant and says it will not feel like the reference's payoff.
- **Day→dusk blend** (gap #7, lite): a soft dissolve only between neighbours that share a `framingKey`.
- **The song is placed so its return lands on the reveal's first frame.** The return is snapped to the nearest half beat of the stored grid, and the cuts follow its phase.
  - On the proof track ADR 0059 stored a beat phase half a beat off: 395 ms against the audio's measured 20 ms. The return corrected it, and the report notes the move.
  - The song starts at full level.
- **Lines.** Two lines, both in the elegant serif, upper case, white, centred at y 0.49, with a slow fade and a soft shadow, crossing cuts:
  - the credit at about 1.9 % cap height, from 0.5 s;
  - the place line at about 1.4 %, over the land.
- **Grade.** One warm grade (`filter: "warm"`) on every clip. No colour match, so dusk stays dusk.
- **Joins and sound.** Hard cuts, clips silent, no effects.
- **Command:** `dayAt { shots: [{ clipId, role, phase?, reveal?, sky?, bestStartMs?, framingKey? }], music: { assetId, bpm, beatOffsetMs, durationMs, energy, sections?, drop? }, lines? }`.

**`findReentry` (gap #6)** finds where a song comes back, from ADR 0059's stored energy curve:
- **A break.** A stretch at least 1.5 s long whose one-second average sits at least 0.1 below the song's loud level (the 75th percentile), after loud music. Hits of up to 1.5 s inside it do not end it, because a breakdown keeps hitting.
- **The return.** The steepest half-second-over-half-second rise near the break's end, which must hold above the quiet level for two seconds.
- **Fallbacks.** The biggest step into a drop among the song's sections, refined to the steepest rise within 2.5 s of the bar line (sections start on estimated bars). Then the analysis's own drop.
- **Why the curve is hard to read.** It is normalised over the whole track, including its fade-out, so a 35 dB breakdown reads only as 0.91 → 0.5–0.75. Hence the averaged, relative thresholds.

## Verification

**Unit tests:** `packages/core/tests/motion-cut.test.ts` (15) and `a-day-at.test.ts` (11) cover:
- the gate: refusals for slow footage, opposite directions, push into pull and turns;
- the landscape crop factor;
- the ease-out keeping the tail at 1×, the length on screen, and every frame inside the media window;
- the gentler start on tight footage;
- blur sizing, its decay and caps;
- the command, the guards and taking the cut off;
- the retired kinds round-tripping;
- break detection: a quiet intro is not a break, a breakdown's stabs are seen through, ordinary dynamics are not a break;
- the planner's order, lengths, lines, grade, variants and blend.

`packages/render/tests/zoom-blur.test.ts` keeps ADR 0074's filter tests and the new chained-filter helper.

**Real footage, real renderer.**
- **Script:** `packages/render/scripts/recipe-proof.ts`, at 720p. The media is not committed; see `docs/licences/recipes-2026-10-26.md`.
- **Analyser:** flow and colour came from a local stand-in (Farneback flow on 180×320 frames in ADR 0086 units, plus ADR 0070 YUV statistics), not from the worker's analyser, which is not merged (#249).
- **Song:** analysed by core's own `analyseAudio`, as an upload is.

**"A day at"** (14 clips from one Alef Morais shoot; Sub_Clair, "R&B Instrumental"):
- 27.0 s long, 13 picture changes, median shot 1.5 s, reveal held 4.5 s, last shot 5.25 s.
- Day → golden → beach at sunset in the break → the villa lit at dusk on the music's return at 17.25 s (song 84.02 s) → lit pool.
- **Beat hits on the rendered file: 13 of 13 within ±70 ms (100 %; chance 19 %).** Offsets were −5 to +12 ms.
  - Method: an 80 BPM comb-fit tempo and phase measured from the export's own soundtrack, with every change confirmed in the picture.
  - The references' autocorrelation script reads this song at 161.5 BPM where the comb fits 160 ten times better, so its own figure (7 of 13) is a tempo artefact.
- The reveal lands 64 % of the way in (the reference: 43 %). Only two dusk clips exist, so the dusk section is short.

**Motion-cut walkthrough** (8 clips, 18.0 s; Ruiz_, "Frank Ocean type beat"):
- **Motion cuts made (3):**

  | Cut | From → to | Measured speed (reel frame widths/s) |
  |---|---|---|
  | 1 | infinity-pool house pan → Kuta villa pan (content left) | 0.36 → 0.47 |
  | 4 | beach house tilting up → courtyard tilting up | 1.69 → 2.16 |
  | 5 | courtyard → resort aerial (content down) | 1.85 → 0.34 |

- **Refused (4), with the gate's reasons:**
  - a left pan into a right pan (177° apart);
  - into an aerial at 0.11;
  - into a near-still aerial at 0.01;
  - a slow pull (0.27) into a pull. Allowed at 0.25 in the first render, it drew a near-invisible radial blur, which is why the floor moved to 0.3.
- **Beat hits: 7 of 7 changes, motion cuts included, at +10 ms (120 BPM; chance 28 %).**
- The references' hard-cut detector found none of the motion cuts as cuts, the same blind spot it had for the references' blur-masked joins.

**Frame strips and the side-by-side.** Each motion cut has a strip of 8 frames either side, and a side-by-side puts reels 1 and 2's blur-masked cuts against ours at the same scale. The outputs are in `ReelWalk-hybrid/output/recipes/` and on CloudFront under `samples/recipes-2026-10-26/`. The honest reading:
- Cut 4 is a real cousin of the references' joins.
- Cut 1 reads as a clean directional cut.
- The references' outgoing frames are already smeared 3–4 frames before the cut, because their FPV footage carries heavy native blur. Ours stay crisp because this stock footage has little, and the blur is never faked beyond the real speed.

## Consequences

- **`motionCut` is not in any menu.** Its gate needs ADR 0086's shot facts in the editor. Until #249 merges, the commands route does not fill `analyses` itself: a caller sends `motion` or `analyses`. **Follow-up:** offer "Hide in the motion" on the cut sheet only where the gate passes, and fill `analyses` from `MediaAsset.shotAnalysis` in the route, as `syncTextToSpeech` fills transcripts.
- **Cut grammar (#248, ADR 0087)** names a technique per cut. When both merge, `motion` there should map to this kind, and its planner should ask this gate before choosing it.
- **The person and object mattes** drawn above titles (`AtCuts`) are not blurred on a motion cut's frames. A presenter in front of a title across a motion cut would stay sharp for at most three frames.
- **ADR 0059's beat phase** can sit half a beat off: 395 ms against 20 ms measured on the proof track. The planner corrects it from a hard return. Other planners do not, and that deserves its own fix in `detectBeatsFromOnsets`.
- **"A day at" needs footage the recipe assumes.** A lit-house dusk shot, an empty sky, and details as well as wides. The planner reads roles and time of day from its caller, and reports the colour guesses it had to make.
