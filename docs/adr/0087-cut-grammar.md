# 0087 - The cut grammar: a named technique on every shot change

Date: 2026-10-26

## Context

The owner's rule (2026-10-26, `ReelWalk-hybrid/output/plans/cut-grammar-2026-10-26.md`): "continuity is a key
concept… in every cut or shot change you're employing a real editing concept that keeps things fresh… think about
where the viewer's eyes are going, how you're surprising them and keeping them watching."

Today's default first cut (`ruleCut`, ADR 0021/0024) orders clips by a room regex, takes each video's middle, and
joins them with plain cuts. Nothing chooses an in-point, nothing looks at where the eye is, and the critic (ADR
0062/0071) cannot say whether a cut means anything. The research spec (`output/research/reel-editing-2026-10-26.md`
§8) gives the measured shape of a good listing reel: 30–45 s, a 1.5–2.5 s opener, 0.8–1.5 s details against 2–4 s
heroes, one hook, an end card, the walk in order. The shot analysis (ADR 0086, built in parallel on
`feat/shot-analysis`) measures what a cut needs: best windows, flow direction and peaks, attention points, depth,
occluders, reframe and close-ups.

## Decision

### The vocabulary on the clip (`cut-schema.ts`, `timeline.ts`)

An additive, optional `clip.cut` records the technique that carries the shot change *into* the clip, a short `reason`,
the eye-trace distance, a `surprise` note, whether the shot's motion is real or virtual, and what the drawn techniques
need (`wipe` edge, `zoom` regions, `depth` grids in ADR 0086's base64 format, `jMs`/`lMs` sound offsets). Reels saved
before it have none and render exactly as before.

| technique | how it is made | drawn? |
|---|---|---|
| eyeTrace | in/out points chosen so the attention points line up (≤ 15 % of the frame width) | hard cut |
| matchDirection | windows whose exit and entry flow agree, or a drift added to a still incoming shot | hard cut |
| cutOnAction | a window ending (or starting) on a flow peak | hard cut |
| beatCut | a cut on a downbeat | hard cut |
| occlusionWipe | a cut inside the occluder's darkest frame (≥ 75 % covered), else a mask wipe following its edge | `transitionIn: "occlusionWipe"` (new) |
| zoomThrough | eased push into a region of A (a blown window, else where the eye is), B settles out of its matching region | `transitionIn: "zoomThrough"` (new) |
| rackFocus | the focus pull, with depth grids: far blurs first on the way out, near resolves first on the way in | `focusPull` + `cut.depth` |
| scaleJump | a virtual close-up of the same moment cropped from the source (only where the source has ≥ 540 px across the reel's width), 4 % micro push | camera |
| shapeMatch | round shape to round shape, or the same dominant colour | hard cut |
| graphicCarry | the hook title held across the first cut | text |
| lightLeak / dissolve | the owner's toolbox kinds (ADR 0082) | as before |

J/L cuts are `cut.jMs` / `cut.lMs`: the incoming clip's own sound starts early, or the outgoing one lingers, faded,
drawn as separate `<Audio>` bridges (`soundBridges`, `transition-plan.ts`). The whip and the speed-ramp-at-a-cut stay
retired.

### Render (`packages/render`)

All CSS, so the Player on a phone draws what the worker exports (no canvas effects, no WebGL):

- `occlusionWipe`: a `linear-gradient` mask on the incoming shot whose edge follows the measured occluder edge, then
  completes the wipe.
- `zoomThrough`: `transform-origin` at the regions, `scale` and a little `blur`.
- depth focus pull: the existing focus pull plus a `backdrop-filter: blur()` layer masked by the depth grid (an SVG
  data URL, cached), the technique `lensSoftness` already uses.
- All three keep ADR 0083's **12-frame cap** (0.4 s): an occluder crosses a phone frame in about that, and a longer
  zoom-through reads as a zoom, not a cut. Transitions stay centred on the saved cut, so no title or beat moves.

`occlusionWipe` and `zoomThrough` are not offered in the transition menu (they need measured parameters); the sheet
shows them only on a cut the planner drew. `setTransition` accepts them; without parameters they draw a crossfade.

### The planner (`cut-planner.ts`, pure, deterministic)

`planCut({ sources, brief: { listing, feel }, beats, targetMs })`:

1. **One take** when a clip has a steady camera walk ≥ 25 s (not for Lively).
2. **Order** along the walk (arrival → threshold → living → kitchen → details → private → view → leaving), opening
   on the most spatial outside shot (aerial/drone, then the most motion).
3. **Slots and lengths** by feel (Quiet/Classic/Lively), from the footage (v2, below): every clip once, the
   opener's twice for the loop, up to two virtual close-ups, heroes as long as their movement earns (≤ 3.5 s), 12–45 s.
4. **Windows** from the analysis' best windows, or ending on a flow peak / inside an occluder when one is near;
   never "the middle" when there is an analysis. The **closer** is the opener's clip ending on the frame the opener
   starts from, so the loop is one continuous move.
5. **Beat**: Lively snaps every cut within half a beat, Classic within 0.3 of a beat, Quiet never.
6. **Each cut**: the incoming in-point is nudged ±0.75 s to line up the eye, the direction or a peak; every technique
   the two shots allow is scored; the choice is never the previous cut's technique, at most twice a reel, and a
   surprise is pulled in from 3.5 s and forced before the gap reaches 6 s (the one case allowed to exceed twice).
   Content reveals (first step inside, first sight of the view, back outside) count as surprises. The mid-point
   (45–55 %) cut prefers a surprising technique. A still window gets a virtual push or a drift in the direction the
   previous shot was moving. Each choice records why.

Motion is judged in the reel's frame: a landscape source seen through a 9:16 crop moves 3.2× faster on screen, so a
slow gimbal glide is motion, not a still.

### The gate and the critic (`cut-grammar.ts`, `critic.ts`, `render-checks.ts`)

`cutGrammarReport(timeline)` reads every shot change (recorded technique, drawn transition, or a title carried over
it) and fails on: a naked cut, the same technique twice in a row, a static span over 1.5 s, no surprise for over 6 s;
it warns on an eye jump over 15 % (not a surprise) and a technique used more than twice. The critic reports these as
`cut-grammar` findings (high / low) on reels that record the grammar, with a "Glint over the cut" fix for a naked cut;
the render checks carry `facts.cutGrammar` and warn-level checks. **It never blocks posting**: the hard gate is the
planner's (and the first cut's) own.

### Wiring

- `planCut { brief?, targetMs?, analyses?, audioAssetIds? }` is a document command (registry, HTTP
  `POST /api/reels/:id/commands`, MCP `apply_commands`). The route fills in `analyses` from `MediaAsset.shotAnalysis`
  (ADR 0086; read with a raw query so a database before that migration answers "no analyses" rather than failing) and
  answers with `plan`: one line per shot change with technique and reason, the reveal, the loop seam, the gate.
  Second windows get ids `<clipId>-w2`, so a dry run and the real run agree.
- "Make it for me"'s quick draft (`quickDraft`, `plannedCut`) uses the planner when any clip has an analysis: song
  first (its grid shapes the lengths, nothing is snapped afterwards), plan, finish (details, hook), hook carried
  across the first cut. **No finish (Pop) on this path.** A plan that fails its gate falls back to the rule cut. The
  autopilot route accepts `feel` and `listing` (for the question screens); otherwise the style decides.

### v2 after the owner's review (2026-10-26)

The owner watched v1 (35.7 s) beside today's rule cut (14 s) and preferred the rule cut. The causes were planner
defaults, not the vocabulary, and v2 changes them:

- **Length comes from the footage.** No fixed 30–45 s: every clip once (the opener's twice when it closes the loop), a
  virtual close-up only where the source has the pixels, each clip at most twice, no second looks unless the reel is
  under the 12 s floor; 45 s ceiling. A hero's length follows how fast its best stretch moves in the reel's frame (the
  role's shortest for a locked shot, up to 3.5 s for a camera visibly travelling); a wide and its close-up together
  hold no more than 3.5 s; no two shots in a row the same length (a beat added or taken). Classic hero 1.8–3.5 s.
- **Fewer visible effects.** zoomThrough, rackFocus/focusPull, lightLeak, dissolve and a drawn occlusion wipe are
  capped per reel: Quiet 1, Classic 2, Lively 3, a hard cap no surprise lifts. A glint only where the light really
  changes, a dissolve only in Quiet: no fillers. The fallback is an invisible hard cut: the incoming in-point is searched
  ±1.5 s to line the eye up (eye trace within 15 %), every cut the feel allows is snapped to a beat (half a beat), and a
  hard cut on any beat counts. These fallbacks may repeat beyond twice (advice only), never twice in a row. A virtual
  close-up is always its scale jump. When a surprise is due and nothing within the cap fits, the shot is shortened so
  the next reveal lands inside six seconds. A colour match needs a real colour (not near-black, white or grey).
- **A hook that reads.** New optional `text.weight`. The planned first cut sets the hook in Playfair 600 at size 2.45
  (capitals about 4.9 % of the frame height), white with the strong shadow, high in the frame. `legibility.ts` measures
  a title's contrast over the frame under it, counting its shadow's halo (`titleContrast`, worst tenth of the
  background), and `pickTitleSpot` finds the calmest place in the top 30 % that reaches 4.5:1, white first, then dark
  ink. The gate fails an opening title under 4.5:1 (`hook-contrast`) whenever frames were read (the critic reads them).
- **A short, readable end card.** New optional `endCard.size`: the line at the hook's size, weight 600. The planned
  first cut closes on 1.2 s ("For sale", "Sold", "Open home", "For lease"; none when it is not a listing).
- **Grade.** The planned first cut gives every shot the style's filter, as the rule cut does; the planner adds no
  grade of its own.
- **Contract v2** (ADR 0086 changed): "rotate" flow, still under 0.01 frame widths a second, rotation in the edge speed.

## Consequences

- Every planned cut can be read and argued with: the reasons are in the timeline, the plan answer and the critic.
- The planner is only as good as the analysis. Without depth there is no depth rack (a plain focus pull stands in when
  a surprise is due); without close-ups or a 4K source there are no scale jumps; without occluders no wipes. The
  fallbacks (a glint, a dissolve, a virtual drift) satisfy the gate but are the weakest techniques.
- `shot-facts.ts` mirrors a handful of ADR 0086's helpers so this branch compiles without it; once both are on main
  they should import the contract's versions.
- The research spec says "hard cuts only"; the owner's later rule wins. Most techniques here *are* hard cuts placed
  well; the drawn ones are capped at twice a reel each.

## What was verified

- Unit tests: `packages/core/tests/cut-planner.test.ts` (planner order, lengths, techniques, loop, one take,
  determinism, gate, critic, render checks, `planCut`, the first cut), `cut-planner-contract.test.ts` (the planner on
  ADR 0086's own Reel 91 fixture: passes the gate; skipped until that fixture is on the branch, run locally against a
  copy), `packages/render/tests/cut-grammar-render.test.ts` (wipe edge, zoom styles, depth mask, sound bridges, the
  cap).
- Reel 91 (owner reel `cmvo10ubf000001ad160ggov8`, its seven clips 4904–4906, 4908–4911; 4907 is not in the reel)
  through the app's own first-cut functions (`plannedCut` beside `ruleCut`, same style, song and hook words), rendered
  locally at 720p with the real renderer and the song (`packages/render/scripts/cut-grammar-proof.ts`). v2 uses ADR
  0086's worker measurements of Reel 91: 21.0 s, 9 shots, gate pass, 0 naked cuts, 0 repeats, two visible effects
  (both depth rack focus), longest without a surprise 4.8 s, 7 cuts on the beat; hook placed as dark ink at y 0.16,
  measured 6.8:1 (no white placement held 4.5:1 over the sky on both opening frames). Mean luma without the end card
  111.5 against the rule cut's 114.4, the same filter on both. v1 (stand-in analysis, 35.7 s) is kept in `v1/`.
  Outputs in `ReelWalk-hybrid/output/phase-b/cut-grammar/` and `s3://…/samples/phase-b-2026-10-26/`.
- Not verified: a 1080p export through production (after deploy), the Player on a real phone, the planner on the
  worker's real analyses.
