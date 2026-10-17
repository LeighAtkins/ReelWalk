# 0031 - Give real footage an editable luxury finish

## Decision

The hybrid workflow needs a consistent edit around each generated shot. Add
an optional luxury finish to AI assembly, plus Refined luxury and Modern
luxury buttons in the editor's Look sheet. This is an ordinary timeline edit
covered by undo, not another model request or an extra generation charge.

The finish keeps source clips, order, duration, captions, music, font choices
and text sizes. Readability comes from a separate contrast treatment rather
than forced enlargement: a narrow contrasting edge, close shadow and soft
halo protect small lettering over bright footage. The default also works for
dark lettering by using a light halo. This is deterministic styling, not
per-frame scene-brightness detection. Users can choose Auto contrast, Soft,
Strong or None in the text sheet. It uses one short
snap-out on the first suitable shot, softens lens edges and favours clean cuts. It removes existing whip accents
rather than adding arbitrary transition motion. The manual Look presets include a matching
grade. During AI assembly, grading remains controlled by the separate
harmonize option, so turning that option off really preserves existing looks.

## Shared preview and export

- Camera motion now works on flat videos as well as photos. Snap-in/out moves
  finish in 180 ms and hold a modest crop without revealing black borders.
- `lensSoftness` is a bounded peripheral blur with a sharp centre. It is an
  optical styling effect, not estimated scene depth or subject segmentation.
- Text has optional typeface and letter-spacing overrides. Existing text
  font metrics retain their prior appearance when these fields are absent;
  automatic shadow contrast applies to unboxed text.
- A text motion path contains 2-32 strictly ordered normalized-time offsets.
  It supports tracked feature paths as well as simple left/right drifts.
  Moving the text changes its base position without discarding the path.
- Editor text targets and selection handles follow the same path and font
  metrics as the Remotion preview and export.
- Font files ship locally; font loading holds rendering until all required
  faces are ready. No font CDN calls occur during export.

The editor exposes snap moves, soft lens edges, typeface, letter spacing and
simple drift controls. Automatic feature tracking is not presented as a
shipping editor feature: tracked paths for the initial creative test were
prepared from actual footage using median optical flow and visually reviewed.

## Live creative test

Inspect scheduled source reels and actual post insights before choosing a
refresh. Preserve the frozen scheduled export and its publication settings;
render separate review variants. Start with mostly real footage, one coherent
font pairing, a readable opening and a specific aspirational story, then add
one short source-referenced AI treatment only when it improves the sequence.

The review disclosures describe the actual change (for example, "Lighting
enhanced with AI"), rather than internal labels such as "lighting study".

Use watch time relative to reel duration, saves and shares as comparison
measures. The initial account sample is small and does not establish that a
visual effect causes engagement. New generations consume the existing credit
and spend-budget path; never repeat an uncertain paid submission or trigger
unbounded creative retries. Publishing remains a separate reviewed action.

Validation covers backward-compatible timeline parsing, snap crop bounds,
motion-path interpolation, unchanged timing/media, small supporting type,
optional grading, and full video exports using actual scheduled source shots.

The first live quality test used two existing scheduled properties, each with
one reference image extracted from its own source video. One generated a
day-to-evening lighting study; the other a limited exterior camera arc. Both
completed through the existing production credit/budget path: two owner-test
credits, an estimated 160 cents of provider reservations, no paid retries.
Review edits use three seconds of each eight-second output and retain more
than 75% real footage. They include a reusable licensed project music asset,
source-based text motion paths and visible AI-treatment labels. Scheduled
posts were preserved. This verifies the live model treatments, not deployment
of this branch's new first/last-frame API or background assembly.
