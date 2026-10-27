# 0092 - Words that come into focus as they are said

Date: 2026-10-27

## Context

The owner keeps seeing one caption look on realtor reels, for example Instagram `DaNYpI2xw1M` (measured in
ReelWalk-hybrid `output/ref-DaNYpI2xw1M/`). It combines three tricks:

1. **Inverted ink.** White letters drawn as the negative of the picture. This shipped as `blend: "invert"` (ADR 0091).
2. **Words come into focus as they are spoken.** Each word starts faint, blurred and slightly too large, then shrinks
   sharp in about 0.3 s. A big keyword stacks with a small companion line ("my / favorite", "of / this"). At the
   phrase's cut, the whole phrase blurs out together. The face is a heavy, tightly spaced grotesk.
3. **Punch-ins.** One talking-head take is zoomed tighter at a new phrase.

The owner asked us to "watch a capcut tutorial and see if we can do it also pay attention to different fonts being
used". The research is in ReelWalk-hybrid `output/capcut-focus/research.md` (ten sources, frame grabs, a confidence
for every number). What it found:

- **CapCut has no Difference blend.** Its text layers have no blend modes at all. Creators duplicate the clip, mask
  the copy with the text, and invert the copy with Curves. Inside the letters that gives 255 − pixel, which is exactly
  ADR 0091's white difference pass.
- **Words.** One caption layer per word, started on its spoken onset, with an In animation of about 0.3 s ("Zoom in"
  0.3 s, or the "Blur" and "Blur Slam" presets) and Cubic-out keyframes. The phrase leaves with an Out "Blur", Cubic in.
- **The stack.** Separate layers: the companion is about half the keyword's size and overlaps it a little.
- **Punch-ins.** Scale keyframed from 100 % to 115–125 %. Our clip `zoom` already does this.
- **The font.** The reference looks like Helvetica Neue Bold, which is proprietary (Monotype). SF Pro is Apple-only.
  Tutorials use Inter, Montserrat, Rubik and Poppins (all OFL) and Coolvetica (freeware, not OFL). The closest face
  we can bundle is **Inter Tight** (SIL OFL 1.1): weight 700–800 at −0.03 em for the keyword, 600 at −0.01 em for the
  companion. Archivo, our only sans, is wider and reads less like the trend.

Nothing in ReelWalk did trick 2. `blurQuick` (ADR 0089) and `blurIn` (ADR 0082) resolve a whole line at once. The
kinetic `words` preset (ADR 0061/0084) staggers words on their spoken onsets, but it rises and fades rather than
shrinking, and it keeps the title's own exit.

## Decision

**A kinetic preset `focus`** (`packages/core/src/timeline.ts` `KINETIC_PRESETS`), labelled "Into focus". It is stored as
`kinetic: { preset: "focus", wordsMs? }`, beside `words`, so it reuses the per-word machinery and the speech timing that
already exist:

- **Timing** (`packages/core/src/kinetic.ts` `focusArrivals`, `focusReveal`, `FOCUS`). These are pure functions of the
  title's own ms, so the editor's Player, stills and the export agree.
  - A word arrives on its `wordsMs` entry (one per word), or evenly so the last word is in focus at
    `startMs + durationMs` (preset 0 / 700 ms).
  - Over **300 ms**, Cubic out, it fades from 0 to 1, unblurs from **0.08 of its font size** (10 px on a 120 px
    keyword) and shrinks from **1.15×** to its size, with no overshoot. Before it arrives it is invisible.
  - In the title's last **250 ms** (at most a third of it), every word blurs to 0.06 em and fades out together, Cubic in,
    so the phrase goes on its cut as the reference's does.
  - The blur is a fraction of the words' font size, in the px of the span they are set in, so it looks the same on a
    surface title (plane px) and a screen title.
- **Renderer** (`ReelComposition.tsx` `MotionLetters`): the same per-word spans as `words`, with the focus transform,
  opacity and blur. They sit inside the face span, which ADR 0091 draws once per invert pass, so **`blend: "invert"`
  works unchanged**: each word is a negative of the picture, and it is blurred and scaled the same in both passes.
  Preview and export are the one `ReelComposition`.
- **Spoken timing.** `syncTextToSpeech` keeps a `focus` title as `focus` (it used to write `words`), with the same lead
  as `words` (60 ms ahead of the onset). The new `captionsWithWords` (`transcript.ts`) gives each speech caption's word
  onsets, so `captionSpeech` with focus times every word.
