# ADR 0007: 3D flythroughs are rendered offline and enter the editor as video

Status: accepted (2026-10-04), experimental

## Context

A 360 photo can only turn on the spot. A flythrough, where the camera moves
through the room, needs a 3D model of it. Three ways were considered:

1. **Depth from one 360 photo.** Estimate depth and shift the camera a little.
   Works from existing media, but the camera can move only about half a
   metre before holes open behind furniture.
2. **A box room from the floor plan.** Project each 360 photo onto walls
   built from the plan. Clean geometry, but furniture is painted flat on
   the walls, and it needs a located tour.
3. **Gaussian splatting.** Reconstruct the room from many overlapping
   photos, then render any camera path. Photo-real, but needs a capture
   made for it (a slow phone video or 100+ photos) and a GPU.

Option 3 gives by far the best picture and was chosen for that reason.

## Decision

Reconstruction runs outside the application, as a script
(`infra/splat/reconstruct.sh`) in the nerfstudio container on an NVIDIA GPU.
It trains a splat (`splatfacto`), writes a camera path (`flythrough.py`) and
renders a 1080×1920 MP4. `import-flythrough` adds that MP4 to the media
library, where it is an ordinary video clip: trim, speed, text, music, the
details card and export all work without knowing where it came from.

The camera path is the capture path, smoothed. The script takes the
positions and directions of the training photos, smooths them over about
seven photos, levels the horizon, keeps a third of the up and down tilt, and
steps along the result at an even pace. A splat only looks right from near
the viewpoints it was trained on, so the path stays close to them.

## Measured (RTX 4070 12 GB, "playroom": 225 photos of one room)

| Step | Time |
| --- | --- |
| Train, 7,000 iterations | 5 min 44 s |
| Render 14 s at 1080×1920 | 2 min |

GPU memory stayed under 3 GB. The result is sharp on furniture, shelves and
floor. Flaws: soft smudges on plain ceiling where few photos looked, and a
plain wall can look flat and slightly blurred.

## Consequences

- The web app and worker stay free of GPU and Python dependencies. The
  cost is a manual step; nothing in the editor starts a reconstruction.
- It does not work from the 360 photos already in the library: one photo
  per room has no overlap to reconstruct from. A new capture is needed. A
  phone video becomes the same input with `ns-process-data video`, which
  runs COLMAP first (not yet tried here; expect 10 to 30 minutes more).
- If this becomes a product feature, it is a second job kind on the same
  queue with a GPU worker pool (a Kubernetes node group with
  `nvidia.com/gpu` limits), and the camera path would follow the floor plan
  rather than the capture.
- The sample scene is from a research dataset (Deep Blending, via the 3D
  Gaussian Splatting paper's data). Like the ZInD tours it is for local
  testing: the data is not in the repository and reels made from it are not
  for posting.
