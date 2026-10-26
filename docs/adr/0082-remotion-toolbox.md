# 0082 - The Remotion toolbox: open-source transitions, title reveals and end cards, judged on our footage

Date: 2026-10-26

## Context

The owner, 2026-10-26: "before anything we should implement and test more remotion tools. I think this is the
simplest way to improve quality before any big pipeline changes." Our render layer was hand-rolled: a dip to black
for "fade", an SVG-blurred translate for "whip", a 0.6 s fade or a spring pop for titles, one end-card reveal. The
open-source Remotion ecosystem has grown a lot of this since (Remotion's own `@remotion/transitions` and
`@remotion/effects`, shadcn-style registries such as onda and remocn, template packs, QA tools).

The measured house spec (`output/research/reel-editing-2026-10-26.md` §8 in the hybrid checkout) bounds what is
worth adopting: hard cuts in the best reels, one serif hook sentence on the opening shot that cuts in and out with
it, a logo end card, no labels, no animated text, no whooshes. So the defaults do not move; new kinds are for the
"Lively" look and the close, where the owner or an agent asks for them.

This ADR builds on the primitives work (ADR 0081: `@remotion/transitions` under every cut, Playfair Display as the
elegant face, layout-utils text fitting), which turns "fade" into a crossfade and "whip" into Remotion's slide.

## What was evaluated, and how

Every candidate was drawn on the owner's reel `cmvo10ubf000001ad160ggov8` (Reel 91): its seven source clips, fetched
from the media bucket, at the reel's own source windows, 1080×1920 (720×1280 proxies, at least one 1080 per group),
next to what we ship today. The gallery is `output/research/remotion-toolbox/gallery.html` in the hybrid checkout
(the clips beside it; the harness is `packages/render/scripts/toolbox-gallery/`, kept out of the repo because one
reference in it is Remotion-License code, see below). Licences were read from each repository's LICENSE file and
`package.json`.

## Verdicts

| Candidate | Licence | Verdict | Why (one line) |
|---|---|---|---|
| `@remotion/transitions` `fade()` (crossfade) | Remotion licence (installed) | adopt (via 0081) | Is the primitives branch's new "fade"; no new kind. |
| `@remotion/transitions` `slide()` (push) | Remotion licence | adopt (via 0081) | Is the primitives branch's new "whip"; no new kind. |
| onda `morph` → **softDissolve** | MIT (degueba/onda) | adopt | Crossfade with a 3 % breath of scale: the quietest transition that still reads as chosen; CSS, so the phone preview matches. |
| remocn `focus-pull` → **focusPull** | MIT (kapishdima/remocn) | adopt | Rack focus through a 12 px blur and a small lift; reads as a lens, not an effect. |
| `@remotion/effects` `lightLeak()` → **lightLeak** | Remotion licence | adopt | Warm light over a hard cut that stays on its frame; the luxury close and Lively. Needs WebGL2. |
| `@remotion/transitions` linearBlur, crosswarp, filmBurn (gl-transitions shaders, MIT) | MIT shaders | later / no | HTML-in-canvas: phone Players fall back to a hard cut (preview ≠ export), and on our footage the shader pass re-frames the cover crop; crosswarp and filmBurn are loud. |
| `@gl-transitions/remotion` 0.1.0 | MIT | later | Same HTML-in-canvas path as above, 0.1.0 vs an unpublished 1.0 that renames every shader; Remotion now ships the ones we would use. |
| remotion-dev/remotion-gl-transitions | UNLICENSED, no LICENSE | no | 2024 WebGL1 demo on Remotion 4.0.150, superseded by the above. |
| onda TrackingIn → **trackIn** | MIT | adopt | Letter-spacing closes as it fades up; its spring replaced by an ease-out so it never overshoots. |
| onda BlurReveal / remocn soft-blur-in → **blurIn** | MIT | adopt | Whole-line blur resolve (not per letter: a dancing serif is off-style). |
| onda MaskReveal (idea) → **maskUp** | MIT | adopt | The line rises 6 frames through a hard edge, no fade: the editorial reveal. |
| our own → **fadeQuick** | — | adopt | 200 ms fade: nearly the spec's cut-in, without a hard cut's pop on bright sky. |
| remocn `mask-reveal-up`, `per-word-crossfade` | MIT | no | Not actually masked (`mask-reveal-up` has no clip); per-word motion is animated text. |
| reactvideoeditor/remotion-templates (Cinematic, Transition, Intro & Outro, Text) | "MIT" in README only, no LICENSE file | no | Springs at damping 12–15 overshoot; the quiet ones (cross-dissolve, chapter-title) we already have in better form. |
| av/remotion-bits | MIT in package.json/README, no LICENSE file | no | The npm package hard-depends on three.js; nothing we lack. |
| ClippKit | MIT | no | Bouncy (sliding/popping text, toasts); nothing restrained. |
| remotion-dev/light-leak-example | UNLICENSED | no | Superseded by `@remotion/effects` lightLeak (adopted). |
| remotion-dev/morph-text | UNLICENSED | no | Gooey word morph: novelty. |
| remotion-dev/typewriter | "component: MIT" | no | We already have `type`; the spec says no animated text. |
| End card **cut** (hard plate, tracked caps) | our own | adopt | The measured luxury close (5 of 14 end on a logo card, no move). |
| End card **over** (no plate, blur in over the last wide) | our own, onda EndCard idea | adopt | For a final wide that is the ending; a soft scrim under the line, not a box. |
| End card **leak** (light leak into the plate) | our own + `@remotion/effects` | adopt | The luxury reveal: the plate is under the light at its peak. |
| Remotion Elements "Location Lower Third" | Remotion License (repo), not MIT | no | Quiet and well made, but labels are off the measured spec, and the code is not ours to copy as MIT; drawn in the gallery from its curves only. |
| Remotion Elements "Social Safe Zones" | Remotion License | later | A PNG of the Instagram UI over the frame: a preview aid for the editor, not a gate. |
| GroMarketing/remotion-qa 0.1.3 | MIT | adopt (CI, report only) | Pace and Reels safe-zone checks on the smoke's MP4; its safe-zone check skips bands over footage, so it cannot block. |
| oo-pibe/audio-bed-check 0.1.0 | MIT | adopt (CI, report only) | Found that every bundled ambience bed is an exact 4 s loop; flags music as "looping" too, so beds only. |

