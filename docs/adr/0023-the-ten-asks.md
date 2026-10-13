# ADR 0023: The ten things people ask for

Status: accepted (2026-10-14)

## Context

Once a reel can be changed by asking (ADR 0020), people ask for anything.
Leigh's first evening with the draft review (ADR 0022) showed two kinds of
gap. Some asks had no operation behind them, so the model could only
apologise ("add my logo", "use the pool shot as the cover"). Others had the
wrong one: asked for more cuts from a long walkthrough video, the model
duplicated the clip, and `duplicate` ignored the start and length it gave,
so the reel played the same two seconds twice.

The asks that come up for real-estate reels, from the same evening and from
watching listing accounts, are a short list: more cuts from one video, a
closer crop, which frame is the cover, the agency's logo, a status sticker
(JUST LISTED, PRICE DROP, SOLD), a line of text over one particular shot
("DM for a tour" at the end), how the text arrives (typing, fading), a look
(golden hour, dusk, the bright listing look), the facts kept on screen the
whole time, and the post's caption.

## Decision

Each of the ten is an ordinary edit on the timeline first, with a control in
the editor, and only then a word the model knows. Nothing lives only in the
prompt.

| Ask | On the timeline | In the editor | For the model |
| --- | --- | --- | --- |
| More cuts from one video | `splitClip` | Split (existing, at the playhead) | op `split` (clip, pieces 2–4); `duplicate` now honours `startMs`/`lengthMs` |
| A closer crop | `clip.zoom` 1–2 | Zoom tool | op `zoom` (clip, 0 = all) |
| The cover frame | `timeline.cover` {clipId, offsetMs}; `coverMs()` | Cover tool (the frame under the playhead) | op `cover` (clip, startMs) |
| A logo | `timeline.logo` {assetId, corner, size} | Logo tool (upload or pick, corner, size) | op `logo` (an unused image whose name says logo) |
| A status sticker | text style `tag` at `TAG_Y` | Sticker style in the Text sheet | `addText` style tag, capitals |
| Text over one shot | `addText`/`editText` with `atClip` | (drag the text bar, as before) | `atClip`: "at the end" is the last clip |
| How text arrives | `text.animation` auto/pop/fade/rise/type/none | "Arrives" row in the Text sheet | `animation` on addText/editText |
| New looks | filters `golden`, `dusk`, `crisp` | Look sheet | op `look` |
| The facts strip | details placement `throughout` (and `none`: kept, unseen) | Details sheet placement | details placement |
| The caption | the reel's `caption` (not the timeline) | "Write it for me" in the Caption sheet | the plan's `caption` field |

Posting uses the cover: `thumb_offset` is `coverMs(timeline)` for a post and
for a scheduled one, so the grid tile shows the frame the studio chose.

A style without a details card ("the privacy I want") now keeps the facts
with placement `none`, so a later "add the details card" or "write the
caption" has them; the description tells the model they are "known but not
shown". A new brief on a reel that already has a cut replaces the earlier
hook, sticker and pace rather than piling on.

## Consequences

- Nine of the ten asks are one short request each; the logo needs an image
  uploaded first (the sheet does it; the model says so when there is none).
- Two new fields on every clip and text (`zoom`, `animation`) have defaults,
  so saved reels parse unchanged.
- Video thumbnails skip dark opening frames, so the AI sees a room rather
  than black and the "Make it for me" list no longer waits on "Naming…".
- Tested against the real model on 2026-10-14: all ten applied as asked, at
  $0.0003–0.0004 a request, in 4–19 s.
