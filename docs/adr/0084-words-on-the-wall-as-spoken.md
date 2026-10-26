# 0084 - Words on the wall as they are spoken

Date: 2026-10-26

## Context

The owner: "Have a presenter in front of a wall at an angle and the presenter's shoulder and head partially clipping
it. When the presenter speaks have the text be what they are saying but on the wall. For bonus points have the wall
itself be different angles or two walls and have the text pop and fade in sync with the dialogue, generated with our
AI agent Maya doing the speaking."

Most of it already existed. A title can be painted on a plane in perspective (`surface`, `blend: "surface"`, ADR 0039,
0043), found on a wall from the picture (`placeOnSurface`, ADR 0075), held behind a person with the person matte
(`behind`, ADR 0039) and brought in word by word (`kinetic: "words"`, ADR 0061). Voiced Maya takes come from the
presenter kit (ADR 0056, 0069) and are transcribed with word timings (ADR 0035, `transcript.words`).

Building the reel by hand showed three gaps:

1. **The words did not land on the words.** "words" staggers a title's words evenly over `durationMs`. Speech is not
   even: in Maya's "Your listing, filmed once." the second word is said 220 ms after the first and the third 1,420 ms
   after it. The even stagger put "listing" 433 ms late and "filmed" early; on "One reel, cut to the beat." it was 416 ms
   off. Read against her mouth, that is visibly wrong. Timing a title to speech also meant reading the transcript,
   mapping source time through the clip's trim and speed, and computing start, end and stagger by hand for every line.
2. **A quiet line could not be placed by size and spot.** `placeOnSurface` fills the wall (up to 84% of it, ADR 0075):
   right for a title card, wrong for a 2.5%-cap line beside a speaker's head, which has to sit where her head and
   shoulder can cross it.
3. **The fitted planes on a blank plaster wall were rough boxes.** On both takes the finder (Opus vision plus edges, $0.03
   a look) found the two walls of the corner, but as boxes: one side of the right wall leaned instead of following the
   vertical corner, and the bottoms were flat. Text laid in such a box is skewed against the wall's real lines.

## Decision

Three small pure additions in `packages/core/src/wall-text.ts`, one schema field and one command. No migration.

### Each word when it is said

- `kinetic.wordsMs?: number[]` (timeline schema): when each word arrives, ms after the title appears, one per word.
  `wordReveal` uses it when there is exactly one time per word; otherwise (absent, or a count that does not match after an
  edit) the even stagger as before. Saved reels are unchanged.
- `alignSpokenLine(line, spoken)`: the title's words found in order in the heard words (a longest-common-subsequence
  alignment; words compared lower case without punctuation, a letter's difference allowed in words of four letters or
  more). A word that was not heard is placed between its neighbours. Null under 60% heard.
- `spokenWordsOfClip(timeline, index, speech)`: the words a clip plays, in reel time, through its trim and speed, or
  from the sound under it for a J-cut (ADR 0069).
- `speechSync(timeline, textId, speech, { clipId?, holdMs = 700, leadMs = 60 })`: the patch. The title starts 60 ms
  before its first word, each word arrives 60 ms before it is said, and the title ends `holdMs` after its last word
  (never past its shot, at least 1.2 s on screen). The elegant style's own fade (`textExit`, ADR 0061) takes it out.
  Errors say what the clip does say: `The words of l3 ("…") are not what clip a says: it says "…".`
- Command **`syncTextToSpeech { textId, clipId?, holdMs?, leadMs? }`** in the registry, so the HTTP commands route and
  the MCP `apply_commands` tool accept it. The route fills `speech` from the library's transcripts
  (`withLibraryInputs`, alone or inside a batch), as it already did for `hook`.

```jsonc
POST /api/reels/:id/commands
{ "commands": [
  { "type": "addText", "text": { "id": "l1", "text": "Your listing,\nfilmed once.", "startMs": 0, "style": "elegant" } },
  { "type": "placeOnSurface", "textId": "l1", "clipId": "c1", "pick": "wall", "fit": { "at": { "x": 0.3, "y": 0.385 }, "capHeight": 0.025 } },
  { "type": "updateText", "textId": "l1", "patch": { "behind": true } },
  { "type": "syncTextToSpeech", "textId": "l1" }
] }
```

### A line at a spot and a size on a wall

- `lineOnPlane(plane, aspect, { at, capHeight = 0.025, lines = 1 })`: the title's rectangle in the plane's own
  coordinates, centred on the frame point `at` and sized so its capitals are drawn `capHeight` of the frame tall
  (Playfair's cap height is 0.708 em; the plane rectangle is `lines × TITLE_LEADING` em tall). Found in a few steps of
  proportion because the drawn height is close to linear in the plane height. The far end of a line on a receding wall
  is shorter than the near end. Refused, with the reason, when `at` is off the plane or a corner leaves the safe area.
- `placeOnSurface` gains `fit: { at, capHeight? }`: when the route finds the surface, the line is laid there at that
  size instead of filling the surface. The tracker follows the new corners. Validated (400 when malformed).

### A wall's plane from its own lines

- `wallPlane({ vanishingPoint, x0, x1, top, bottom })`: an upright wall between two verticals whose top and bottom run to
  the vanishing point of its horizontal lines (the ceiling edge and the skirting meet there). Two measured edges of a
  blank wall give a plane whose sides are the wall's real lines, where the finder gives a box. Pure, so an agent that
  has measured the lines (or a later edge step in the finder) can call it.

## Consequences

- A spoken line on a wall is now four commands an agent can send, with no transcript arithmetic: `addText`,
  `placeOnSurface` with `fit`, `updateText { behind }`, `syncTextToSpeech`. The editor UI is unchanged; a title timed
  this way edits like any title (moving it drops nothing; retyping its words so the count changes falls back to the even
  stagger until it is synced again).
- `wordsMs` is not moved by `snapTypeMotionToBeat` (ADR 0059): a beat snap moves `kinetic.startMs`, which timed titles
  do not use. Speech wins over the beat; documented, not handled.
- Until this is deployed, production staggers evenly. The reel made for this ADR works around it by splitting each
  two-line title into one title per row on the same plane (each row is two to four evenly spoken words, so the even
  stagger is within 0–200 ms there).

## What was verified

(filled in below with the reel, the export and the checks)

## What failed or is not done

(filled in below)
