# Typography reel: "The Monochrome House" (first attempt, not posted)

Goal set by the owner on 2026-10-19: a 30-second listing reel with
typography as the main feature, built entirely in the app, in the style
of the Instagram listing reels where titles sit in the room (tracked to
walls and floors), hooks appear behind the agent as she walks, and 3D
titles carry a luxury grade. Stretch goal: the AI presenter masked,
walking in front of type in a moving shot. Log every place the app slips.

## What the reference reels do

From the owner's logged-in Instagram (search "real estate typography
reel", 2026-10-19): @rawcutslife's "Realestate captions?" tutorial (2.5K
likes) on tracked captions behind the presenter, sourced from
@four.horsemen.media; @anthony.vidiomedia's word-by-word kinetic title
behind a walking agent (#kinetictitles); @flux_videoeditor's "creative 3D
TEXT" extruded titles on the lawn. The moves: words anchored in world
space, the person in front of them, extruded 3D type, one word per beat.

## Footage

- Pixabay (the app's stock search, key verified live): thin on real
  interiors; best hits were an AI-generated lounge, a lake-house exterior
  and a pool garden. **Slip 1:** the in-app stock search cannot supply a
  property.
- Pexels: a monochrome house set (ids 36030660–36030670, seven 5–6 s
  portrait 4K clips: bedroom, three living-room pans, dining from the
  stairs, TV-wall push). Pexels' site is behind a bot wall in the
  browser, but the download endpoint works. **Slip 2:** no Pexels in the
  app; clips had to be downloaded, downscaled with ffmpeg (4K → 1080p)
  and uploaded by hand. Creator attribution could not be read from the
  walled page.

## Build log

1. New reel from seven uploads: fine. Clips land progressively (40.8 s).
2. "Ask Opus → Make it for me, up to 3 credits" with the typography brief.
   **Slip 3:** the first live run failed with HTTP 400 from Claude: the
   voiced-takes schema (#127) wrote the nullable `voice` enum as
   `type: ["string","null"], enum: [...]`, which structured outputs
   reject. Fixed in #131 (anyOf) with a test; cost one round trip and a
   deploy. The director path still has no recorded live-model fixture
   (post-mortem item 11), which is why this reached production.

4. Added "MONOCHROME" (headline, 200%, extruded) on the first living-room
   pan and pressed Pin. Tracking ran in about a second and wrote 31
   keyframes; at 2.4 s the title has moved and rotated with the pan,
   locked to the stair wall. **Works.**
   **Slip 4:** a ten-letter word at 200% wrapped mid-word ("MONOCHROM /
   E") inside the 86% text box; fixed in #132 (single words never wrap).
   **Slip 5:** extrusion reads as a thin outline at this size; the stack
   needs to scale with the font size.
   **Slip 6:** a pinned path is stored in the text's own lifetime, so if
   the clip under it is later trimmed or reordered (which the director
   run will do), the keyframes no longer line up with the picture. The
   path should be anchored to the clip's source time and re-derived.
   **Slip 7:** a failed director request cannot be retried with the same
   brief: the sheet reuses the request id and gets the same failed job
   back; the brief has to be edited.

5. Added Maya's walk-e take (an existing AI clip) as clip 8 and a "WALK IN"
   title over it with "people pass in front" on. The text drew, the matte
   did not. **Slip 8:** the app's CSP allows scripts from its own origin
   only and MediaPipe's WASM loader comes from jsdelivr; the console
   showed the block. Fixed in #133 (same-origin rewrites for the runtime
   and model; the render keeps the CDN). Could have been caught by a
   preview test with a `behind` text.

6. The owner looked at the draft: "the tracking is wobbly despite the smooth
   camera movement." **Slip 9:** integer-pixel matching on a 216×384
   analysis frame (five-pixel steps at 1080p) and no smoothing. Fixed in
   #137: sub-pixel refinement, 360×640 analysis, two centred 1-2-1 passes
   over the keyframes. **Slip 10:** merges landing minutes apart cancel
   each other's main CI image builds, so a deploy of an intermediate
   commit waits for images that never come; deploy the latest main only.

7. Second director run on the deployed schema fix. **Slip 11:** Opus
   returned `note: ""` and the plan parser rejected the whole paid review
   on a one-character minimum. Fixed in #139 (prose may be empty). Two
   live-model failures in a row that a recorded fixture would have caught
   before deploy; item 11 of the villa list moves up.

8. Owner's review of the draft: tracking "looks 2D but we want 3D", and no
   masking shots seen yet. Both fair: the pin is a 2-D similarity track
   (position, scale, rotation), not a planar homography, so a title on a
   wall at an angle does not foreshorten; and the matte had not drawn
   because of slip 8. **Slip 12:** 3-D feel needs a four-point planar
   track (homography) and a CSS `matrix3d` on the text; logged as the
   next tracking step. Owner also pointed at two more references: the
   operator's eight listing shots (now Veo camera-move presets, #138,
   ADR 0040) and a catalogue of visual hooks (now the Hook tool, #141,
   ADR 0041), with $30 of Veo credits authorised for hook footage.

9. Third director run, on the deployed fixes, "Make it for me, up to 3
   credits". Review in 90 s; Opus reordered and trimmed to six clips at
   4–4.5 s (26 s), kept the MONOCHROME title untouched as asked, proposed
   the presenter shot third with composed start/end stills (presenter
   reference from an earlier Maya take, placement written against the
   sofa back and the wall art) and started it: 1 credit. Prompt uses the
   new camera-move vocabulary. **Slip 13:** it removed clip 7 "because
   it could not be reviewed" — real clips get only three sampled stills
   each (the evidence budget favours AI candidates), so a clip can be
   dropped for lack of frames. **Slip 14:** "music is now Beautiful from
   Instagram" is in the applied list but the timeline has no music: an
   Instagram sound pick needs the client to import the sound, which the
   run loop does not do (the manual Ask flow has that step).

10. The presenter shot never left SUBMITTING. **Slip 15:** the first
    composed keyframe in production hung the worker: `portraitJpeg` ran
    ffmpeg on `pipe:0` through `promisify(execFile)`, which cannot feed
    stdin, so ffmpeg waited forever. Fixed in #142 (temp file). What
    worked: stopping the task made the next worker fail the stale job
    with a refund ("Generation was interrupted"), and the run loop ended
    cleanly with "did not come out … credit is returned". Balance back
    to 5.

11. Hook tool live (#141): the "system alert" opener renders over the
    first shot in the editor with the listing's line; the pinned title is
    still in place after Opus's re-trim, so the source anchor (#135)
    holds. Next: #142 (worker compose fix) deploys, the run is repeated,
    and the words-behind hook goes on the presenter take.

12. Fourth run (worker fix live), "Make it for me, up to 3 credits": the
    loop went three rounds on its own. Take 1: locked camera, room
    matched, but Maya teleported forward at 2.9 s and ended inside the
    coffee table (Opus caught it from measured motion and the frames,
    scale and presenter checks failed). Take 2: walked laterally and left
    frame. Take 3: stood still behind the table, full length, face
    visible — rejected only because the brief said "walking". Budget
    exhausted, run stopped cleanly with the cut and title intact. Music
    was set in the plan each time but the timeline still has none (slip
    14). Veo cannot be trusted to walk a person toward a locked camera
    between two composed depths; a standing presenter, or a camera move
    toward a standing presenter, is the reliable plate. Take 3 becomes
    the opening shot. **Slip 16:** a pinned title is drawn at its base
    position on clips other than its own; it should be hidden there.
    **Slip 17:** AI takes made during a run do not appear in the editor's
    media picker until the page is reloaded.

13. Take 3 placed first, alert hook removed, "words behind the person"
    applied: BLACK · WHITE · YOURS appear staggered, extruded, over the
    standing presenter. MediaPipe now loads same-origin. **Slip 18:** the
    segmenter threw "ROI width and height must be > 0" because the
    matte's hidden decode was styled 1×1 px; fixed in #144 (full size,
    opacity 0) together with slip 16.

14. "DINE" and "REST" pinned in perspective on the dining and bedroom
    walls (29–31 keyframes each, ~3 s): the planar pin leans with the
    wall. Music set by hand. #144 live: the matte still drew nothing in
    the preview — **slip 19:** Remotion's `onVideoFrame` handed the
    segmenter an element with no loaded frame. #146 gives the matte its
    own seeked decode.

15. Fifth run, 1 credit, "stand still, camera pushes in": take 4 has no
    camera move and a size jump at 0.8 s (Opus: scale fail, camera fail,
    the stair rail warps at the end), though its last three seconds are a
    clean medium plate. Across four composed takes the pattern is the
    same: when the composed end still differs from the start, Veo morphs
    the subject toward the end composition instead of moving the camera.
    **Slip 20 / design note:** for a camera move the end still must be
    derived from the start still (a crop or zoom of the same composite),
    or omitted; a fresh composite of a nearer presenter reads as "make
    her bigger". Tried next: the new Wide camera-move preset from take
    3's own last frame, no end still.

16. Take 5: the new "Wide · locked, walk forward" preset from take 3's
    own last frame, no end still, "Match the original": a real slow
    push-in, she stays put, identity holds, 88 s. **This is the plate.**
    It replaces take 3 as the opening shot under the words. **Slip 21:**
    after "Add to reel" from the AI panel the pinned MONOCHROME title was
    gone; the panel's default-on "Finish the promo with luxury type"
    option appears to rewrite existing texts. Re-pinned by hand.

17. #146 live: the matte draws. At 2.6 s Maya stands in front of WHITE
    and YOURS with the letters occluded by her body while the camera
    pushes in — the stretch goal, in the editor's preview. Export
    started (30.0 s, 1080×1920, music "Beautiful" attached by Instagram
    at post time).

18. First export (render `cmvf87d0c000001ad4o47ayhn`, 30.0 s, 1080×1920,
    30 fps, H.264) checked frame by frame. The matte survives the render:
    at 2.4 s Maya occludes WHITE and YOURS while the camera pushes in.
    DINE and REST sit flat on their walls through the pans. **Slip 22:**
    MONOCHROME, planar-pinned to the stair wall, rendered as MONO / CHRO /
    ME. The warped box is only as wide as the surface the pin followed,
    and the text treatment's `pre-wrap` + `overflow-wrap: anywhere` on the
    inner span beat the box's `nowrap`. Fixed in #147 (a lone word on a
    planar pin never wraps, as #132 already did for drifting titles).
    Note (not a slip): the MP4 has no audio stream. That is by design for
    an Instagram sound, and the export page already says so ("The video
    file has only your clips' own sound; Instagram adds this one when it
    posts") and offers "Play with sound" for a preview mix.

19. Re-exported after #147 deployed (render `cmvf9z4k0000001ad7lnh2qzm`).
    MONOCHROME now holds one line and rides the stair wall in
    perspective through the pan, sliding out of frame left as the wall
    does. The matte still occludes WHITE and YOURS at 2.4 s. Note for
    the next pass: at this size the title fills the frame width, so the
    pan crops its first letters within a second; a planar title should
    default to about 70% of the tracked surface's width.


## Owner's verdict (2026-10-19, 21:30 MYT)

"Treat this as a first learning step." Not usable: too many mistakes.
The owner's four points, logged as slips, are the brief for the second
attempt.

- **Slip 23: text that just appears and disappears.** BLACK / WHITE /
  YOURS pop in staggered and vanish at the cut; MONOCHROME, DINE and
  REST exist only for their 3-second pin windows inside a longer shot.
  In the reference reels every word is *in the room*: it is already on
  the wall when the camera finds it, it leaves when the camera pans off
  it or the shot cuts, and when it does enter on screen the entrance is
  motivated (revealed from behind the presenter, wiped on by her hand,
  built word by word on a beat). Rule for the app: a pinned title spans
  the whole clip by default (track from the clip's first frame to its
  last, and if the tracker loses the surface the title fades over a few
  frames rather than cutting); any title that starts mid-shot needs an
  entrance.
- **Slip 24: the presenter does not belong to the room.** Take 5 reads as
  a cut-out: she stands on top of the coffee table, in front of furniture
  that should be in front of her, with no contact shadow and flat
  lighting. The composed still (ADR 0036) places her by a person-scale
  estimate, not by the floor plane, and nothing checks what is between
  her feet and the camera. Rule: place the presenter only on visible
  clear floor, below the horizon line, and prefer plates where the
  foreground is empty; or generate the whole shot (presenter and room)
  in Veo so lighting and occlusion come from one model.
- **Slip 25: pinned text is not in the 3D scene.** The four corners are
  four patch trackers that drift independently, so the quad breathes
  and shears; and the glyphs are pasted on, not shaded or blurred like
  the wall. "Consistently like as if it was in a 3D environment, not
  just the pinning on position but all the corners." Rule: track many
  points on the surface and fit one rigid homography per frame (RANSAC,
  temporal smoothing of the homography itself, not the corners); set
  the initial quad from the wall's own perspective (vanishing lines),
  not an axis-aligned box; composite with the surface (multiply or soft
  light onto a light wall, slight blur to the footage's softness, grain).
- **Slip 26: the property.** A monochrome suburban interior will not stop
  a thumb. The second attempt needs a location with an exterior hero
  shot (pool, water, skyline or cliff), light and colour.

## What to build before the second attempt

1. Pin spans the clip (slip 23): default range = whole clip, fade on
   track loss, entrance presets for mid-shot titles.
2. Rigid plane tracking (slip 25): `trackPlane` in core replaces four
   independent `trackPatch` corners; homography smoothing; surface blend
   option on the text.
3. Presenter placement guard (slip 24): compose only onto clear floor,
   or a Veo-native presenter shot without a composed still.
4. Footage source (slip 26 and slips 1-2): a way to bring a Pexels set
   into a reel without hand downloads.
