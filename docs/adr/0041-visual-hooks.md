# 0041 - Visual hooks

## Context

A hook is whatever stops the thumb in the first second, and the owner
pointed at a creator's catalogue of visual ones (cj.filmed.it, 2026-10-19):
words behind the walking subject, the subject inside a phone or monitor,
a fake system alert, a physical reveal, a colour spotlight, a walk-in that
snaps into a title. Listing reels open on a drone shot and lose the scroll.
The owner wants these producible for every user from the reel's own
footage, in Remotion where possible and with Veo where it must be.

## Decision

`timeline.hook` holds one drawn hook for the first `durationMs` (0.8–4 s):

- **alert**: a phone-style alert card over the first shot with the
  listing's line ("Price drop", "Open home Sat 11") and an action button;
  pops in, holds, fades.
- **spotlight**: a flat colour field with only the person of the first
  shot cut out (the person matte of ADR 0039), a big title, then the
  colour irises away to the room.
- **device**: a dark field with a phone-shaped window onto the footage
  that grows until its screen is the frame.

"Words behind the person" is a preset, not a hook record: it writes three
staggered, extruded, `behind` texts over the first shot, so it stays
editable and pinnable like any title. The Hook sheet in the editor offers
the four, with the words, line, colour and length. Hooks are drawn above
clips and texts and below the logo and watermark, in both preview and
render.

Veo is used for the hook footage itself when the footage cannot be shot:
a presenter opening the front door toward camera, stepping out from behind
a wall, or dropping into frame, generated with composed keyframes
(ADR 0036) and then layered with the same words-behind preset. The owner
authorised $30 of credits for the first set.

## Consequences

- Alert mimics a phone's system dialogue; it is drawn in our own type and
  colours, not a copy of any vendor's assets.
- Spotlight depends on the matte quality; a wide shot of a small figure
  will fringe. The sheet says to use a medium shot.
- A walk-in freeze title and a physical reveal (zip, paper) are not in
  this change; the freeze needs a frame-capture-to-still tool, the reveal
  needs a reverse-play or a Veo plate.
