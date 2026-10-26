# 0089 - Keyword lockups from speech

Date: 2026-10-26

## Context

The owner judged our automatic edits as lacking taste ("I don't feel like any choices have made it in better taste")
and sent five reels whose editing he loves. They were measured frame by frame (ReelWalk-hybrid
`output/references/report.md`, `recipes.json`, `capabilities.md`). Four of the five are voice-led, and they carry their
message the same way: per spoken phrase, **one keyword set huge** (capitals 7–14 % of the frame's height) in the scene,
often behind the presenter's head, while **every other word is a small single-word caption** that replaces the previous
one as it is said. `capabilities.md` ranks this as gap #2. Owner decisions the same day: voice-led reels are the
direction; a coloured, gradient or textured hero keyword is allowed while body and caption text stay white; no
letter-spacing reveal (`trackIn`) as a default; no boxed text; never zoom into an empty frame.

The parts existed but nothing assembled them: word-timed transcripts per clip (ADR 0035), speech-timed titles
(`syncTextToSpeech`, ADR 0084), word-by-word kinetic type (ADR 0061, cumulative, not replacing), the person matte
(`behind`, ADR 0039) and the presenter's face box from the identity gate (ADR 0056/0057). Missing: a caption track where
each word replaces the last, a keyword larger than a title may be (size ≤ 2.5 is a cap height of about 4.9 %), the
reference's arrival, a fill for the hero word, and a picker that decides which word is the keyword and where it goes.

### What reel 3 does, measured (DerRQWgo8yn, the "one question" recipe)

- Keywords: "Before" 7.5 %, "yourself" 6.5, "trust" 8, "difficult" 10, "BEST" 9 (cap height). Median 8 %; centred
  on her, y 0.30–0.43; her head covers the bottom 30–40 % of the capitals (person matte).
- **Arrival**, read from 30 fps frame strips of the downloaded reel (`work/a0.jpg`, `a9.jpg` in the recipe folder): the
  keyword's first visible frame is one frame (33 ms) before the spoken onset; it comes out of a blur at low opacity and
  is sharp 170–200 ms later. No drift, no letter-spacing change, no scale pop (the first lockup also rides the opening
  scale-out of the whole frame). It leaves on the cut at the sentence's end.
- Captions: 2.5–2.75 %, italic sans, white, one word at a time, cut on at the onset (no fade), held 300 ms after the
  last word.

## Decision

**One command, `composeKeywordLockup`**, backed by a pure module (`packages/core/src/keyword-lockup.ts`), additive
schema, and three small renderer pieces.

### The composer

For each chosen clip (default: every clip whose sound has words), the clip's words in reel time
(`spokenWordsOfClip`, which follows trims, speed and J-cuts) are cut into **phrases**: at `. ? !` or a 0.5 s pause; a
sentence longer than 2.6 s also at its commas (reel 3's lockups last 1.5–2.6 s). Whisper noise (`["The`) is dropped.

Per phrase:
- **Keyword.** A word in `keywords` (any case; it is set as written there, since whisper capitalises at random) wins;
  otherwise the default pick: numbers and number words first, then the phrase's last content word (English end-focus),
  longer and more drawn-out words ahead of short ones, a mid-sentence capitalised word as a proper noun; never a
  function word. `keywordsOnly` gives phrases without a listed word no keyword.
- **Size.** Capitals `capHeight` of the frame (default 0.085; 0.05–0.14), shrunk until the word fits between the safe
  area's left edge and the button column (x 960 px), measured with the renderer's Playfair advances
  (`estimateLineWidth`).
- **Place.** Centred on the presenter's face (x), with the baseline set so the head (the gate's face box plus 28 % for
  hair) covers 35 % of the capitals; clamped under Instagram's header and above y 0.72. The face box is mapped through
  the clip's fit, zoom and camera at the phrase's time (`clipPicture`, so an opening scale-out or a punch-in is
  followed). No face known: the reference's place, y 0.37 centred. `placements` overrides by keyword.
- **Look.** The elegant style (Playfair) at weight 600, white, soft shadow, `behind: true`; `fill` gives a gradient or
  picture instead (hero word only); `brandStyle` sets a brand kit style's face (ADR 0078) at the same pixel size.
- **Timing.** On at the onset − 40 ms with `blurQuick` (8 px → sharp in 200 ms, no drift, out in 150 ms); off 250 ms
  after the phrase's last word, never past the next phrase's first caption or the clip's end.
- **Captions.** Every other word, in one title with `kinetic.preset: "caption"`: each word cut on 40 ms before it is
  said, replaced by the next; it goes when the keyword is said (the big word takes over) or 300 ms after it ends in a
  pause. Archivo 600 italic, size 1 (about 2.75 %), white, soft shadow; under the chin (face bottom + 35 % of the face),
  clamped into the safe area.

`cta: { keyword, caption? }` adds a closing keyword after the last phrase, held to the end of the last composed clip
(the reference ends on its call to action). Composing again replaces the lockups on those clips (every lockup title
carries `lockup: { id, role }`), and leaves other titles alone; `remove: true` takes every lockup off.

### Schema (all optional; saved reels parse and render as before)

- `text.kinetic.preset: "caption"` and `kinetic.wordsOffMs` (per-word exit, caption only).
- `text.animation: "blurQuick"` (also offered in the text sheet as "Quick blur").
- `text.fill`: `{ kind: "gradient", colors: 2–4 hex, angle? } | { kind: "image", assetId }`.
- `text.italic`, `text.weight` (300–900).
- `text.lockup: { id, role: "keyword" | "captions" }`.
- `size` may reach `KEYWORD_SIZE_MAX` (7.2, capitals ≈ 14 %) **only** on a lockup keyword (a refinement on the text
  schema; `maxTextSize(text)` is used by `updateText` and the editor's size controls, so moving a keyword keeps its size).

### Rendering (Player and export share `ReelComposition`)

- A caption track draws only the word on screen (`captionWordAt`, pure, in core); the scene evaluator sizes and fits a
  caption title as its widest word (`fitScreenTitle`, `screenTitleExtent`), so it is not re-centred as if it were the
  whole phrase, and the critic's UI-zone checks see the drawn box.
- `blurQuick` is a toolbox reveal (`title-reveal.ts`), drawn by `RevealFace` like `blurIn`.
- Fills are CSS `background-clip: text` (no WebGL); a text shadow would paint over the clipped fill, so a filled word
  gets one light `drop-shadow` instead. A picture fill holds the frame (`delayRender`) until the image has loaded.
- Archivo italic is bundled (`@fontsource-variable/archivo/wdth-italic.css`, SIL OFL 1.1) and loaded before an italic
  title is drawn.

### Reachable by agents

`POST /api/reels/:id/commands` and the MCP `apply_commands` tool accept `composeKeywordLockup` (it is in
`COMMAND_TYPES`); the route fills in the library's transcripts (`speech`) and the identity gate's face boxes (`faces`),
and both answer `lockups` (`describeLockups`: each phrase's keyword, its place and cap height, its caption words), with
`dryRun` too. The MCP command sheet documents it.

## Consequences

- A talking-head reel gets the reference's type system in one call; the director or an agent can choose the keywords
  (`keywords`) and keep the timing and placement.
- Captions are one title per phrase, not one per word, so a 20-second talk stays far below `MAX_TEXTS` (50).
- The keyword's placement is only as good as the face box. AI presenter takes have one (the identity gate); an upload
  does not yet, and gets the reference's fixed place. The "calm area" placement the brief asked for (sky, plain wall
  from the saliency analysis) depends on shot analysis (ADR 0086, PR #249, not on main); `placements` is the manual
  route until then.
- A gradient or picture fill is a per-reel choice, not a default: the proof below found white reads better than a dark
  gradient on Maya's cream wall.
- Exports with lockups run the person matte on every frame a keyword is on screen, which is slow (see below).

## What was verified

- `pnpm check` (lint, typecheck, tests: core 1267, render 135, web 440, worker 200 passed) and the web `next build`.
  New tests: `packages/core/tests/keyword-lockup.test.ts` (phrases, picks, placement against the safe area and the
  head, timing, captions on and off, the closer, the command, the size rule, saved titles unchanged, a caption track
  fitted as its widest word) and `packages/render/tests/keyword-lockup.test.ts` (the `blurQuick` curve, fill CSS,
  italic and weight).
- **Proof on footage we already own** (no AI spend): the owner's two Maya takes (`ai-cmvomy32u…` "Your listing,
  filmed once. One reel, cut to the beat." and `ai-cmvomvz3z…` "Your words, on the walls. Done before the open home.")
  cut as four shots in the reel-3 pattern (an opening 1.15 → 1.0 scale-out over 250 ms, a 1.12 punch-in on each
  take's second sentence, hard cuts on sentence starts, the 1.6 s pause in take 2 cut out), then one
  `composeKeywordLockup { keywords: ["listing"], cta: { keyword: "Try it", caption: "free at reelwalking.com" } }`.
  Rendered locally with the real renderer at 720p (`renderReel`, person matte on): 13.0 s. Picks: listing, once, One,
  words, done, then "Try it". Files: `https://dh5xvp6apljoh.cloudfront.net/samples/recipes-2026-10-26/`
  `one-question-maya-720.mp4`, `one-question-side-by-side.mp4` (reel 3 left, ours right), `one-question-side-by-side.jpg`
  (seven matched moments), `one-question-frame-sheet.jpg` (every 0.5 s).
- The first proof showed the end-focus pick was wrong for this layout: "beat", "walls", "home" arrived as the phrase
  ended and held 0.5–0.9 s ("walls" flashed with the cut). The pick now favours a word that can hold 1.5 s; the
  second proof's keywords hold 2.0–2.6 s with the captions running under them, as in reel 3.
- Review (sol-loop) found the composition had no `blurQuick` case, so the first two proofs popped (scale 0.86 → 1)
  under the blur; and the steep ease-out made the word sharp in two frames. Fixed; the published proof (the fourth
  render) fades and sharpens over five frames, as reel 3's "difficult" does (frame strips in `work/v4-arrival-words.jpg`
  and the reference's `work/a9.jpg`).
- White against a dark espresso gradient fill on the cream wall: the dark fill read muddy under the doubled soft
  shadow (now one light drop shadow); white was kept, which is also the owner's default.
- The matte puts her hair over the bottom of every keyword, as in reel 3; no caption crosses y 0.72 or x 960 px.

## What failed or is not done

- **Production.** A new reel was made in the owner's account (`cmvp4x4ws000001ad4lwoh9n6`, "One question · Maya
  keyword lockups") with the same cut and a faint music bed (the wall-text reel's song at volume 0.12, about 18 dB
  under the voice as in reel 3), but **without the lockups**: production does not have this schema until the PR is
  deployed. After deploy, one call makes them:
  `composeKeywordLockup { keywords: ["listing"], cta: { keyword: "Try it", caption: "free at reelwalking.com" } }`
  (dry run first). The route then uses the identity gate's face boxes; the local proof used boxes measured with a
  face detector on the same takes, so the production placement may differ by a few per cent.
- The local proof has no music (the library song was not fetched locally); the production reel has it.
- Not copied from reel 3: companion words interlocked with the keyword ("you hire" tucked under "Before"), the
  white→silver gradient with a glow, weight 500, the post-production whips between spots, the house line-icon and the
  phone-call CTA. The whips are retired (ADR 0082, gap #1); the call pill is gap #8.
- Placement in a calm area by saliency waits for shot analysis (ADR 0086, PR #249).
- A brand kit style on the keyword (`brandStyle`) is unit-tested through the command path only, not rendered.
- Picture fills are unit-tested and drawn with the same CSS as gradients, but no picture-filled keyword was rendered.

## Addendum (2026-10-26, round 2): interlocked lockups

### Context

The owner's verdict on the first proof, shared by the orchestrator: "closer than anything before, but bolted on rather
than designed". One of the four causes was the type itself: a keyword up top plus a caption on her chest reads as title
plus subtitles. Reel 3 interlocks them instead: small italic companions tucked into the big word ("you hire" under
"Before", "ask" over "yourself", "Do I" over "trust"). The other causes (a tight close-up that chops short words, a flat
wall, one spot for 13 s) are about footage and were addressed in the proof below, not in code.

### Decision

- **A phrase of four words or fewer (`INTERLOCK_MAX_WORDS`, keyword included) interlocks** by default: its other words
  become companions instead of the caption track. Longer phrases keep the one-word caption track, which is what reel 3
  does with its long sentences. `interlock: false` turns it off.
- **Placement, measured on reel 3's "Before / you hire"** (720×1280 still): companion capitals a third of the
  keyword's (`COMPANION_CAP_RATIO` 0.33; 2.4 % under 7.4 %). The words after the keyword form one line under its right
  half, right-aligned 2 % of the keyword's width in from its right edge, with their capitals' top 0.16 of the keyword's
  capitals above its baseline (`COMPANION_OVERLAP`). The words before it form one line over its top-left,
  left-aligned, sitting on the keyword's cap line (`COMPANION_OVER_OVERLAP` 0). Reaching down into the capitals put
  "Try it" on the f of "free" and it stopped reading; the ascenders still rise beside it, so the two stay locked
  together.
- **A block or nothing.** If a companion line is wider than 1.6 keyword widths (min 0.18 of the frame), or would leave
  the safe area (under the header, above y 0.72, left of the button column), the phrase falls back to the caption
  track (`placeCompanions` returns null).
- **Look and timing.** Archivo italic at weight 500, white, soft shadow. Each line is one title with kinetic `words`
  and `wordsMs` from the speech, so each word fades up out of a small blur on its onset (−40 ms) and the line builds.
  It leaves with the keyword (`blurQuick` exit). Companions are drawn **in front of** the presenter while the keyword
  stays behind her: reel 3 loses the "y" of "you hire" behind her hair, and a small word cannot afford that.
- **The closer.** `cta.caption` of three words or fewer is tucked under the closing keyword the same way
  ("ReelWalk / reelwalking.com").
- **Schema:** additive. `LOCKUP_ROLES` gains `"companion"`; companion titles have ids `kp-over-<lockup>` and
  `kp-under-<lockup>`. Composing again replaces them with the rest of the lockup. `describeLockups` answers
  `layout: "interlock" | "captions"` and `companions` (text, place, cap height), so a dry run shows the choice.
  Saved reels parse and render unchanged. Player and export share the composition. No renderer change was needed:
  companions use the existing `words` kinetic, italic and weight.

### What was verified (round 2)

- `packages/core/tests/keyword-interlock.test.ts` covers placement against the measured geometry, the fallbacks (too
  wide, out of the safe area, more than four words, `interlock: false`), timing, the role, the closer, and
  re-composing. The round-1 tests that check the caption track now pass `interlock: false`.
- **Proof on new wide takes.** Two Maya takes were generated from the presenter kit's portrait, not from a prior
  output. Each was composed `wide` (no close crop) onto a free Pexels photo used as the plate: a Queensland pier with
  rainforest hills (Pexels 36782071) and a Townsville park gazebo with palms (36792910). Both are `mode: "static"`
  with `voice: "veo"`. She came out about half the frame's height, against reel 3's 45 %, with forest or palms behind
  her head where the keyword sits. The production reel `cmvp8by39000301ad2t1e2ctd` uses the reel-3 cut: an opening
  1.15 → 1 scale-out, a 1.12 punch-in that also cuts out Veo's garbled words, and a hard cut to the second spot. One
  `composeKeywordLockup { keywords: [Before, yourself, stop, free], cta: { keyword: ReelWalk, caption: reelwalking.com } }`
  call, with `speech` and `faces` passed in (see below). Exported as `cmvp8dwwq000401adtj7jobgs`: the gate is not
  blocked, and the only warning is the loop seam. Production does not have the addendum yet, so that export shows the
  caption layout.
- **Local render with the interlock** (`renderReel` at 720p, person matte on): "Before / you list",
  "Ask / yourself / one thing", "Try it / free" and "ReelWalk / reelwalking.com" interlock. "Will your reel stop the
  scroll?" (six words) keeps the caption track. Files:
  `https://dh5xvp6apljoh.cloudfront.net/samples/recipes-2026-10-26/one-question-maya-720-v2.mp4`, `…-side-by-side-v2.jpg`
  and `.mp4` (seven moments matched with reel 3), `…-frame-sheet-v2.jpg`, and `…-production-v2.mp4`.
- The first local render put the over-line inside the keyword's capitals: "Try it" sat on the f of "free" and stopped
  reading. Now it sits on the cap line. It still touches a tall ascender (the f), which is the remaining rough edge.
- Two inputs had to be passed by hand on these takes. The identity gate's stored face boxes were about twice the real
  face, which pushed every keyword up to the top of the safe area; the boxes were measured with OpenCV instead. The
  stored whisper-small transcript put "Before" a second late; faster-whisper medium word times were used instead. Both
  are fields the command already accepts.

### Review fixes (sol-loop round 1 on PR #254)

- **No word dropped.** A companion line that would be on for under 200 ms (a quick last word before the clip ends) used
  to be skipped while the caption track was also suppressed, so the word vanished. Now every companion is shown or the
  whole phrase keeps the caption track.
- **Ink never touches ink.** The over-line on the cap line still hit tall letters ("Try" over "free": the y's tail on
  the f). Every glyph's top and bottom was measured from the bundled fonts with fontTools at the drawn weights
  (Playfair Display 600, Archivo italic 500) into a per-character table (Latin letters, figures, common punctuation);
  a keyword or companion with a character not in it (an accented capital such as É reaches 0.94 em) keeps the caption
  track rather than guess. Round 2 of the review found why a table and not letter classes: Playfair's figures are
  old-style (3 4 5 7 9 hang to −0.15 em) and its $ rises to 0.84 em, past the ascenders (0.783). `placeCompanions`
  takes the keyword's text, finds the keyword's glyphs under each line's span, and moves the line clear by a quarter
  of its capitals: the over-line up past the tallest glyph and its own tails, the under-line down only when a keyword
  glyph hangs below the line in its way (its tuck into the capitals is reel 3's look and stays). A line that then
  leaves the safe area falls back to the caption track as before.
- **Brand kit keywords keep the caption track.** `brandStyle` replaces the keyword's face, tracking and case after
  composing, so the measured fit no longer holds; a branded lockup is composed with `interlock: false`.

## Addendum (2026-10-26, round 3): lockups that follow her head, and the two inputs that were wrong

### Context

The owner, on round 2: "the frozen plate and frozen person are the giveaway; reel 3's look is mostly the walking
shot." Reel 3's two moving shots (3.5–6 s: she walks toward the lens while the camera drifts sideways; 13.5–16 s: a
long walk under a pergola as the camera pulls back) carry their type with them. Our composer placed each keyword once,
from one face box on the take's first frame, so on a moving take (or under the opening scale-out) the type stayed put
while she moved. Round 2 also had to pass two inputs by hand because the stored ones were wrong: the identity gate's
face boxes on wide takes, and whisper-small's word times.

### What was wrong with the stored inputs (measured)

- **Face boxes.** On the round-2 pier take the gate's box was [287, 380, 487, 620] (grid): x right, but y 0.29–0.49
  when her face is at 0.51–0.62, and 1.7× its height; it sits in the sky above her head (`diag/box-pair.jpg` in the
  proof folder). Not a coordinate bug: Gemini's grid box is loose in y for a small face on a tall frame. The worker log
  of tonight's moving take shows the same: the first box missed her face entirely (`face-not-in-crop`) and the second
  was 447 px tall for a face of about 300.
- **Word times.** Measured against the audio's loudness, whisper-small put "Before you list," about 0.25 s late (the
  voice starts at 0.80 s, whisper says 1.08 s), not 1 s: round 2's "1 s late" was measured against faster-whisper,
  which was itself 0.8 s early (it put "Before" at 0). Whisper's offset is about constant through a phrase.

### Decision

- **Follow the head (`follow`, default on).** For every lockup group (a keyword and its companions move as one block;
  a caption track on its own) the composer works out, each frame of the group's life, where its anchor would be placed
  for the face on screen then: the take's face track at that source time, through the clip's fit, zoom and camera move
  (`clipPicture`), so an opening scale-out or a punch-in is followed too. The offsets are held inside every member's
  safe-area room (under the header, above y 0.72, left of the button column at x 960 px), followed with a critically
  damped spring (ω 10 rad/s: no overshoot, about 0.2 s of lag, a tracker's wobble smoothed out), and written as each
  title's `path` (offsets, at most 64 keyframes). The keyword is still placed so her head covers 35 % of its capitals,
  and it keeps `behind`, so the person matte keeps its base behind her hair as she moves. A keyword the author placed
  (`placements`) stays put; a group that would move less than 0.2 % of the frame gets no path, so a locked-off take
  composes exactly as before. Player and export draw `path` through the shared scene evaluator (`textPositionAt`); no
  renderer change.
- **Face tracks (`FaceInput.track`).** `trackFace` (core, pure) follows the middle of the face box (inset 18 % / 12 %,
  so hair edges and the background stay out) with the ADR 0052 surface tracker; frames it is unsure of (her mouth
  moving drops single frames' confidence) are skipped and interpolated over; the track ends where the tracker loses
  her. The worker runs it on every finished presenter take (10 fps, 360×640 grey, about 1 s for 8 s) from the gate's
  box and stores it with the gate's record as `{ end: "track", fps, seed, samples }` in `identityChecks` (no
  migration). The library's face hint reads it; the commands route passes it with the box.
- **The gate looks again.** After a passing check the gate cuts a square three times the first box around it and
  locates the face again there, where it is large; the box, read back onto the composite's grid, is stored as
  `locate[].refined`. It is used for placing type and seeding the track, never for the gate's own verdict. Best effort:
  a failure leaves the first box.
- **Word starts on the voice.** The transcriber measures the audio's loudness in 10 ms frames, finds the voiced
  stretches (10 dB over the quiet floor, 150 ms gaps bridged), moves each phrase's first word to the start of the
  stretch it lies in and the rest of the phrase by the same amount, then moves any word still starting in a silence
  forward to the voice (`snapWordsToVoice`, never more than 1.2 s, order kept). Applies to new transcripts.
- **Veo's filter reasons are logged** when Google returns no video (two of tonight's three attempts), so the next one
  can be diagnosed.

### Consequences

- Takes made before this deploys have no track and an unrefined box: their lockups follow the camera only, and the
  box may still be high; pass `faces` by hand for them as in round 2, or re-make the take.
- A refined box costs one more Gemini Flash call per passing gate check.
- The follow lags a fast move by about 0.2 s; a whip of the head is not chased.

### What was verified (round 3)

- Tests: `packages/core/tests/keyword-follow.test.ts` (the spring never overshoots and smooths wobble; paths stay in
  every member's room, at most 64 keyframes; the keyword moves with a moving face and keeps her head 15–55 % into
  its capitals; nothing crosses y 0.72 or the button column; a locked-off take and `follow: false` get no path; a
  camera scale-out is followed without a track; an author-placed keyword stays put), `face-track-onset.test.ts`
  (a moving textured patch tracked within a pixel; a blank seed refused; voiced stretches; the pier take's late phrase
  moved back as a whole), worker `take-face.test.ts` (the refine square holds the real face of the pier take; crop
  boxes read back; the track's seed) and web `face-hint.test.ts` (refined box preferred, a broken track dropped).
- **Tracker on real takes.** `trackFace` on the three proof takes (10 fps, 360×640, about 1 s each) against OpenCV's
  face detector on the same frames: median centre error 3–12 px of 1080×1920, 90th percentile 7–40 px, tracks the
  whole 8 s. The first version stopped at the first unsure frame (1.3 s into the walking take); unsure frames are now
  skipped.
- **Onset snap on real audio.** Pier take: "Before you list," 1080/1300/1660 → 830/1050/1410 ms (voice 0.83–1.49 s);
  "Ask" 5160 → 4930 (faster-whisper said 4940). Walking take: the line moves 0.17 s earlier.
- **One moving take** (3 credits; 6 left of the 9 test credits): Maya from the presenter kit's portrait, composed `wide`
  onto a still of a sandy beach path in Sydney (Pexels photo 36943713; no Australian moving clip with a walkable path
  was found in the Pexels and Pixabay libraries, so the plate is a still and Veo makes the motion). Two attempts came
  back with no video (filtered by Google; refunded, reason not logged then); the third, with the surfers in the photo
  painted out, worked: `ai-cmvpbo9rt000201adi0mmwz9t`. The face matches the kit. The composer made her chest-up (face
  422 px), not knees-up, and Veo gave a slow pull-back and a rise (the edges converge 5–15 px/s, the sea barely moves:
  parallax, but no walk). Veo babbled for 1.5 s before the line; the cut starts at the line.
- **Proof.** A copy of the production reel, take 1 → moving take → take 2, composed with tracks and snapped words and
  rendered locally at 720p (`renderReel`, person matte): every lockup gets a path; on the moving take "more" rides her
  head and stays behind her hair (`one-question-moving-strip-v4.jpg`), but her head hides its middle letter ("m re")
  because the take is a close shot. Files under `https://dh5xvp6apljoh.cloudfront.net/samples/recipes-2026-10-26/`:
  `one-question-maya-720-v4.mp4`, `-side-by-side-v4.jpg/.mp4`, `-frame-sheet-v4.jpg`, `-moving-strip-v4.jpg`,
  `-moving-take-raw-v4.mp4`. The production copy is reel `cmvpc10ab000301adc9jr3qvy` (caption layout, no follow, until
  #254 and this deploy). The local proof has no music.
- Not verified live: the gate's second look (a Gemini call) and the worker's track step run only after deploy.
