# 43. Pin a title to a found surface

Date: 2026-10-20

## Context

The owner's review of the second typography reel: the titles should look
painted onto a flat, clean surface, with that surface's perspective, not
float near it. A box drawn around the text (ADR 0039) and a hand-set lean
(#157) cannot do that: the plane never matches the wall's real geometry,
and OCEAN VIEWS on the receding facade read as a sticker.

## Decision

A title may carry a `surface`: four corners in frame fractions. The Pin
sheet's "Find a flat surface" takes the frame the title starts on and
finds the strongest edge left, right, above and below the title with a
gradient-guided Hough transform (`findSurfaceQuad` in
`packages/core/src/surface.ts`), intersecting them into the quad. The
preview draws the surface as a dashed outline with four draggable
corners, so the author can set it on the wall's edges by hand or correct
a detection. Pinning tracks that plane (points sampled on the surface
and along its edges), and the render lays the text inside the plane's
rectangle, fitted to 86% of its width, warped by the rectangle-to-quad
homography, so the title has the surface's own perspective. Choosing or
clearing a surface drops the existing pin, which must be redone on the
new plane.

## Consequences

Turn and Tilt remain for titles without a surface. Detection needs
visible edges; a bare wall returns nothing and the sheet says so. The
quad is a static plane: a title on a curved or moving surface is out of
scope.
