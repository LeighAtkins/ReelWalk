# Typography reel, second attempt: "Bahia beach house"

Second pass at the owner's brief (see `2026-10-19-typography-reel.md`):
a 30-second listing reel with typography as the main feature, built in
the app, on a property that will stop a thumb. Built on the four fixes
from the first post-mortem (#148 post-mortem, #149 rigid plane pins and
whole-shot titles and surface blend, #150 presenter on clear floor).

## Rules carried over

1. Every title is in the room for the whole shot: on the wall when the
   cut lands, gone with the cut or the pan. No title pops in mid-shot
   without a reason.
2. One rigid plane per title; the text is painted on the surface
   (`blend: surface`), not laid on top.
3. The presenter stands on clear floor, occluded by what is nearer.
4. The property: Alef Morais's beachfront house in Bahia, Brazil (Pexels
   user alef-morais-336305364, IG @alef.visuals): white house on the
   sand, ocean from every window, glass stair, palms. Clips 39590048
   (aerial), 39576501, 39576503, 39576508, 39576509, 39576510, 39576511,
   39576512.

## Build log

1. Footage via Pexels' site API from the agent browser (the public
   search key the site itself uses), downloaded with the download
   endpoint, 4K → 1080p re-encodes. Eight clips to a new reel (upload by
   `DOM.setFileInputFiles`). **Slip 1 (as before):** still no Pexels in
   the app; still by hand.
2. Cut and titles written straight to the timeline (`/api/reels/:id/save`),
   then checked in the editor. Script: BEACHFRONT on the aerial ground,
   OCEAN VIEWS on the facade, presenter at the entrance with words
   behind, STEP OUT on the dark wall as the window is revealed, LIGHT on
   the stair wall, EVERY ROOM beside the window, WAKE UP HERE above the
   bed, DM FOR THE TOUR as the closer.
   **Slip 27:** a lone word wider than the frame (BEACHFRONT at 160%)
   wraps into two lines instead of shrinking to fit; the editor should
   cap a single word at the frame width.
3. Music "Golden Hours · Sliders Club" (Instagram, 108 bpm) chosen in the
   Music sheet; the cuts moved to the beat (total 28.9 s).
   **Slip 28:** retiming the cuts to a beat leaves the texts where they
   were, so every title slipped off its clip. Titles belong to clips;
   whole-shot pins fix it for pinned titles, but any text should move
   with the clip it was placed on.

4. #149 live. Six titles pinned from the Pin sheet, "For the whole
   shot" on, 35–41 keyframes each as one rigid plane; BEACHFRONT rides
   the ground plane of the aerial, LIGHT the stair wall, WAKE UP HERE the
   wall above the bed. STEP OUT on the dark wall was lost 0.1 s in (a
   bare wall has nothing to follow); moved onto the window edge and it
   held. Painted on the surface (`blend: surface`) for all but the closer.
   **Slip 29:** multi-word titles on a plane broke per word and mid-word
   (OCEA / N / VIEW / S): the tracked box is ~40% of the frame wide and
   the text treatment allows breaks anywhere. Fixed in #151 (one line,
   overflowing the box).
   **Slip 30:** writing the timeline from outside (`/save`) while the
   editor is open desynchronises its revision; the editor's next autosave
   is refused as a conflict and the music pick was lost without a visible
   warning. The editor should surface the conflict and offer to reload.

5. Presenter take with the new compose prompt (#150), 4 credits: Wide
   camera-move from the entrance clip's first frame, Maya composed onto
   the paving. First attempt usable: she stands on clear paving with a
   contact shadow at true scale, a small open-hand gesture, the camera
   eases in. No table under her feet this time. Placed as shot 3.
6. WELCOME / HOME behind her (`behind`, extruded, one beat apart at
   108 bpm). The preview's matte confirms she occludes the letters
   (4% person pixels at 9.6 s; the O of WELCOME and HOME vanish behind
   her head and arm). **Slip 31:** the Hook tool's "words behind the
   person" only writes to the first shot, so the words had to be added
   by hand on shot 3; it should take the selected shot.

7. First export failed: "Minified React error #300". **Slip 32:** a
   pinned title shown while another clip is on screen returned null
   before a hook ran (`useFontsFor`); whole-shot pins made a few frames
   of overlap routine after the beat retime, so every such title killed
   the render. Fixed in #152 (hooks first). The editor preview did not
   show it, so the first sign was a failed export six minutes later.

8. Second export failed: `delayRender() "Person matte frame 0" … not
   cleared after 28000ms`. **Slip 33:** at a take's first frame the
   matte's own video is already at time 0 but not loaded; setting
   currentTime to the same value fires no `seeked`, so the frame never
   drew. The first reel got away with it because its take was the first
   clip and had loaded by then. Fixed in #153 (wait for `loadeddata` when
   already at the target time). Two failed exports in a row, each found
   only after the render: the editor needs a quick "render the first
   frame of every shot" check before a full export.

