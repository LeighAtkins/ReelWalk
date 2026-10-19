# 0039 - Type that lives in the shot: tracking, occlusion, depth

## Context

The listing reels that get watched put the words *in* the room: a title
stuck to the lawn or a wall that pans with the camera, lines of a hook
appearing word by word behind the agent as she walks, extruded 3D titles
with a luxury grade. The owner asked for a 30-second reel built in-app
with typography as the main feature, including AI shots with the
presenter walking in front of the type. The app had static text with a
two-point drift path, no tracking, no occlusion and no depth.

## Decision

Three additions, all editable timeline data so Opus and the studio use
the same tools:

- **Path keyframes carry scale and rotation.** A text's `path` points
  (`t`, `x`, `y`) gain optional `s` and `r`; `textPositionAt` interpolates
  all four; up to 64 points. The composition applies them.
- **Pin to the picture.** In the editor, "Pin" on a selected text tracks
  the surface under it through the clip it starts on: two grey patches
  either side of the text's centre are matched frame to frame at 10
  samples a second (the motion module's patch matcher, in the browser),
  giving position, scale and rotation; the result is written as the
  text's path, so it needs no special renderer and can be edited or
  removed like any path. Tracking stops and holds when a patch is lost.
- **People in front.** A text may be `behind`: for the clips it overlaps,
  the composition draws a person-only matte above the text layer from a
  second decode of the clip through MediaPipe's selfie segmenter (model
  and runtime from the public MediaPipe CDN). The same matte works for
  AI takes, which is how the presenter walks in front of the type.
- **Depth.** `depth: "extruded"` stacks offset shadows for a 3D title.

## Consequences

- The matte is computed in the browser during preview and in headless
  Chrome during render, at a few tens of milliseconds a frame; a 4-second
  clip adds seconds, not minutes. Render depends on the MediaPipe CDN
  until the model is hosted with the bundle.
- Planar tracking from two patches handles pans, pushes and gentle
  rotation; it does not handle perspective skew on walls at steep
  angles. That is the next step (four patches → homography).
- Text that crosses a cut is tracked only on the clip it starts on.

## Addendum (2026-10-19, after the first reel)

The first typography reel (docs/postmortems/2026-10-19-typography-reel.md)
showed three faults in this design, fixed together:

- **Four corners drifted apart.** Each corner was its own patch tracker, so
  the plane breathed and sheared. The tracker now follows many points on
  the surface (`planePoints`), fits one rigid homography per step to the
  points that agree (`robustHomography`, RANSAC then a least-squares
  refit) and moves the quad by it (`trackPlane`). Lost points ride along
  with the plane and are topped up from the current frame.
- **Titles popped in and out mid-shot.** A pin now spans the whole clip by
  default (the Pin sheet's "For the whole shot"), so the title is on the
  wall when the cut lands and leaves with the cut or the pan. If the
  surface is lost, keyframes carry an opacity `o` and the title fades over
  a quarter of a second instead of cutting.
- **Glyphs were pasted on.** `blend: "surface"` composites the text with
  hard-light, a slight blur and 92% opacity, so the wall's light and grain
  show through the letters.
