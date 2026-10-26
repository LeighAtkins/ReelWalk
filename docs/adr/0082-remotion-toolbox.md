# 0082 - The Remotion toolbox: transitions, title reveals, end cards and a lower third, judged on our footage

Date: 2026-10-26

## Context

The owner, 2026-10-26: "before anything we should implement and test more remotion tools. I think this is the
simplest way to improve quality before any big pipeline changes." Our render layer was hand-rolled: a dip to black
for "fade", an SVG-blurred translate for "whip", a 0.6 s fade or a spring pop for titles, one end-card reveal. The
open-source Remotion ecosystem has grown a lot of this since (Remotion's own `@remotion/transitions` and
`@remotion/effects`, shadcn-style registries such as onda and remocn, template packs, Remotion Elements, QA tools).

The measured house spec (`output/research/reel-editing-2026-10-26.md` §8 in the hybrid checkout) bounds what is
worth adopting: hard cuts in the best reels, one serif hook sentence on the opening shot, a logo end card, no labels,
no whooshes. So the cut stays the default; the rest is for the "Lively" look and the close.

This ADR builds on the primitives work (ADR 0083: `@remotion/transitions` under every cut, Playfair Display as the
elegant face, layout-utils text fitting), which turned "fade" into a crossfade.

## What was evaluated, and how

Every candidate was drawn on the owner's reel `cmvo10ubf000001ad160ggov8` (Reel 91): its seven source clips, fetched
from the media bucket, at the reel's own source windows, 1080×1920 (720×1280 proxies, at least one 1080 per group),
next to what we shipped. The gallery is `output/research/remotion-toolbox/gallery.html` in the hybrid checkout (the
clips beside it; the harness, `packages/render/scripts/toolbox-gallery/`, is kept out of the repo). Licences were
read from each repository's LICENSE file and `package.json`. The owner then judged the gallery (below).

## The owner's decisions (2026-10-26)

- **Transitions: offer only** the cut (the default; it is "no transition", not a kind), Remotion's crossfade
  ("fade"), `softDissolve`, `focusPull` and `lightLeak`, the leak toned down to "a glint, not a yellow wash".
  **Drop** from everything the editor, the asks and the MCP connector offer: our whip, the speed ramp as a transition,
  the push, the GL linear blur and crosswarp (film burn was never offered).
- **Title reveals:** keep `fadeQuick`, `maskUp`, `trackIn`, `blurIn`, and make **track-in the elegant style's own
  arrival** ("track-in title is way better").
