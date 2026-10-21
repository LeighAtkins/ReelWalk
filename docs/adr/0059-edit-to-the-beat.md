# 59. Edit to the beat: song structure, a pacing engine and "On the beat"

Date: 2026-10-21

## Context

Cuts could already snap to beats (`beats.ts`, ADR 0021's snap, the
`setMusic`/`snapToBeat` commands of ADR 0048), but every shot was treated
the same whatever part of the song it played over. A pro edit moves with
the song: slow holds while the intro breathes, faster cuts as it builds,
the best shot landing on the drop, things inside the shot (a title
arriving, a burst of snow, a whip, the presenter crossing the words) on the
bar. The reel knew the tempo and the first beat, nothing about bars or
sections, and nothing about how much each clip moves except the measured
motion the director's evidence gathers (`motion.ts`, ADR 0034).

## Decision

### Song structure (`packages/core/src/song.ts`)

`analyseSong(samples, grid)` runs on the same mono 11 025 Hz samples
`detectBeats` reads, so it is pure and runs wherever the audio is already
decoded: ffmpeg in the library importer (`analyseMusic` in
`apps/worker/src/library/tools.ts`), the browser for uploads and for an
Instagram sound's private preview copy (`analyseStoredAudio`). An Instagram
sound is only analysed, never rendered: ADR 0019 is unchanged.

- **Downbeats.** The beats are known; which of every four starts the bar is
  the phase whose beats carry the most low-frequency attack (a one-pole
  180 Hz low-pass: the kick), helped by where bar-to-bar loudness changes.
- **Sections.** Every whole bar gets a level: 0.6 × its loudness (dB)
  plus 0.4 × how much is struck in it (onset sum; hats in a build add
  attacks without much loudness), each normalised over the song, smoothed
  by a three-bar median. Bars at ≥ 0.66 are the **drop**; the quiet
  (< 0.33) bars before the first drop are the **intro**, the rest before a
  drop the **build**; bars after the last drop the **outro**. A one-bar dip
  inside a drop (a fill) stays drop. A steady loop (under 3 dB between its
  quietest and loudest bars and much the same attacks throughout) has no
  sections. Sections are contiguous from 0 and every boundary is a downbeat.

Stored additively:

- `MediaAsset.songMap` (new nullable JSONB, migration
  `20261021059000_media_song_map`), validated by `songMapSchema`, handed
  to the editor as `LibraryAsset.songMap`.
- The reel's `music` gains optional `downbeats[]`, `sections[]`, `energy`
  (where the Energy control was left) and `onBeat`. Absent on every saved
  reel; nothing that reads music changes meaning when they are absent.
- Text `particles` gain optional `burstMs` (see below).

A song analysed before this change gets its map lazily: when the Music sheet
opens, the editor analyses the copy it plays and the next `pace` command
carries the map into the reel (one undo step with the recut). Without a map
the bars are counted from the first beat.

### Pacing engine (`packages/core/src/pacing.ts`)

`planPace(timeline, { energy, clipEnergy, sourceDurationsMs })` is pure and
deterministic. It reads the song's beat grid in reel time (`reelGrid`: beat
k at `beatOffsetMs − sourceStartMs + k·period`, bar phase from the stored
downbeats) and the sections moved into reel time, then walks the clips in
order:

- **Shot length in beats** per section, between chill and hype:
  intro 8→4, build 4→2, drop 4→1, outro 8→4, no sections 4→2;
  interpolated in powers of two by `energy`, nudged half a step shorter for
  a lively clip and longer for a still one, never under `MIN_CLIP_MS`.
- **On the bar.** A shot ends on a grid of its own length laid from the bar
  lines (a four-beat shot cuts on a downbeat, a two-beat one on a half bar),
  and every section start is a cut, so the drop is a cut.
- **The hero on the drop.** The clip that moves most (measured) is held out
  of the order and placed on the drop's first downbeat with a longer hold
  (8→4 beats). When nothing tells the clips apart (energies within 0.05)
  the order is left alone. A reel that ends before the drop puts the hero
  last.
- **Sources.** A photo can be any length (a 360 at least 3.5 s for its
  sweep); a video keeps the middle of what it showed and never plays past
  its source: the longest whole number of beats that fits, else what fits
  (that cut is off the beat; the next goes back on it).

Clip energy comes from the existing measured motion: `clipEnergyFromMotion`
(0.7 × speed, 24 px/s at the 48-px analysis width = 1, plus 0.3 × change)
over five frames per video clip, measured in the browser when the Music
sheet opens (`clip-energy.ts`, frame service of ADR 0047). Clips not measured
use `fallbackClipEnergy` (video 0.5, 360 0.35, photo by its camera move).

### One command

`{ type: "pace", energy, clipEnergy?, songMap? }` goes through
`applyCommand`: one undo step, titles retimed by the attachment rule of
ADR 0048 (`retimeTexts`: an attached title follows its clip to its new
place and window, a caption across cuts keeps its seconds). It plans from
`context.gestureBase`, the reel before the Energy drag began, so a drag
across the stops is one history entry and dragging back gives back exactly
the earlier cut. `{ type: "setOnBeat", on }` switches "On the beat"; on puts
things on the bar in the same step.

### On the beat (`putOnTheBeat`)

