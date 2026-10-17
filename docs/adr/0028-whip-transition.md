# ADR 0028: Whip pan transition

Status: amended (2026-10-17)

The current transition is silent. The original synthetic whoosh was removed
after live review. Camera direction is explicitly selectable (left, right,
up or down); outgoing and incoming halves share that direction. The effect
is shorter and less stretched/blurred. Luxury finishing uses clean cuts and
removes existing whip accents instead of inserting them automatically.
Direction is chosen by the editor, not inferred from video pixels. The
original decision below records the superseded implementation.

## Context

Our reels cut or fade; the house-tour reels that travel (@improvbuild's
"HALO", 6K likes; the realtor helicopter entrance, 214 comments) move
between rooms with whip pans: the camera swings, the frame smears sideways,
and the next room comes out of the smear, with a whoosh. Leigh asked for that
feel. Shooting real whip pans needs a gimbal and planning; a transition can
give any two shots the same energy.

## Decision

- A fourth transition, `whip`, beside cut, fade and walk. Over the last 5
  frames of the outgoing shot it slides left, stretches and smears; the
  incoming shot arrives from the right out of the same smear over its first 5
  frames. The smear is a horizontal-only SVG Gaussian blur (CSS blur goes
  every way and reads as out of focus), up to 60 px; the shot is stretched
  wider than it moves, so no edge shows.
- A whoosh under every whip cut, peaking on the cut: 0.6 s of filtered pink
  noise made with ffmpeg for ReelWalk (no licence), inlined as a data URI so
  the editor preview and the worker play the same sound.
- In the editor's transition sheet as "Whip pan"; in Ask, "whoosh", "swipe",
  "whip", "smooth transitions" map to it (clip 0 = every cut).

## Consequences

- The whoosh is part of the reel's own audio. A post that also gets an
  Instagram sound needs its video volume above 0 to keep the whoosh.
- A whip on a very short clip (under 10 frames) blurs most of it; the
  editor allows it, as with fades.