- **AI edit** (`ai-edit.ts`). The ask vocabulary gains `animation: "focus"` (`AI_TEXT_ANIMATIONS`), mapped to the
  kinetic preset by `arrivalPatch`. Any other arrival takes a focus preset off. `captionSpeech` with `focus` writes
  per-word times. The prompt says when to use it ("words come into focus", "blur-in captions", "CapCut style captions").
- **Agents** (`/api/reels/:id/commands`, MCP `apply_commands`). Use `updateText {textId, patch: {kinetic: {preset: "focus"}}}`
  or `addText` with the same field, then `syncTextToSpeech {textId}`. No new command is needed. The MCP tool text says so.
- **Editor.** The text sheet's Motion → Kinetic row lists "Into focus" (from `KINETIC_LABELS`), and the start-time
  controls work as for other presets.
- **Font.** `font: "tight"` is **Inter Tight Variable** (`@fontsource-variable/inter-tight`, SIL OFL 1.1, wght 100–900),
  bundled like Archivo and Bodoni (`packages/render/src/reel/fonts.ts`): no network at render time. The worker needs no
  system font or fontconfig change, because Chrome loads the face from the bundle. It sets −0.03 em unless the title has
  its own `tracking`. The editor's Typeface row offers it as "Inter Tight". Nothing defaults to it: the house style
  stays white Playfair (`elegant`).

Not built:
- A one-tap "big + small" stack. The proof builds it from two titles, a small line at y and a big keyword just under it.
  The keyword lockup (ADR 0089) has the companion role if this should become a composer.
- A punch-in command. The clip's `zoom` (and `updateClip`) does it on a split shot, as the proof shows.

## Consequences

- Saved reels are unchanged. `focus` and `tight` are additions to two enums. `words`, `caption`, `behind` and `count` render
  as before, and `syncTextToSpeech` still writes `words` for every title that was not already `focus`.
- An old client that does not know `focus` will reject a reel that uses it, like any added enum value. The web and the
  worker ship together.
- Like every inverted title, a focus title over mid-grey footage (a cream blazer in shade) goes murky. The critic's
  ADR 0091 check flags it. Place the words over clear light or dark areas, as the reference does.
- A per-word CSS blur costs more paint than one blurred line, for the 300 ms each word settles.

## Verified

- Unit tests. `packages/core/tests/focus-text.test.ts` covers:
  - arrivals, both spoken and staggered;
  - the start state (invisible, 0.08 em blur, 1.15×);
  - the eased midpoint and rest at 300 ms, with no overshoot;
  - the shared exit and its cap at a third of the title;
  - spaces kept;
  - schema round trip and the rejection of an unknown font;
  - the AI mapping both ways;
  - `captionSpeech` with focus writing per-word times;
  - `captionsWithWords` matching `captionsFromSpeech`.

  `wall-text.test.ts` checks that `syncTextToSpeech` keeps `focus`. `packages/render/tests/focus-font.test.ts` checks the
  Inter Tight CSS, that a title's own tracking and weight win, that the other faces and the elegant Playfair are
  unchanged, and that it inverts.
- Real renderer. The proof is ReelWalk-hybrid `output/capcut-focus/` (`scripts/build_timeline.py`, `scripts/render-local.mts`
  with this worktree's renderer). It is about 8.4 s:
  - Maya's lounge take, muted, under its Aoede en-AU Chirp 3 HD dub. The words are timed from the dub's alignment.
  - A 1.22× punch-in on the same take at "and every room".
  - The real Pexels lounge (39576518, Alef Morais) with a staggered title across a dark post and a white sofa.

  It is rendered in Inter Tight and in Playfair, all inverted. Stills from `renderReelStills` and frames of the MP4 from
  `renderReel` (the worker's export) were compared at 14 frames across the three shots (Inter Tight version):
  - SSIM was 0.986–0.994 on every frame.
  - The mean difference inside the title band was 2.0–2.2 / 255, the same as across the whole frame (2.0–2.1). The
    difference is the encoder; the titles agree.
  - `docs/adr/assets/0092-focus-proof.jpg` shows frames of the proof. The side-by-side with the reference reel stays
    out of the repository (it is someone else's video).
- Not verified: the editor's Player itself was not captured. It draws the same `ReelComposition` in Chrome, and stills
  are drawn the same way, but that frame was not compared.
