# ADR 0008: Walking between 360 photos by projecting them onto the room

Status: accepted (2026-10-05)

## Context

A tour reel was a series of 360 photos, each turning on the spot, joined by
fades. It read as a slideshow. The aim is one continuous camera move through
the home, from each photo's position to the next, with no visible cut.

Gaussian splatting (ADR 0007) gives the best picture, but needs a capture of
100+ overlapping photos per room. A home tour has one or two 360 photos per
room, and that is the material most agents have.

A tour in ZInD format also says, for every photo, where it was taken on the
floor plan, the outline of the room around it, and the camera and ceiling
heights.

## Decision

**Project each photo onto its room, and move the camera through the rooms.**

- A photo's position on the plan (`Spot`) can carry a `shell`: the room's
  outline, the camera height and the ceiling height.
- The 360 shader follows each pixel's ray to the wall, floor or ceiling it
  hits, then looks up the photo in the direction of that point from where
  the photo was taken. From the photo's own position the result is the plain
  360 view. From anywhere else, walls, floor and ceiling stay in place.
- A clip can enter with a `walk` transition. For the first part of the clip
  the camera travels from the previous photo's position to this one, and the
  picture is a blend of both photos, each projected onto its own room. The
  first frame equals the last frame of the previous clip, so there is no cut.
- `packages/core/src/walk.ts` decides the route and the motion, as pure
  functions used by the renderer, the plan overlay and the tests:
  - the route goes through doorways (shortest chain of doors on the plan),
    with corners rounded and an even pace along it;
  - position eases in and out with no sudden change of speed;
  - the camera turns from where the last clip was looking, through the
    direction of travel, to where the new clip starts, and a walk gets
    longer the more the camera has to turn (the fastest turn stays near
    110 degrees a second);
  - the new room's sweep begins before the walk ends, so the camera never
    stops dead;
  - the photos change at the doorway, and a surface that would be blown up
    right in front of the lens gives way to the other photo.
- Auto-build plans the tour as one walk: it starts in the living room,
  visits the rooms in the order with the least walking (every order is
  tried; there are at most nine stops), and on a leg that crosses another
  room it passes a photo taken there, so the camera always has a photo of
  the space it is in.

## Consequences

- It works from the photos a tour already has, in the browser preview and in
  the export, with no GPU service. The whole feature is one shader and one
  module of geometry.
- Only walls, floor and ceiling are modelled. Furniture, worktops and open
  door leaves are painted onto those surfaces, so they slide and stretch
  during a walk. In empty rooms this is hard to see; in furnished rooms it
  shows for the second the walk takes. A door leaf that stands right beside
  the camera (a small bathroom) fills the frame for a moment as the camera
  turns to leave.
- Walks need located photos with room outlines. Photos without them (the
  Poly Haven samples, uploads from a 360 camera) still cut or fade. Getting
  outlines for uploaded photos means estimating the room layout from the
  image (HorizonNet and similar models do this); not built.
- Cuts on the beat still set clip lengths, but with walks there are no hard
  cuts left to land on the beat.
