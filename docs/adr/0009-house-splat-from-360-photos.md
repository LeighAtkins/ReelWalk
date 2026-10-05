# ADR 0009: A whole-home Gaussian splat from a tour's 360 photos

Status: accepted (2026-10-05), experimental

## Context

ADR 0007 builds a splat from 100+ overlapping photos of one room. ADR 0008
walks between a tour's 360 photos by projecting each onto a box of its room,
which looks like Street View: flat between photo positions.

The request was a real splat of the whole home from the 360 photos alone.
A tour has one or two photos per room. A splat learns depth from overlap
between photos, and here there is almost none.

## Decision

**Supply the depth the photos cannot, then train a splat that is not allowed
to make anything up.** (`infra/splat/house.sh`)

1. `panos_to_dataset.py` cuts each 360 photo into 18 ordinary views with
   exact poses (the tour says where each photo was taken and which way it
   faces): 26 photos become 468 views.
2. A depth model (Depth Anything V2) estimates relative depth per view. Each
   view is scaled and shifted to fit the distances the tour's room shapes
   give for walls, floor and ceiling. Where model and room agree within 25%
   the room's exact surface is used; elsewhere (door leaves, cabinets,
   worktops, the view through a doorway) the model's depth is kept. Nothing
   may lie beyond the floor or ceiling.
3. Each view's pixels are placed in 3D at their depth: 2.3 million coloured
   points, which seed the splat.
4. `splatfacto` trains on the views with positions frozen, no points added
   or removed, nearly round gaussians and colour that does not change with
   viewing direction. Trained freely, the splat fills the unseen space
   between photos with floating blobs; these settings prevent that.
5. The app exports a tour reel's camera route frame by frame
   (`export-camera-path.ts`), `house_path.py` converts it to the splat's
   coordinates, and the splat is filmed along the same route as the 360
   walk. The result is imported as a video with the reel's room names.

## Measured (RTX 4070, about 6 GB of GPU memory free)

| Step | Time |
| --- | --- |
| Views, depth and points for 26 photos | about 2 min |
| Train, 6,000 iterations | 5 to 8 min |
| Render 45 s at 1080×1920 | 4 to 15 min, depending on what else is using the GPU |

## Result

- Inside a room, near where a photo was taken, the picture is clean and has
  real depth: door leaves, cabinets and worktops stand in front of the walls
  and shift correctly as the camera moves.
- Crossing a doorway smears for a few frames. The camera passes through
  gaussians that were only ever seen from one side, and the depth of a door
  frame seen at a glancing angle is a guess.
- It is softer than the 360 walk: the source photos are 2048 pixels wide, so
  each 90 degree view has 512 pixels to fill a 1080 pixel frame.
- Compared with the 360 walk (ADR 0008): more real inside rooms, rougher
  between them. The 360 walk remains the default for tour reels.

## Consequences

- The quality ceiling is the capture. Two things would lift it most: 8K 360
  photos (four times the detail) and two or three photos per room instead of
  one, so that surfaces are seen from more than one side.
- Depth comes from a general model fitted to simple room shapes. A furnished
  home has far more that is not wall, floor or ceiling, so it leans harder
  on the model and will show more errors than this empty one.
- Like ADR 0007 this runs outside the app, on a GPU, as a manual step.
- The sample is ZInD data: local testing only, not for posting.
