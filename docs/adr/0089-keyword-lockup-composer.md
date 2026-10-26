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