- **End cards:** keep **cut** (now the default) and **leak**; drop the fade (ADR 0065's) and "over the last shot".
- **Lower third:** replace ours with Remotion Elements' **Location Lower Third**, restyled to the house serif and
  colours with no plate; delete our old one.

## Verdicts

| Candidate | Licence | Verdict | Why (one line) |
|---|---|---|---|
| `@remotion/transitions` `fade()` (crossfade) | Remotion License (installed) | adopt (via 0083) | ADR 0083's "fade"; offered as "Dissolve". |
| onda `morph` → **softDissolve** | MIT (degueba/onda) | adopt | Crossfade with a 3 % breath of scale; CSS, so the phone preview matches. |
| remocn `focus-pull` → **focusPull** | MIT (kapishdima/remocn) | adopt | Rack focus through a 12 px blur and a small lift; reads as a lens, not an effect. |
| `@remotion/effects` `lightLeak()` → **lightLeak** | Remotion License | adopt, toned | A 40 % amber glint over a hard cut that stays on its frame; never opened to a full-frame wash. Needs WebGL2. |
| Our whip pan (ADR 0028/0083) | ours | retired | The owner dropped it. |
| Speed ramp as a transition (ADR 0073/0074) | ours | retired | The owner dropped it; its in-clip speed plan had no other way in, so it went too. |
| `@remotion/transitions` `slide()` (push) | Remotion License | no | Dropped by the owner (and ADR 0083 measured it as a sharp seam). |
| `@remotion/transitions` linearBlur, crosswarp, filmBurn (gl-transitions shaders) | MIT shaders | no | Dropped; also HTML-in-canvas (phone Players fall back to a cut) and they re-frame the cover crop. |
| `@gl-transitions/remotion` 0.1.0 | MIT | no | Same HTML-in-canvas path; the owner kept no shader transition. |
| remotion-dev/remotion-gl-transitions | UNLICENSED | no | 2024 WebGL1 demo, superseded. |
| onda TrackingIn → **trackIn** | MIT | adopt, default for elegant | Letter-spacing closes as it fades up, eased out (no overshoot). |
| onda BlurReveal / remocn soft-blur-in → **blurIn** | MIT | adopt | Whole-line blur resolve. |
| onda MaskReveal (idea) → **maskUp** | MIT | adopt | Rises 6 frames through a hard edge, no fade. |
| our own → **fadeQuick** | — | adopt | 200 ms fade. |
| remocn `mask-reveal-up`, `per-word-crossfade` | MIT | no | Not actually masked; per-word motion is animated text. |
| reactvideoeditor/remotion-templates | "MIT" in README only, no LICENSE file | no | Springs overshoot; nothing quieter than what we have. |
| av/remotion-bits | MIT in package.json, no LICENSE file | no | Hard dependency on three.js; nothing we lack. |
| ClippKit | MIT | no | Bouncy. |
| remotion-dev/light-leak-example, morph-text, typewriter | UNLICENSED / UNLICENSED / "MIT" | no | Superseded / novelty / we have "type". |
| End card **cut** | ours | adopt, default | The measured luxury close. |
| End card **leak** | ours + `lightLeak()` | adopt | The glint peaks on the plate's first frame and is gone 6 frames in. |
| End card fade (ADR 0065), "over" | ours | retired | Dropped by the owner; saved ones read as "cut". |
| Remotion Elements **Location Lower Third** | Remotion License | adopt | New title style `location`, restyled; see the licence note. |
| Remotion Elements Social Safe Zones | Remotion License | later | A PNG of the Instagram UI: an editor preview aid, not a gate. |
| GroMarketing/remotion-qa 0.1.3 | MIT | adopt (CI, report only) | Pace and Reels safe-zone checks on the smoke's MP4. |
| oo-pibe/audio-bed-check 0.1.0 | MIT | adopt (CI, report only) | Loop and level-step checks on the ambience beds. |

**Licence note (Remotion Elements).** Elements are published in the Remotion repository under the Remotion License,
not MIT. Its free tier covers "a for-profit organization with up to 3 employees", for creating videos, commercially
too, and allows modifying the code for that use; it disallows selling a derivative of Remotion itself. ReelWalk is a
one-person company, so the owner holds the free licence, as for Remotion itself. The adapted component
(`packages/render/src/reel/toolbox/LocationLowerThird.tsx`) says where it came from. If the company grows past three
people, a Remotion company licence covers this file along with the rest of Remotion.

## Decision

**Transitions** (`TRANSITIONS`): `cut` (default), `fade`, `walk` (360 photos only, unchanged), `softDissolve`,
`focusPull`, `lightLeak`.
- `softDissolve` and `focusPull` are CSS presentations (`toolbox/presentations.tsx`) in ADR 0083's TransitionSeries
  (`transition-plan.ts` `OverlapKind`), 12 frames centred on the saved cut, so no cut, title or beat moves; the mattes
  above the titles follow them through `AtCuts`.
- `lightLeak` is an overlay, not a transition: `lightLeak()` on a full-frame `Solid`, screened over the footage for 18
  frames centred on the cut (`toolbox/cut-overlays.ts`). The look (`LIGHT_LEAK_LOOK`, chosen from rendered variants on
  the owner's footage): 40 % strength, the effect opened only to 0.375 of its sweep and closed again (`leakProgress`),
  its hue turned 12° to amber (the effect's hue moves fast: +30° is rust, a negative turn is green), saturation 0.85.
- **Retired: `whip` and `speedRamp`.** `RETIRED_TRANSITIONS` in core; the clip schema reads either as `cut`
  (`migrateTransition`, a `z.preprocess` on `transitionIn`), so every saved reel still loads and renders, as a cut;
  `setTransition` refuses them ("retired") so nothing new stores one. With them went: the whip presentation and
  `whip.ts`; the speed-ramp planner (`speed-ramp.ts`, `speed-ramp-params.ts`), its zoom blur (`zoom-blur.ts`) and the
  composition's speed plan; pacing's "Speed-ramp the strong cuts" and whip-on-the-bar; `matchCuts`' whip directions and
  footage readings (it still reorders); the moves' speed-ramp cuts (crash zoom and push-through keep their camera and
  in-clip ramp; the two whip-pan moves are AI-only now); auto whooshes on whips; the Transition sheet's whip, speed-ramp
  and match-footage controls and the Beat control's speed-ramp switch. The in-clip speed ramp (ADR 0067, `setRamp`,
  "Ramp into cuts") is a different feature and stays. `whipDirection` and `music.speedRamps` stay in the schema,
  unread, so saved documents round-trip.

**Title reveals** (`TEXT_ANIMATIONS`): `fadeQuick`, `maskUp`, `trackIn`, `blurIn` (`toolbox/title-reveal.ts`, pure).
`titleArrival` in core reads "auto" as the style's own way in: **the elegant serif tracks in** (it was a 0.6 s fade; a
"fade" asked for by name is unchanged); a location title has its own reveal; everything else pops. One resolver for the
composition, the exit of kinetic titles, the hook-legibility rules (track-in is readable by 250 ms) and the retention
critic. The fade and settle go through `textMotion`; tracking, blur and mask are drawn on the face (`RevealFace`), a
wrapped title held on its resting lines while the tracking is open.