## Decision

New values of the existing kinds. Nothing saved changes meaning; every default stays (cut, the style's own title
arrival, the plate fade).

- `Clip.transitionIn` (`TRANSITIONS`): `softDissolve`, `focusPull`, `lightLeak`.
  - `softDissolve` and `focusPull` are CSS `TransitionPresentation`s (`packages/render/src/reel/toolbox/presentations.tsx`)
    for the TransitionSeries of ADR 0081, centred on the saved cut like its fade and whip, so no cut, title or beat moves.
  - `lightLeak` is an overlay, not a transition: `@remotion/effects` `lightLeak()` on a full-frame `Solid`, screened over the
    footage for 24 frames centred on the cut (`toolbox/cut-overlays.ts`); the cut stays hard on its frame.
- `TextOverlay.animation` (`TEXT_ANIMATIONS`): `fadeQuick`, `maskUp`, `trackIn`, `blurIn` (`toolbox/title-reveal.ts`, pure). The
  fade and settle go through `textMotion`; the tracking, blur and mask are drawn on the face (`toolbox/RevealFace.tsx`). A
  wrapped title's lines are held while the tracking is open (`wrapTitleLines`), so no word re-breaks mid-reveal. On a
  surface title or a moving (shine, kinetic) one only the fade applies.
- `EndCard.reveal` (`END_CARD_REVEALS`, optional): `fade` (absent; ADR 0065's), `cut`, `over`, `leak` (`toolbox/EndCards.tsx`).

**How an agent or the editor reaches them.** No new UI: the transition sheet keeps its list, the text sheet's "Arrives"
control lists the four reveals (it reads `TEXT_ANIMATIONS`). Commands over HTTP and the MCP connector already take them:
`{ "type": "setTransition", "clipId": "…", "transition": "lightLeak" }`, `{ "type": "updateText", "textId": "…", "patch": { "animation": "maskUp" } }` and the new
`{ "type": "setEndCard", "endCard": { "text": "…", "durationMs": 2000, "reveal": "leak" } }` (null removes it; `diffTimelines` now notices the end card, which it missed). The ask-for-a-change prompt (ai-edit) takes them from the same arrays and has a line on each, "only when asked".

**CI.** `packages/render/scripts/qa/render-qa.sh` runs after the worker smoke, report only (job summary): remotion-qa
`check` on `smoke-out/*.mp4`, and audio-bed-check `bed` on the four ambience beds looped to 20 s (`--min-period 3`).

## Consequences

- The Lively look and the close get four quiet transitions and three closes without anything louder entering the
  defaults. Hard cuts and the hard hook remain the one-shot default (the spec).
- `lightLeak` and the `leak` card need WebGL2 in the renderer. Local renders (Windows, `--gl=angle`) draw it; the
  Linux worker's default GL is unverified here (see below). Where WebGL2 is missing the effect draws nothing and the cut
  is a plain cut.
- The GL shader transitions stay out until phone Players can draw HTML-in-canvas; adopting them would break "preview
  matches export".
- The ambience beds loop audibly every 4 s (audio-bed-check, 1.00 on all four); new, longer beds are follow-up work.

## What was verified

See the PR for commands and output. In short: the gallery renders (every clip, timings in `clips/timings.json`); the
adopted kinds through the real `ReelComposition` at 1080; vitest for the new pure modules (`tests/toolbox.test.ts`);
both QA tools installed and run locally on the owner's export and on the beds; `pnpm check` and the web build.

## Not verified / gaps

- `lightLeak` on the Linux worker (CI's smoke does not use it).
- `softDissolve` / `focusPull` need the primitives branch's TransitionSeries: before it they render as a hard cut.
- remotion-qa's safe-zone check skips any band holding footage (64 of 68 on the owner's reel), so it mostly reports
  "not judged" on full-bleed property video; our own caption-zone rule (ADR 0071 checks) stays the gate.