9. Third export (render `cmvfgy53a000001addeitdu7r`, 28.9 s) checked
   frame by frame. Every title is on one line, painted on its surface
   and in perspective: BEACHFRONT lies on the aerial's ground, OCEAN
   VIEWS on the facade, STEP OUT on the window, LIGHT on the stair wall,
   EVERY ROOM beside the window, WAKE UP HERE above the bed. Maya stands
   on the paving with her shadow and hides the O of HOME. Titles leave
   with their pans and cuts; nothing pops.
   **Slip 34:** two titles start partly out of frame (OCEAN VIEWS loses
   its O at the cut; WAKE UP HERE loses its E on the right). The Pin
   sheet should refuse, or nudge, a plane whose text box crosses the
   frame edge at the shot's first frame.
   **Slip 35:** the machine's disk filled during the session (Docker's
   WSL disk at 138 GB: a kind node holding 94 GB of old release images,
   plus 12 GB of stale Remotion bundles in Temp), which took Docker down
   mid-task. Local render tooling needs a prune step.

## Verdict

Usable as a draft of the style: the typography lives in the rooms and
the presenter stands in front of it. Before posting: nudge the two
cropped titles inward, and consider a warmer grade across the interiors.
The fixes built from this attempt are #151 (one-line planar titles),
#152 (hooks before the early return), #153 (matte first frame) and #154
(render preflight, smoke test, pre-push check; ADR 0042). Slips 23–35 in
all; the backlog from them: titles move with their clip when music
retimes the cut (28), the editor warns on a save conflict (30), words
behind the person on any shot (31), the Pin sheet keeps a title in
frame (34).

## Owner's review of the export (2026-10-20, 01:40 MYT)

"All of the text positioning was bad, it's moving around on its own, not
sitting naturally in the frame." Measured on the exported paths:

| Title | Jump per step | Worst jump | Plane width over the shot | Shear |
|---|---|---|---|---|
| BEACHFRONT | 1 px | 0.3 px | 432–582 px | 99 px |
| OCEAN VIEWS | 4 px | 5 px | 411–454 px | 203 px |
| STEP OUT | 16 px | 131 px | collapses to 0 | 145 px |
| LIGHT | 21 px | 105 px | collapses to 0 | 17 px |
| EVERY ROOM | 7 px | 8 px | 317–432 px | 32 px |
| WAKE UP HERE | 16 px | 48 px | collapses to 0 | 24 px |

**Slip 36:** the "rigid plane" was a free 8-parameter homography fitted
from a handful of mixed-depth points at a third of the resolution, with
no gate on the result. Three planes collapsed to zero width mid-shot and
re-expanded; OCEAN VIEWS sheared by 200 px. Only the aerial ground
plane, flat and richly textured, held.
**Slip 37:** the starting plane is an axis-aligned box, so even a perfect
track reads as a frontal sticker; nothing set the wall's perspective.
**Slip 38:** the Pin sheet returned 40 confident keyframes for surfaces
it could not follow; no quality was reported.
**Slip 39 (process):** the export was verified from still frames, which
cannot show motion. A motion strip (nine consecutive frames per shot)
shows the collapse in one glance.

Fixes: #156 similarity/affine fit with per-step scale and rotation gates,
hold-then-fade on refused steps, a track grade in the Pin sheet; the lean
PR adds Turn and Tilt so the plane starts in the wall's perspective and
nudges a title in from the frame edge (slip 34); `.tools/motion-strip.sh`
for every future check.