**End cards** (`END_CARD_REVEALS`): `cut` (default, and absent) and `leak`. `migrateEndCardReveal` reads a saved
"fade" or "over" as "cut". The line is small tracked capitals, fitted with ADR 0083's `fittedSize` (measured in
capitals, as drawn).

**Lower third**: a new title style, `location` (`toolbox/LocationLowerThird.tsx`): the Element's curves as written (the
pin drops and scales in while its outline draws and fills, the dot grows, the line is revealed from the left with an
overdamped spring, all of it leaves in reverse), in the elegant serif, white with a soft shadow, an ivory pin, no plate;
its `cropRight` is a CSS clip-path. Shorter titles than the Element's 72 frames play its timings faster in proportion.

**How an agent or the editor reaches them.** The Transition sheet offers Cut, Dissolve, Soft dissolve, Focus pull,
Light leak (and Walk there between 360 photos), with "Play the cut" to judge one. The text sheet lists the reveals and
the Location style (they read `TEXT_ANIMATIONS` / `TEXT_STYLES`). Over HTTP and the MCP connector:
`{ "type": "setTransition", "clipId": "…", "transition": "focusPull" }`,
`{ "type": "updateText", "textId": "…", "patch": { "animation": "maskUp" } }`,
`{ "type": "addText", "text": { …, "style": "location" } }` and
`{ "type": "setEndCard", "endCard": { "text": "…", "durationMs": 2000, "reveal": "leak" } }` (null removes it). The
registry (`COMMAND_TYPES`) gained `setEndCard`; `setTransition` lost its speed-ramp and whip-direction parameters and
`matchCuts` its `whips`/`ramps`/`cuts`; `pace` lost `speedRamps`. The MCP tool's command sheet and house-style hints
list exactly the offered kinds, and the ask-for-a-change prompt offers no whip, swipe, whoosh or speed-ramp transition
(it says they are not offered). `GET /api/moves` no longer lists zoom-blur cuts on moves.

**CI.** `packages/render/scripts/qa/render-qa.sh` runs after the worker smoke, report only (job summary): remotion-qa
`check` on `smoke-out/*.mp4`, and audio-bed-check `bed` on the four ambience beds looped to 20 s (`--min-period 3`).
The smoke fixture now crosses into its third shot (the photo) on a soft dissolve and into its fourth on a light leak,
so CI draws both in the Linux worker's Chrome (the light leak drew there: WebGL2 works in the worker).

## Consequences

- Saved reels with a whip or a speed-ramp cut now render those cuts as hard cuts, saved story cards arrive on the cut
  instead of fading up, and saved elegant titles left on "auto" track in instead of fading. All three are the owner's
  choice; titles that named "fade" are unchanged.
- Fewer, quieter tools: four transitions and two closes, none loud; the defaults are the measured luxury ones.
- `lightLeak` and the `leak` card need WebGL2; where it is missing the effect draws nothing and the cut is plain.
- About 2,000 lines of speed-ramp and whip code and their tests are gone.
- The ambience beds loop audibly every 4 s (audio-bed-check, 1.00 on all four); longer beds are follow-up work.

## What was verified

See the PR for commands and output: vitest for the new and changed pure modules (core: the migration, `titleArrival`,
the commands; render: reveals, presentations, the glint, the plan, the lower third's curves); the gallery's affected
clips re-rendered through the shipped `ReelComposition` and looked at frame by frame; `pnpm check` and the web build;
CI's worker smoke with the dissolve and the glint.

## Not verified / gaps

- remotion-qa's safe-zone check skips any band holding footage (64 of 68 on the owner's reel), so it mostly reports
  "not judged" on full-bleed property video; our own caption-zone rule (ADR 0071) stays the gate.
- The glint was tuned by eye on two cuts of one reel.
- A crossfade into a **video** shot that borrows pre-roll from its source: with the soft dissolve on the smoke's second
  cut, the acceptance harness's on-plane check for the pinned title ending on that cut failed in CI (20,313 of 23,553
  "glyph" pixels off the plane at frame 74, one frame before the cut). That check diffs a still with the title against
  one without, so the incoming clip's pre-roll frame apparently differed between two still renders. Preview against
  export at the same frame matched (SSIM 0.993), so the export itself was consistent; whether a still of a handle frame
  is deterministic was not settled. ADR 0083's crossfade ("fade") uses the same handles. The fixture now puts the
  dissolve into the photo shot, which the check passes locally and in CI.
