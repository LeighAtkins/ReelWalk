# 0040 - The operator's eight listing shots as Veo camera moves

## Context

The owner pointed at a listing videographer's "8 shots I use on every
listing" (Instagram, 2026-10-19): Cathedral, Twisting, Tilt, Wide, Pull
back, Detail, Static, Timelapse, each card giving the lens and what the
hands and body do on the gimbal. These are the moves that make a listing
reel look shot by a professional, and an agent with a phone cannot make
most of them. Our Veo path had generic presets (gimbal push, drone rise,
orbit, fly-through, timelapses) whose prompts described a result, not a
move.

## Decision

Seven new shot modes, one per operator move (timelapse already exists as
day-to-night), each with a recipe: the lens, the hands, and a Veo prompt
written in the operator's terms: what the lens points at, how the body
moves, what rolls or tilts, the speed, and what must not change ("smooth
gimbal motion, no cuts"). A move starts from a photo or a frame of the
room ("Start exactly from the supplied first frame") and, when the
anchor is a still, replaces it in the timeline keeping its duration, like
the existing photo-to-gimbal mode. The AI video panel shows the lens and
the hand note for the chosen move. Opus's director instructions carry the
same vocabulary so its own prompts use it.

## Consequences

- One credit per 4-second move; two moves on a room photo give a cut that
  reads as a shoot, which is the promise of the product.
- Veo interprets "arc", "roll" and "creep" loosely; the recipes are the
  first version and will be tuned against takes, the way the villa prompts
  were. Composed keyframes (ADR 0036) apply when a presenter is in shot.
- An "8-shot listing" one-tap plan (pick a photo per room, get the set) is
  the obvious next step and is not in this change.
