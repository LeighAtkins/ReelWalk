# Sound effects (`packages/render/public/sfx`)

Every file in the set was synthesised from scratch by ReelWalk's own script,
`packages/render/scripts/make-sfx.mjs` (plain Node, no dependencies, no
network): seeded noise and sine oscillators through hand-written biquad
filters. The set contains **no recorded or third-party material**. Rendering
is deterministic, so `node packages/render/scripts/make-sfx.mjs <dir>` gives
byte-identical files; `check-sfx.mjs <dir>` reports each file's length, peak,
the whooshes' peak time and the loops' seam.

**Licence: CC0 1.0 Universal (public domain dedication).** ReelWalk
dedicates these files to the public domain. They may be used in any reel,
export or product without attribution.

Format: WAV, PCM 16-bit, mono, 32 000 Hz. Peaks at −3 dBFS (impact −1 dBFS,
room tone −30 dBFS). The loop sounds are crossfaded onto themselves and loop
without a seam.

| File | Length | What it is |
| --- | --- | --- |
| `whoosh-1.wav` | 700 ms | Cinematic whoosh, noise sweeping up 400→4000 Hz; peaks at 300 ms, so it is placed 300 ms before a cut. |
| `whoosh-2.wav` | 700 ms | Whoosh sweeping down 3500→500 Hz; peak at 300 ms. |
| `whoosh-3.wav` | 700 ms | Whoosh sweeping 600→2500→800 Hz; peak at 300 ms. |
| `riser.wav` | 3000 ms | Tension riser: noise opening 150 Hz→9 kHz under a three-voice tone cluster rising an octave; full level at the very end (the hit). |
| `impact-soft.wav` | 900 ms | Soft impact: a sine dropping 70→38 Hz with an exponential decay and a quiet click; peaks in the first few ms. |
| `fire.wav` | 4000 ms, loop | Fire crackle: a modulated low rumble under sparse crackles. |
| `water.wav` | 4000 ms, loop | A gentle stream with slow movement and occasional bubble pings. |
| `wind.wav` | 4000 ms, loop | Wind or snow: pink noise through a wandering resonant low-pass. |
| `room-tone.wav` | 4000 ms, loop | Quiet room tone: very low-level pink noise. |

History: ADR 0028's whip transition once carried an ffmpeg-made whoosh inlined
as a data URI; it was removed after a live review. This set is placed by the
`autoSfx` command (ADR 0066), never automatically, and can be removed with
one command.
