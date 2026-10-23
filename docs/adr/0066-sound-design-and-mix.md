# 66. Sound: measured beats, a sound-design track, a levelled mix you can hear

Date: 2026-10-22

## Context

Exports went out silent, or with only the clips' own sound, and Instagram
mixed a library track on top at publish time. There was no sound design at
all: no whoosh under a whip (ADR 0028's inlined whoosh was removed after a
live review), no ambience for a fire or a snowed-in lodge, no riser into a
reveal, no ducking of anything but the music under a presenter, and the
export level (ADR 0045, −14 LUFS) ignored the library track Instagram adds.
"On the beat" (ADR 0059) worked from the tempo the browser or the library
importer detected, but an agent building a reel over HTTP had no way to
read the track's beats or its drop, so the 1000-views series (`output/series`)
guessed tempo and drop with an offline numpy script and still shipped cuts
that were off the beat. Nobody, human or agent, could hear the mix before
posting: "Play with sound" played the export and the Instagram preview at
whatever volume the post form held.

Sound is half of retention. This ADR gives the reel a measured beat grid
and drop, an additive sound-design track rendered by the shared Remotion
composition, ducking and loudness that account for the library track, a
mix preview, and an audio trace agents and the critic (ADR 0062, W3-F) read
instead of listening.

## Decision

### Track analysis (`packages/core/src/audio-analysis.ts`)