Each to the nearest downbeat, never so far it changes what it belongs to:

- a **whip**'s cut (the clip before it lengthens or shortens within its
  source; titles follow by the attachment rule);
- a **title entrance** (`startMs`; the title keeps its length), staying
  over the clip it is attached to and, when pinned, inside the frames its
  path was tracked on (`pin.fromMs/toMs` are not touched);
- a **particle burst** (`particles.burstMs`) inside the title's life. The
  field (`particleField`) puffs out from its centre and brightens for
  900 ms after `burstMs`; without `burstMs` it is byte-for-byte what it was;
- the **presenter's pass** (`passMs`) inside the title's life, and only when
  a downbeat is within one beat: the pass is where she really crosses the
  words, so it moves at most a beat.

Nothing that is not set is added. It runs in `pace`, `setOnBeat` (on), and
after `snapToBeat` and a song picked with `snap` when the music has
`onBeat`. **Default on for new reels**: every song chosen from now on
(`setMusic`) gets `onBeat: true` unless the reel's song had it switched off,
as do the songs new reels start with (tour, venue, autopilot). Saved reels
have no `onBeat` and are off: nothing about them is reinterpreted.

### UI

In the Music sheet, under the song in use (tap the music, Adjust): an
**Energy** slider with five stops (Chill, Easy, Steady, Lively, Hype) and an
**On the beat** switch, both 44 px tall. "Listening…" shows while the clips
and the song are being measured. Nothing else is added; the old "Snap cuts
to the beat again" button stays under Adjust.

## Consequences

- A reel can be recut to its song with one thumb movement and undone with
  one tap; the plan is a pure function and tested without a browser.
- Picking a song (and snapping, as before) now also puts title entrances,
  bursts, whips and passes on the bar, because new songs default to On the
  beat. A studio that does not want that switches it off once per song.
- Pacing reorders one clip (the hero). A studio that wanted its order kept
  can undo; there is no "keep my order" switch, by the simpler-by-default
  rule.
- Instagram previews are short (often 30 s) and analysed only for the first
  90 s of any song: sections after that are unknown and the grid is
  extrapolated.
- **Prisma migration.** `MediaAsset.songMap` needs
  `20261021059000_media_song_map` applied before this deploys: Prisma
  selects every column of a model, so a missing column breaks every
  library query. ship.sh does not apply migrations.

Known gaps:

- Section detection is energy-based. It finds intro/build/drop/outro on
  EDM-shaped and pop-shaped songs; it does not know verse from chorus, and a
  song whose chorus is no louder than its verse has no drop.
- Downbeats assume 4/4. A waltz gets bars of four beats.
- Clip energy is measured once per Music-sheet visit; a clip added
  afterwards uses the fallback until the sheet is opened again.
- The hero is "the clip that moves most", not "the best shot". Picking the
  hero by hand is a later step (it belongs on the clip, where the studio taps
  it).

## What was verified

On Windows 10, branch rebased on main at ad193af7:

- `pnpm check` (eslint, every package's typecheck, every package's tests):
  passes. New tests: `packages/core/tests/song.test.ts` (a generated click
  track, 120 bpm after a 250 ms lead and 97 bpm after 900 ms: tempo, every
  downbeat within 3% of a bar of its kick, intro/build/drop/outro in order,
  the drop exactly on its bar (< 30 ms), the other boundaries within a bar,
  contiguous sections on downbeats, the same result twice, a steady loop
  with no sections); `packages/core/tests/pacing.test.ts` (plan
  determinism; every cut on a beat and every shot of a bar or more ending
  on a downbeat at chill, steady and hype; a cut on the drop; the hero (the
  clip measured to move most) on the drop and held longer than the drop's
  other shots; intro holds longer than build; hype shorter than steady
  shorter than chill; order kept when nothing tells clips apart; no video
  past its source; nothing without a tempo; the analysed click track
  planned end to end with the hero on its detected drop; the pace command
  moving an attached title with its clip and keeping a caption's seconds;
  a later stop planned from the gesture's base equals planning it
  directly; the lazily supplied song map; On the beat for entrances,
  bursts, a pass within a beat (and one left alone beyond it), a title kept
  over its own clip, a whip's cut; old reels off; setOnBeat; a new song
  defaulting on; a burst changing the particle field only during its
  900 ms); `apps/web/components/editor/document-store.test.ts` (a drag
  across four Energy stops is one history entry, equal to planning the last
  stop directly, and one undo restores the reel object as it was).
- `SMOKE_COMPARE=1 pnpm smoke` (Remotion's Chrome Headless Shell,
  ffmpeg 6.1.1 essentials as `FFMPEG`, Remotion's ffprobe): ok. Preview
  against export: all ten frames SSIM 0.980–0.993, worst block 6.3–14.8;
  the three planar titles on their planes (drift 0.9–1.1 px, controls
  caught). The report-only baseline comparison flags frame 19 (worst block
  71.3); the same run on main before this branch flags the same frame with
  the same numbers, so it is this machine's ffmpeg, not this change.

Not verified: the Energy control and the On the beat switch were not
driven in a browser (no local stack was run, by the brief's rules), the
in-browser clip-energy measurement and the lazy song analysis were not run
against real media, and no real song (only generated click tracks) was put
through the section detector. The migration was not applied anywhere.
