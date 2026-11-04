# 0108 — Display type and accents

Date: 2026-11-04

## Context

The owner's reference reel 5133 (19.2 s, 1080×1920) is a before and after. One locked-off take of a realtor plays plain,
then again with a full kinetic edit:

- huge stacked words filling the sky, one face per word (a heavy sans, a serif italic);
- gradient fills with a coloured glow, overlapping each other, some behind her head;
- small italic words popping at chest height;
- a tall framed card in the sky with a white and pink neon edge, holding a second copy of her over a green wall;
- a warm lens flare, and a push-in near the end.

An audit of what ReelWalk could already draw:

| Look | Already there |
| --- | --- |
| A gradient fill | `fill` (ADR 0089) |
| Mixed faces and overlap | one title per word; `font`, `italic`, `weight` |
| Words behind her | `behind` (ADR 0039) |
| Chest-height word pops | `kinetic: "caption"` with `wordsMs` (ADR 0089) |
| The push-in | `camera` (ADR 0067) |

Five things were missing:

1. Titles over size 2.5, except a lockup's keyword.
2. A glow on the letters. `text-shadow` paints over a gradient clipped to the glyphs.
3. A true serif italic. Playfair's upright was the only cut bundled, so its italic was slanted by the browser.
4. The portal card.
5. A lens flare that belongs to the shot. The golden shine's flare (ADR 0061) belongs to one title's plane.

## Decision

**Titles.**

- `text.display: true` lets a title reach `KEYWORD_SIZE_MAX`, as a lockup's keyword may. `addText` and `updateText` both
  honour it through `maxTextSize`. It is still fitted inside the frame by `fitScreenTitle`.
- `text.glow: { color, radius, strength }`: two `drop-shadow` filters on the title's box, so it wraps whatever the arrival
  does to the letters. `radius` is in fractions of the font size, so it scales with the type.
- Playfair's italic file is bundled, and a title set in italic waits for it.

**Accents** are a layer of the reel (`timeline.accents`, `accentsSchema` in core), over the footage and under the titles,
set as a whole by one validated command, `setAccents`, so it undoes in one step. Up to 8; `null` takes them off.

- **`kind: "portal"`.**
  - A card placed by centre and size in frame fractions, turned with `yaw` and `roll`.
  - It holds a `wall` (a gradient, or a library picture) and a `person`: the ordinary person matte (`PersonMatteView`) of a
    second, silent playing of a take, from `sourceStartMs`, scaled into the card about a focus point
    (`portalFootageBox`).
  - The lit edge and glow are box shadows; `edgeColor`, `glowColor` and `glow` set them.
- **`kind: "flare"`.** A warm bloom, a tighter core and a soft streak, screened over the picture. It breathes slowly so it
  does not sit like a sticker.
- **Riding the camera.** By default an accent takes the transform of the shot under it (`clipPresentation`, the same
  function as the footage and the matte), so a push-in carries it like something in the scene. `followCamera: false` fixes
  it to the frame.
- **Arrival.** `accentEnvelope` is a pure function of reel time: an eased fade, a portal growing from 86 %, no overshoot, so
  the editor's Player and the export agree.
- **Assets.** A portal's wall and person count in `referencedAssetIds`, so they are loaded and checked with the reel's other
  media.

A stack of words stays one title per word. No lockup command is added: the existing commands place them, and
`composeKeywordLockup` remains the automatic route for a single keyword.

## Not in this step

1. Editor controls. Glow, display size and accents are reachable through the commands (the connector, the HTTP route and
   Ask) and show in the preview, but have no sheet yet.
2. A portal person that is not cut out (a video already shot against a wall).
3. Critic rules for display type. Its legibility and placement checks treat a display word like any other title.