`analyseAudio(samples)` runs on the same mono 11 025 Hz samples
`detectBeats` and `analyseSong` read (ADR 0021, 0059), so it is pure and
gives byte-identical answers wherever the audio is decoded: the browser
(Web Audio, when the editor measures a chosen sound's private copy) or the
worker (ffmpeg, the new `music-analysis` step). It returns, in song
milliseconds:

- `bpm`, `beatOffsetMs`, and `beats` (every beat of the grid, listed);
- `downbeats` and `sections` from `analyseSong`;
- `energy`: RMS loudness per 100 ms, normalised 0–1 over the track and
  smoothed over three steps;
- `drop`: the first sustained rise, found among the downbeats (else the
  beats, else every step) as the largest difference between the mean
  loudness of the two seconds after a candidate and the two seconds before
  it, at least 3 dB; an earlier candidate within 1 dB of the best wins, so
  a long build lands on its first big step. Null when the track never
  lifts.

The analysis is cached in storage beside the audio object
(`<objectKey>.analysis.v<N>.json`, `audioAnalysisKeyFor`), versioned so a
better detector invalidates old answers. Whoever decodes first writes it:
the editor PUTs its own when it chooses an Instagram sound or opens the
Music sheet on an unanalysed one (`storeTrackAnalysis`), and the worker's
`music-analysis` step (a durable step, ADR 0049, kind `"music-analysis"`,
no paid provider, so a failed attempt is simply retried) writes it when
`GET /api/music/:audioId/analysis` is asked for an unanalysed sound with
`AI_JOBS_DURABLE=1`. Both also fill the asset's `bpm`, `beatOffsetMs`,
`songMap` and `durationMs` when the browser had not, so `setMusic`
(`songFields`) and the pacing engine use the measured grid: "On the beat"
and Energy run on measured beats, not a guess.

### The drop on a cut (`packages/core/src/drop.ts`, command `dropOnCut`)

`placeDropOnCut(timeline, cut, dropSongMs)` records `music.drop = { songMs,
cutIndex }` and makes cut N (the start of clip N; clip 0 starts the reel)
land on the drop. With your own song the track is moved: the reel starts
`dropSongMs − cutMs` into it. An Instagram sound always plays from its
start (ADR 0019), so the cut moves instead: the shots before it are
stretched or squeezed by one factor, each clamped to its own source and
to the shortest clip (a 360 photo keeps its 3.5 s), the remainder taken
by the last shots with room; titles follow their clips through the
command layer's retime. The command is refused, with a reason, when the
shots cannot be made to fit. `music.drop` is a new optional field: every
saved reel reads as before.

### Sound design (`packages/core/src/sfx.ts`, timeline `sfx`)

An additive `sfx` track: `{ id, sound, atMs, durationMs?, offsetMs?,
gain?, fadeInMs?, fadeOutMs?, auto?, reason? }`, at most 64 entries,
absent on every saved reel (silent, as before). The sounds are nine
bundled files synthesised by our own script
(`packages/render/scripts/make-sfx.mjs`: seeded noise and sines through
hand-written biquads, deterministic, no recorded material), dedicated to
the public domain under CC0 (`docs/licences/sfx.md`): three whooshes
(700 ms, peaking at 300 ms so they are placed 300 ms before a cut), a
3 s riser, a soft impact, and four 4 s seamless loops (fire, water,
wind/snow, room tone).

`autoPlaceSfx` is the rule, run by the `autoSfx` command and never on its
own: a whoosh under every `whip` transition (hard cuts inside a quick-cut
run only when `whooshHardCuts` is asked: it tires fast); a riser ending on
the reveal with a soft impact on it, the reveal being `revealMs` if given,
else the song's drop in reel time, else the start of the longest shot
after the opening; ambience under runs of clips whose room name or titles
say fire, water, snow, wind, forest or city (`inferAmbienceTag`), or as
given per clip in `options.ambience`, faded in and out at the level the
sound's spec sets (0.18–0.22; room tone 0.5 of a −30 dBFS file). Sounds it
placed carry `auto: true` and a `reason`; running it again replaces those
and keeps hand-placed ones. `setSfx` sets the whole track (an empty list
removes it). Sounds that fall past the end after a cut change are dropped
(`trimSfxToReel`).

The shared composition plays the track in the preview and the export
(`SfxTrack` in `ReelComposition.tsx`): one `<Audio>` per sound, trimmed by
`offsetMs`, looped when the sound loops, volume = the sound's gain through
its fades (`sfxGainAt`) × the ducking gain under speech (`duckGain` with
`SFX_DUCK`: to 0.2 over 200 ms, deeper than the music's 0.3). The files
reach the composition as assets keyed `sfx:<sound>` (`sfxAssets`): the
editor serves them from `apps/web/public/sfx/<file>`, the worker from the
render bundle's public dir (`publicDir` in `bundle()`, `staticFile`). A
test keeps the two copies byte-identical.

### Ducking and loudness (`packages/core/src/mix.ts`, `loudness.ts`)

- Speech windows come from the clips' transcripts (ADR 0035,
  `speechWindows`); music ducks to 0.3 as before, sound design to 0.2.
- Exports are levelled to **−16 LUFS integrated, −1 dBTP** (was −14):
  Instagram's library sounds sit near −14, and the post's own track needs
  headroom under them. The worker keeps its two-pass ffmpeg `loudnorm`
  (measure, then a linear correction), with the filter strings and the
  target now in core (`loudnormMeasureFilter`, `loudnormFilter`,
  `LOUDNESS_TARGET`), shared with the render fixture.
- Core carries a pure BS.1770-4 implementation (`kWeight`, 400 ms blocks,
  gated integration, four-times-oversampled true peak) so the worker can
  measure the finished export and the browser can draw the same numbers.
  After every export the worker measures the MP4 and uploads
  `<outputKey>.audio.json` (`ExportLoudness`: momentary loudness per
  250 ms, integrated, true peak), best effort.
- `recommendSoundVolume` turns what the export holds into Instagram's
  `audio_volume` / `video_volume`: speech in the export → sound 40 %,
  video 100 % (the voice stays about 6 LU on top); sound design only →
  sound 100 %, video 60 %; a silent export → sound 100 %, video 0 %.

### Hear it: the export page

`MixPreview` (`apps/web/components/mix-preview.tsx`) fetches the reel's
audio trace and draws a strip: loudness bars per 250 ms, beat ticks
(downbeats taller), the drop as a marker, every cut as a line (dashed
and in the signal colour when more than 60 ms off a beat), speech regions
shaded. Under it, the recommended post volumes in a sentence, the export's
integrated loudness and true peak, up to four problems, and **Mix
preview**: `PlayWithSound` (ADR 0018) with the Instagram sound at the
recommended level over the export's own track, so what is heard is the
mix Instagram will make.

### The Music sheet

`SoundControl` sits under Energy and On the beat, where the studio taps
the music: a **Sound design** switch (runs `autoSfx` with the drop in reel
time; off removes the track with `setSfx []`), and when the song has been
analysed, **Put the drop on cut N** for the selected shot (`dropOnCut`), or
a line saying where the drop is and to select a shot. Phone-first, thumb
sized, no new global menu.

### Over HTTP (for agents)

All session-cookie routes, like `/api/reels/:id/save`.

- `GET /api/music/:audioId/analysis` — `audioId` is an Instagram audio id
  (the workspace's private copy) or a media asset id. 200
  `{ ok, status: "ready", assetId, analysis, music }` where `music` is the
  `{ bpm, beatOffsetMs, downbeats?, sections? }` to pass to `setMusic`;
  202 `{ status: "pending", jobId }` while the worker analyses (poll
  `/api/ai-jobs/:jobId`, then ask again), or 202 with `jobId: null` when
  durable jobs are off and nobody has decoded the sound yet.
  `PUT` with `{ analysis }` stores a browser-made analysis.
- `POST /api/reels/:id/sound` — body `{ command }`, one of
  `{ type: "autoSfx", options? }`, `{ type: "setSfx", sfx }`,
  `{ type: "dropOnCut", cut, dropSongMs? }` (`dropSongMs` defaults to the
  analysed drop). Applied through the command layer (ADR 0048) and saved
  as a new revision; answers `{ ok, revision, changed, sfx, music }` or
  4xx with the command layer's reason.
- `GET /api/reels/:id/audio-trace` — the trace below.

### The audio trace (`packages/core/src/audio-trace.ts`)

What W3-F's critic and any agent read instead of listening. Reel time in
milliseconds throughout.

```json
{
  "ok": true,
  "version": 1,
  "reelId": "…", "revision": 12, "exportJobId": "… or null",
  "durationMs": 21000,
  "music": { "kind": "instagram" | "own" | "none", "bpm": 119, "sourceStartMs": 0, "analysed": true },
  "beats": [0, 504, 1008, …],
  "downbeats": [0, 2017, …],
  "dropMs": 8067,
  "cuts": [{ "atMs": 3024, "clipId": "c2", "transition": "whip", "offBeatMs": 0 }, …],
  "speech": [{ "startMs": 9800, "endMs": 14200 }],
  "sfx": [{ "id": "sfx-auto-whoosh-1", "sound": "whoosh-1", "atMs": 2724, "endMs": 3424, "reason": "whoosh on the whip into clip 2" }],
  "loudness": { "stepMs": 250, "lufs": [-23.1, …], "integratedLufs": -16.1, "truePeakDb": -1.2 } | null,
  "recommended": { "audioVolume": 40, "videoVolume": 100, "reason": "…" },
  "problems": [
    { "kind": "cut-off-beat", "severity": "medium", "atMs": 6100, "clipId": "c4", "detail": "The cut into c4 at 6.1 s is 95 ms off the beat." },
    { "kind": "speech-under-music", "severity": "medium", "atMs": 9800, "endMs": 14200, "detail": "…" },
    { "kind": "drop-mid-shot", "severity": "low", "atMs": 8067, "detail": "The song's drop at 8.1 s falls mid-shot; put a cut on it (dropOnCut)." },
    { "kind": "silence", "severity": "low", "atMs": 15000, "endMs": 17250, "detail": "Silence from 15.0 s to 17.3 s (2.3 s) with nothing under it." }
  ]
}
```

`beats` are the measured grid when the track was analysed, else the
reel's stored tempo extrapolated (`reelBeats`); `loudness` is the last
successful export's sidecar, null before the first export. Problems:
a cut more than 60 ms from a beat; speech while your own song is set loud
enough that ducking to 30 % still leaves it over 25 %; the analysed drop
mid-shot (no cut within 120 ms); quiet under −50 LUFS for 1.5 s or more
in a measured export without an Instagram sound (one will be mixed in;
with none, a hole is a hole). Problems are sorted by time.

## Consequences

- Saved reels are unchanged: `sfx` and `music.drop` are new optional
  fields; a reel without them renders exactly as before. Preview and export
  still share one composition.
- The export level moved from −14 to −16 LUFS. Posts with a library sound
  gain headroom; a reel posted with only its own track is 2 LU quieter
  than before, within what Instagram's own normalisation evens out.
- Every export now takes one more ffmpeg decode (the measurement, a few
  seconds) and uploads a small JSON sidecar. Failing to measure never
  fails the export.
- The analysis cache lives beside the audio object and is deleted with it.
  Bumping `AUDIO_ANALYSIS_VERSION` invalidates every cached analysis.
- The `music-analysis` step kind is a string in `WorkflowStep.kind` and
  `WorkflowRun.kind` (`reelId` null): no migration. Without
  `AI_JOBS_DURABLE=1` the browser is the only analyser, as it was for
  tempo.
- The sound set is small and synthetic by design: a licence we own
  outright, 1.4 MB, deterministic. It will not pass for a sound library;
  it gives a whip a whoosh and a lodge its wind. Replacing a file keeps
  the id, so reels keep working.
- Two copies of the sound files (web public dir, render public dir) are
  held identical by a test.
- `PlayWithSound` learnt `label` and `hint` props; the publish form's own
  "Play with sound" is unchanged and still uses the form's volumes. The
  recommended volumes are shown, not forced: the studio sets the post's
  sound volume; agents read `recommended` from the trace.
- The export level is a target, not a promise: `loudnorm` keeps the mix
  linear (ADR 0045), so a reel whose peaks sit far above its average (a
  near-silent reel with one impact, the fixture) stops at the −1 dBTP
  ceiling short of −16 LUFS rather than being limited. The trace shows the
  measured level; a reel that comes out well under −16 is one that needs
  more under it, not more gain.
- Core's meter reads transient-heavy, near-silent material up to about
  2 LU apart from ffmpeg (steady and burst material agrees within 0.1 LU).
  The worker levels with ffmpeg, so exports are unaffected; the trace's
  `integratedLufs` and the export page's figure come from core's meter and
  carry that uncertainty on such reels. Worth a look if the trace is ever
  used for a hard threshold near a reel's measured level.
- Not done here: music-side sound design (stingers from the track itself),
  per-sound hand placement in the UI (agents place by hand through
  `setSfx`), and the critic's use of the trace (W3-F).

## What was verified

- `pnpm check` (eslint, typecheck of every package, every vitest suite):
  see the PR body for the run.
- Unit tests, `packages/core/tests`: `audio-analysis.test.ts` (a synthetic
  click track at 120 bpm gives bpm 120, beats on the clicks, the energy
  curve's shape; a track that steps up 12 dB at bar 9 drops there, a flat
  loop has no drop; `reelBeats` across a start offset), `drop.test.ts`
  (own song moved, Instagram cut moved within source and minimum lengths,
  refusal when it cannot fit), `mix.test.ts` (a −23 dBFS 1 kHz sine
  measures about −23 LUFS; K-weighting lifts 10 kHz and sinks 50 Hz;
  gating ignores silence; true peak never under sample peak and catches an
  inter-sample peak; `gainToTarget`; the ducking envelope's shape;
  `recommendSoundVolume`'s three answers), `sfx.test.ts` (whoosh placed
  300 ms before each whip with its peak on the cut, riser and impact on the
  drop else the longest hold, ambience spans from room names, replace
  auto/keep hand-placed, idempotent, trimmed after a cut),
  `audio-trace.test.ts` (off-beat cuts, drop mid-shot, silence, the
  recommended volume; the shape above). `apps/web/lib/sound-commands.test.ts`
  (strict body parsing, drop filled from analysis, reel-time drop for auto
  placement). `packages/render/tests/sfx-assets.test.ts` (nine WAVs, mono
  16-bit 32 kHz of the documented lengths, web and render copies
  identical, asset keys).
- Rendered fixture, `packages/render/tests/sfx-fixture.test.ts`
  (`SFX_FIXTURE=1`, needs a browser and ffmpeg; Remotion's bundled ffmpeg
  is enough): a 6 s reel of two stills with a whoosh into the cut, an
  impact on it and room tone under all, rendered by `renderReel` through
  the shared composition, then measured. Run on 2026-10-22 with Remotion
  4.0.534's Chrome Headless Shell and ffmpeg, 12 s:
  - ffprobe: an AAC stream, 6.0 s.
  - Raw export: core's meter −23.4 LUFS / −4.8 dBTP; ffmpeg's `loudnorm`
    measurement −25.24 LUFS / −4.82 dBTP. True peak agrees to 0.02 dB.
  - The loudest 400 ms block ends at 3 250 ms (the impact on the 3.0 s
    cut); the room tone alone reads −48.9 LUFS, 30 LU under it.
  - Levelled by the worker's two `loudnorm` passes with core's filter
    strings: −19.64 LUFS / −0.89 dBTP. The ceiling bound first: +9.2 dB
    would have put the peak at +4.4 dBTP, so the linear correction stopped
    at −1 dBTP and the level stayed 3.6 LU under −16. The fixture asserts
    exactly that rule (within 1 LU of the target unless the ceiling binds,
    then under the ceiling and not over the target).
- The meter against ffmpeg, checked by hand while writing the fixture:
  steady sines at 40, 60, 100, 300, 1 000, 3 000 and 10 000 Hz agree
  within 0.07 LU; a 1 s burst in digital silence within 0.1 LU; a burst
  over a −50 LUFS tone within 0.06 LU. Only transient-heavy, near-silent
  material parts the two (1.3 LU on a decaying 70→38 Hz sine over noise,
  1.9 LU on the fixture): the K-weighting and gating constants match, so
  the difference sits in which partial blocks pass the relative gate.
  Not resolved; see Consequences.
- Not verified here: the worker's `music-analysis` step and the export
  sidecar against a real queue and storage (no local worker run; the code
  path reuses `decodeMono` and the S3 client the library importer already
  exercises), the routes against a running web app (typecheck and unit
  tests only), and the Music sheet and export page in a browser.

## Follow-up, 2026-10-23: three defects from the first real reel

Found on D4 (`output/series/d4-every-room-15s.md`, reel
`cmviasyex000701ad6xg2wpeq`, Instagram audio 1018160750329642 "Fresh Dance
Club (Instrumental)") the night the ADR shipped.

### 1. The tempo locked onto a harmonic

`detectBeats` read the track at 160 bpm with the first beat at 46 ms and
the drop at 8 671 ms. Measured offline on the same preview it is 120 bpm,
beats at 166 ms + k × 500 ms, drop onset at 7 666 ms: a 4:3 lock on the
track's dotted-eighth hats, which repeat every three sixteenths as strongly
as the kicks repeat every beat. Every cut the series had put "on the beat"
was 166 ms early, and `findDrop`, which looks only at downbeats, put the
drop a bar late.

The estimator now (`detectBeatsFromOnsets`): the autocorrelation still
finds the rough periods, but its strongest peaks (up to four, within half
the best score) and each one's harmonics (½, ⅔, ¾, 1, 4⁄3, 3⁄2 and 2 times
the tempo) are all fitted as beat combs over the whole onset curve, and the
comb whose beats land on the most onset energy wins. A log-normal
preference centred at 110 bpm (0.6 octaves wide) settles near-ties in
favour of everyday tempos: 160 must explain the onsets about half again as
well as 120 to be chosen over it. The first beat is where the winning comb
starts, so the phase and the bars `analyseSong` counts from it belong to
the chosen tempo. The comb at 4⁄3 of a dance track's tempo hits the hats
but misses every other kick; the comb at the tempo hits every kick and a
third of the hats. `AUDIO_ANALYSIS_VERSION` is 2: every cached analysis is
made again by the new detector the next time it is asked for.

Verified: the real preview (the editor's private copy, found in the agent
browser's cache, decoded with Remotion's bundled ffmpeg at 11 025 Hz mono)
now reads 120 bpm, first beat 174 ms, drop 7 674 ms, downbeats
1 674 + k × 2 000 ms, against the offline 120 / 166 / 7 666 / 1 666. The
whole 90 s analyses in about 60 ms (was 45). Its onset curve is kept as a
regression fixture, `packages/core/tests/fixtures/fresh-dance-club.onsets.json`
(a feature of the recording, 43 values a second, not the recording;
derivation in the file's `about`), and `beats.test.ts` asserts 120 bpm with
the beats within 40 ms of the measured grid. Two synthetic tracks fooled the
old detector and are tests too: kicks at 120 with louder dotted-eighth hats
(old answer 160 at every hat level tried, 0.4 to 1.1 times the kicks) and
kicks with a louder 3+3+2 tresillo of hats (old answer 96). The existing
click-track, song-map, pacing and Instagram-sound suites pass unchanged.

### 2. A corrected analysis did not reach the reel

`PUT /api/music/:audioId/analysis` replaced the cached analysis, but the
reel's `music` record kept its own tempo (119 bpm, offset 0), which the
pacing engine, `snapToBeat` and the critic's beat check read; the export
dialog kept saying "12 of 12 cuts land between beats" after the fix, and
"Snap to the beat" would have moved every cut onto the wrong grid.

The analysis is now the one source of the beat grid and the music record a
copy that follows it (`musicWithGrid`, `timelineWithGrid`: tempo, first
beat, bars and sections replaced; nothing else about the music, and no cut,
touched; the same object back when the grid already matches or no pulse was
found):

- `storeAnalysis` (the PUT) and the worker's `music-analysis` step write the
  asset's `bpm`, `beatOffsetMs` and `songMap` from the analysis, not only
  when they were empty.
- The PUT then puts every saved reel of the workspace that uses the sound on
  the grid, each as a new revision (`syncReelsToAnalysis`, found by the
  timeline's `music.assetId` with a JSON path filter); the response says
  `reelsUpdated`. An editor open on one sees the conflict on its next save
  and reloads, as for any other tab's save.
- The editor reads the analysis whenever the reel has a song (not only with
  the Music sheet open; decoding the private copy in the browser is still
  for the open sheet only) and, when the record differs, runs `setMusic`
  with the synced record, so the critic before export and "Snap to the beat"
  use the measured beats.
- `loadReel` for `/api/reels/:id/commands` puts the timeline on the song
  asset's grid before a command runs, so an agent's `snapToBeat` or `pace`
  works from the measured beats even on a reel nobody has opened since.

### 3. The checks reported the sound unchecked

`GET /api/renders/:id/checks` fetched this app's own audio-trace route over
HTTP with the caller's cookie; behind the proxy that request did not
answer, so `audio.available` was false while
`/api/reels/:id/audio-trace` answered 200 and the worker's
`<outputKey>.audio.json` sidecar was there. And the mapping expected titled
items: the trace's problems carry `kind`, `severity` and `detail`, so even
an answered trace would have folded in nothing.

The route now reads the trace in process (`reelAudioTrace`), and
`audioProblemsFrom` reads the trace's own shape (a title per kind: "Cut off
the beat", "Speech under the music", "Drop mid-shot", "Silence"; an id per
moment, `cut-off-beat@2000`, so every off-beat cut is its own line;
`severity: "high"` blocks, the rest warn). The export page reads the trace
once and folds the problems into the stored checks the same way, and the
Checks panel's foot says "sound checked: N problems listed above", "sound
checked", or "sound not checked" (`data-testid="checks-audio"`).

### Also: the recommended post volume was shown, not stored

The export page recommended the Instagram sound at 100 % over the reel's
own sound design at 60 %, but Post and Schedule stored the form's default
choice (100 / 0). `instagramChoiceForSound` takes the trace's
`recommended` mix and the page builds the reel's sound choice from it, so
the form starts on the recommendation and `reelPostData` writes
`audioVolume` / `videoVolume` from it (`posting.test.ts`). The studio can
still change the mix in the picker; a post already scheduled keeps its own.
`MixPreview` takes the page's trace instead of fetching its own.

### Not verified here

The routes, the editor's sync and the Checks panel against a running web
app and a browser (typecheck, lint and unit tests only); the worker's step
against a real queue. The fixture's phase differs from the offline measure
by 8 ms (174 against 166) and the drop by 8 ms; both are within one
analysis frame (23 ms).