**Slip 40:** a planar title never wraps, and OCEAN VIEWS at 110% was 108%
of the frame wide in the render while the editor's handle, capped at 86%
and wrapped to two lines, reported it as fitting; so the in-frame nudge
did nothing and the O ran off the left edge in every export. Fixed by
measuring the one-line width (canvas text metrics) in both places,
shrinking a planar title to at most 92% of the frame, and nudging from
that width.
**Slip 41:** the first fit (#158) measured the line with canvas metrics,
which ignore a variable font's width axis; the headline style is Archivo
at 125%, so it measured 30% short and changed nothing. Measured in the
deployed editor against the laid-out span, fixed in #159 with a hidden
span measurement and a fit computed on the line as projected through the
leaned plane. Lesson: verify a fix by measuring the thing it changes in
the real page, not the proxy it was computed from.
**Slip 42:** the in-frame nudge moved the title's centre x, but a planar
title is drawn from its pinned corners, so the plane never moved; the
nudge in #157 and #159 had no visible effect. Measured in the editor
(line centre 0.41 while x said 0.57). Fixed by translating the pinned
quad and every keyframe's corners by the shift.

## After the fixes (2026-10-20, 04:50 MYT)

Export `cmvg22q9e000001ad8fowkzfx`, every title re-pinned with the new
fit, checked on a motion strip and on the saved paths: no plane
collapses or shears; worst single jump 5 px (was 131); OCEAN VIEWS
starts fully in frame, leans 30° into the fascia and leaves with the
pan; WAKE UP HERE starts in frame and grows with the push-in; LIGHT and
EVERY ROOM hold steady; WELCOME / HOME sit behind the presenter. The Pin
sheet now says how good each track is (WAKE UP HERE's bare wall: "weak,
7 points"), so a bad surface is known before export. Fixes #156–#160.

## Third pass: painted on a surface (2026-10-20, 12:30 MYT)

Owner: "find a flat clean surface to pin everything to; it should look
painted on the surface", and "the masking was not clean enough, there was
still clipping". Built: #162 surface pins (ADR 0043: a title carries the
four corners of the wall it is painted on, found from the picture's edges
or dragged by hand; the render lays the text inside that plane), #163 a
cleaner matte (crop re-segmentation, guided-filter edge, 1 px grow,
temporal blend), #164 tracking a bare wall by the motion around it.

**Slip 43:** automatic surface detection from Hough lines found nothing
usable on four of five real frames (perspective edges are diagonal; a
wall's far side often has no edge; the strongest lines are rarely the
wall's). The corners were set by hand against a 10% grid. The detector
now proposes only when four sides are real and convex; the dragged
corners are the real tool.
**Slip 44:** a surface pin on a bare dark wall could not track at all
(no detail by definition) until the tracker borrowed points from the
surroundings (#164).
**Slip 45:** a title fitted to a long thin band comes out small; the fit
should use the band's height as well as its width.

Measured on export `cmvg5j1mk000001ad5k02kscx`: OCEAN VIEWS on the
facade band, 22 points, worst jump 2 px, reads as paint; LIGHT on the
stair wall, 7 points, holds; WAKE UP HERE on the bed wall, worst jump
39 px before #164. Matte: hair and hand edges cleaner; a faint halo
remains on backlit hair.

## Owner's review of the surface pass (2026-10-20, 12:45 MYT)

Marked on screenshots of export `cmvg6ns4k000001adg9gh6upm`:

- **Slip 46: every title in the wrong spot.** BEACHFRONT belongs on the
  road, not across the houses; OCEAN VIEWS on the broad white slab face
  under the louvres, not the louvre line; LIGHT lower, on the sunlit part
  of the wall; WAKE UP HERE at window level, not on the ceiling slab. I
  read the facade's geometry wrong at the first frame (the band runs down
  to the right, not up) and chose surfaces by what tracked, not by what a
  viewer reads as the wall. Surfaces re-set to the marks.
- **Slip 47: the presenter's face is distorted.** The composite keeps her
  at true human scale in a wide frame, so her head is about 80 px tall
  and Veo renders it soft. A second take asking for a medium shot came
  back at the same scale (the scale rule wins). Fix: a zoomed crop of
  the plate uploaded as a still, composed and animated from that, so the
  face is 120 px or more.
- **Slip 48: the raised arm is not masked.** Thin, low-confidence parts
  fell below the alpha band. #166 grows the mask 2 px and accepts from
  0.18.
- **Slip 49: text drawn in the distance but over the foreground.** STEP
  OUT sat on the window plane yet drew over the dark wall in front of it;
  LIGHT over the railing. A painted title must not exist outside its
  surface: #166 clips the text to the warped surface box, so the surface
  must be chosen as the visible pane (STEP OUT and WAKE UP HERE now sit
  on the window glass).
- **Slip 50: "ugly finish".** The red boxed tag "DM FOR THE TOUR" is off
  the house style (serif, quiet). Replaced with a serif white line.
- **Slip 51 (found while re-pinning):** the in-frame nudge translated a
  surface pin's corners off its wall; #167 restricts it to box pins.
