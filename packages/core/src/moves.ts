/**
 * The camera-move library (ADR 0076): the moves listing creators make, as one
 * table. Each move has
 *
 *  - an AI side, the words Veo is told (lens, what the hands do, the prompt),
 *    extending the gimbal vocabulary of the AI director (cathedral, twist,
 *    tilt, wide, pull back, detail, static; ADR 0040), and
 *  - where a 2D crop can honestly do it, a real side: eased camera keys
 *    (ADR 0067), a speed ramp (ADR 0067), and a speed-ramp transition with a
 *    zoom or streak blur on the cut into or out of the clip (ADR 0073/0074).
 *
 * A move with no real side (`real: null`) is AI-only because it needs
 * parallax, perspective or rotation that footage already shot cannot give:
 * a dolly zoom, an orbit, a roll. The editor's camera only scales and shifts,
 * so it is never offered there.
 *
 * Pure data and pure functions, no DOM: the Moves sheet, the `applyMove`
 * command, the AI request and the agents' HTTP surface all read this table.
 */
import { cameraPreset, cameraKeysAt, customCamera, easeValue, CAMERA_SHIFT_MAX, type Camera, type CameraKey, type CameraPreset } from "./camera";
import { rampPreset, type RampPreset } from "./ramp";
import { speedRampSchema, type SpeedRampParams } from "./speed-ramp-params";
import { updateClip, type Clip, type Timeline } from "./timeline";

export const MOVE_IDS = [
  "slow-push", "pull-back", "super-dolly-in", "crash-zoom", "push-through", "push-settle", "snap-in",
  "tilt", "crane-down", "parallax-slide", "handheld", "static", "whip-pan-right", "whip-pan-left",
  "dolly-zoom", "orbit", "reveal-behind", "rise-over-roof", "top-down-spin", "hyperlapse-walk",
  "fpv-fly-through", "cathedral", "twist", "wide-walk", "detail-orbit", "timelapse",
] as const;
export type MoveId = (typeof MOVE_IDS)[number];
export const isMoveId = (value: unknown): value is MoveId => typeof value === "string" && (MOVE_IDS as readonly string[]).includes(value);

export const MOVE_GROUPS = ["push", "pull", "reveal", "slide", "orbit", "whip", "fly", "locked"] as const;
export type MoveGroup = (typeof MOVE_GROUPS)[number];
export const MOVE_GROUP_LABELS: Record<MoveGroup, string> = {
  push: "Push in", pull: "Pull out", reveal: "Reveals", slide: "Slides", orbit: "Orbits and spins", whip: "Whips", fly: "Fly-throughs", locked: "Locked off",
};

/** The real (deterministic) side of a move: what is written onto a clip that is footage already shot. */
export type RealMove = {
  /** Camera keys, a camera preset's name, or null to clear the clip's eased move. Absent: the clip's camera is left as it is. */
  camera?: CameraPreset | CameraKey[] | null;
  /** The clip's speed ramp (ADR 0067). Video only. */
  ramp?: RampPreset;
  /** Also switch the clip's simple Ken Burns move off. */
  holdMotion?: boolean;
  /** A speed-ramp transition into this clip (ADR 0073); a move with no camera and no ramp is only this, so the first shot, which has no cut, refuses it. */
  cutIn?: Partial<Omit<SpeedRampParams, "auto">>;
  /** A speed-ramp transition into the next clip (the push that ends on a cut). Skipped on the last shot. */
  cutOut?: Partial<Omit<SpeedRampParams, "auto">>;
};

/** How a move is drawn in its card's loop when there is no camera to draw (an AI-only move): a sketch, never a promise of the footage. */
export type SketchKey = { p: number; scale: number; x: number; y: number; rotate?: number; ease?: CameraKey["ease"] };

export type AiMove = {
  /** The lens an operator reaches for. */
  lens: string;
  /** What the hands and body do on a real shoot. */
  hands: string;
  /** What Veo is told about the camera. Ends with the clause that keeps the take one continuous shot. */
  prompt: string;
  /** Shots whose light changes or whose camera does not move are locked off: no gimbal clause. */
  locked?: boolean;
  /** The length that gives the move room: 4 s unless it has to progress. */
  seconds: 4 | 8;
  /** Where it works: a flat interior photo, an exterior with air around it, or either. */
  best: "interior" | "exterior" | "any";
};

export type Move = {
  id: MoveId;
  label: string;
  group: MoveGroup;
  /** One line for the card. */
  blurb: string;
  ai: AiMove;
  real: RealMove | null;
  /** Why a move is AI-only, in the studio's words. Present exactly when `real` is null. */
  aiOnly?: string;
  /** The card's loop for a move with no real side. */
  sketch?: SketchKey[];
};

/** What Veo is told is kept the same on every move (ADR 0040): one continuous take, nothing else about the property changes. */
export const MOVE_GIMBAL_CLAUSE = "Smooth gimbal motion, no cuts.";
export const MOVE_LOCKED_CLAUSE = "Locked off, no cuts.";
export const MOVE_KEEP_CLAUSE = "Keep the architecture, room layout, openings, furniture and materials unchanged.";

const NO_PARALLAX = "Needs depth the footage does not have.";

export const MOVES: readonly Move[] = [
  // ── Push in ──
  {
    id: "slow-push", label: "Slow push", group: "push", blurb: "A slow, even push in from the first frame to the last.",
    ai: { lens: "24–35 mm", hands: "Walk forward very slowly, arms steady, eyes on the subject.", seconds: 4, best: "any",
      prompt: "A slow, even push-in toward the subject at a constant walking pace, centred and level, the frame tightening gradually from the first frame to the last. Smooth gimbal motion, no shake, no cuts." },
    real: { camera: "push" },
  },
  {
    id: "super-dolly-in", label: "Super dolly in", group: "push", blurb: "Starts gentle and accelerates hard into a detail.",
    ai: { lens: "24 mm, wide", hands: "Start slow, then lean into a fast dolly; the body drives it, the camera stays level.", seconds: 4, best: "any",
      prompt: "A super dolly-in: the camera starts with a slow push and accelerates steadily into a close detail at the end of the frame, wide lens, strong depth and foreground parallax as it closes in, the subject staying centred. Smooth gimbal motion, no shake, no cuts." },
    real: { camera: [{ p: 0, scale: 1, x: 0, y: 0, ease: "linear" }, { p: 1, scale: 1.9, x: 0, y: 0, ease: "in" }], cutOut: { direction: "zoom", peak: 4, blur: 0.7, push: 0.1, durationMs: 350 } },
  },
  {
    id: "crash-zoom", label: "Crash zoom", group: "push", blurb: "A sudden fast zoom onto the subject, landing on the beat.",
    ai: { lens: "24–70 mm, zoom", hands: "Hold still, then punch the zoom ring in one hard move.", seconds: 4, best: "any",
      prompt: "A crash zoom: the camera holds a wide, level framing for an instant, then zooms in fast and hard onto the main subject and settles sharply on it, with a touch of motion blur during the zoom. Smooth gimbal motion, the zoom is the only movement, no cuts." },
    real: {
      camera: [{ p: 0, scale: 1, x: 0, y: 0, ease: "linear" }, { p: 0.1, scale: 1.65, x: 0, y: 0, ease: "snap" }, { p: 1, scale: 1.75, x: 0, y: 0, ease: "linear" }],
      ramp: "hit", cutIn: { direction: "zoom", peak: 5, blur: 0.8, push: 0.1, durationMs: 300 },
    },
  },
  {
    id: "push-through", label: "Push through a doorway", group: "push", blurb: "Accelerates at an opening and carries through on the cut.",
    ai: { lens: "12–24 mm, wide", hands: "Walk at the opening, speeding up, and keep going through it.", seconds: 4, best: "interior",
      prompt: "The camera pushes forward at an accelerating pace toward a doorway or opening, passes straight through it with the frame of the door sweeping past the edges, and the next space comes into view. Keep to visible openings, never through a solid wall. Smooth gimbal motion, one continuous move, no cuts." },
    real: {
      camera: [{ p: 0, scale: 1, x: 0, y: 0, ease: "linear" }, { p: 1, scale: 1.95, x: 0, y: 0, ease: "in" }],
      ramp: "into-cut", cutOut: { direction: "zoom", peak: 5, blur: 0.8, push: 0.12, durationMs: 300 },
    },
  },
  {
    id: "push-settle", label: "Push, then settle", group: "push", blurb: "Pushes in quickly, overshoots a touch, settles.",
    ai: { lens: "24–35 mm", hands: "A confident step in, then let the gimbal absorb the stop.", seconds: 4, best: "any",
      prompt: "A confident push-in that moves quickly at first, eases past its mark by a hair and settles into a still, balanced composition for the last second. Smooth gimbal motion, no shake, no cuts." },
    real: { camera: "push-settle" },
  },
  {
    id: "snap-in", label: "Snap zoom", group: "push", blurb: "Snaps closer over the first beat, then holds.",
    ai: { lens: "24–70 mm", hands: "A quick punch of the zoom on the downbeat, then hold.", seconds: 4, best: "any",
      prompt: "The frame snaps closer in a quick zoom over the first fraction of a second, then holds the tighter composition perfectly steady. Smooth gimbal motion for the rest of the take, no cuts." },
    real: { camera: "snap" },
  },
  // ── Pull out ──
  {
    id: "pull-back", label: "Pull back reveal", group: "pull", blurb: "Starts tight and backs away to show the room.",
    ai: { lens: "35 mm, medium", hands: "Walk slowly backwards. Keep it level.", seconds: 4, best: "any",
      prompt: "Medium 35 mm lens held level. The camera walks slowly backwards away from the subject, revealing more of the room, with the horizon kept level and the framing centred. Smooth gimbal motion, constant slow speed, no cuts." },
    real: { camera: [{ p: 0, scale: 1.22, x: 0, y: 0, ease: "linear" }, { p: 1, scale: 1, x: 0, y: 0, ease: "out" }] },
  },
  // ── Reveals ──
  {
    id: "tilt", label: "Tilt-up reveal", group: "reveal", blurb: "Starts low and tilts up, the room opening above.",
    ai: { lens: "12–24 mm, wide", hands: "Walk forward. Arms stay put; the hands tilt the camera up.", seconds: 4, best: "interior",
      prompt: "Ultra-wide lens. The camera walks slowly forward into the space while tilting up from the floor toward the ceiling and skylights, a steady forward push and rising tilt in one motion. Smooth gimbal motion, no shake, no cuts." },
    real: { camera: [{ p: 0, scale: 1.28, x: 0, y: -13, ease: "linear" }, { p: 1, scale: 1.32, x: 0, y: 13, ease: "in-out" }] },
  },
  {
    id: "crane-down", label: "Crane down", group: "reveal", blurb: "Settles from high to eye level.",
    ai: { lens: "24 mm", hands: "Start with the arms raised, lower the camera smoothly to chest height.", seconds: 4, best: "any",
      prompt: "A crane-down: the camera starts high, looking down and across the scene, and descends smoothly to eye level while keeping the subject in frame, the view opening up as it comes down. Smooth gimbal motion, constant speed, no cuts." },
    real: { camera: [{ p: 0, scale: 1.3, x: 0, y: 12, ease: "linear" }, { p: 1, scale: 1.3, x: 0, y: -12, ease: "in-out" }] },
  },
  {
    id: "rise-over-roof", label: "Rise over the roof", group: "reveal", blurb: "Lifts over the roofline to show what is behind.",
    ai: { lens: "24 mm, drone", hands: "A drone rising straight up with the camera tilted slightly down.", seconds: 4, best: "exterior",
      prompt: "Starting low at the front of the building, the camera rises smoothly straight up and over the roofline, tilting down slightly to reveal the roof, the garden and the grounds behind it. Keep the same roof shape, footprint and surroundings; do not invent distant landmarks. Smooth gimbal motion, steady rise, no cuts." },
    real: null, aiOnly: `${NO_PARALLAX} Rising over a roof shows ground the footage never saw.`,
    sketch: [{ p: 0, scale: 1, x: 0, y: -8, ease: "linear" }, { p: 1, scale: 1.25, x: 0, y: 10, ease: "in-out" }],
  },
  {
    id: "reveal-behind", label: "Reveal from behind an object", group: "reveal", blurb: "Slides past a foreground object to show the room.",
    ai: { lens: "24–35 mm", hands: "Start with the lens right behind a pillar, plant or doorframe, then slide sideways past it.", seconds: 4, best: "interior",
      prompt: "The camera starts tucked behind a foreground object (a doorframe, a plant, a column) that fills part of the frame, then slides sideways past it, the object sweeping off the edge with strong parallax to reveal the room behind. Smooth gimbal motion, steady lateral speed, no cuts." },
    real: null, aiOnly: `${NO_PARALLAX} The object has to move against the room, and a crop moves them together.`,
    sketch: [{ p: 0, scale: 1.1, x: -6, y: 0, ease: "linear" }, { p: 1, scale: 1.1, x: 6, y: 0, ease: "in-out" }],
  },
  // ── Slides ──
  {
    id: "parallax-slide", label: "Parallax slide", group: "slide", blurb: "A lateral slide across a slightly closer picture.",
    ai: { lens: "24–35 mm", hands: "Sidestep slowly with the camera square to the wall.", seconds: 4, best: "any",
      prompt: "The camera slides sideways at a slow constant speed, square to the scene, with foreground objects moving faster than the background so the room gains depth. Keep the horizon level. Smooth gimbal motion, no cuts." },
    real: { camera: [{ p: 0, scale: 1.14, x: -6.5, y: 0, ease: "linear" }, { p: 1, scale: 1.14, x: 6.5, y: 0, ease: "in-out" }] },
  },
  {
    id: "handheld", label: "Handheld", group: "slide", blurb: "A tiny, living drift on a locked frame.",
    ai: { lens: "24–35 mm", hands: "Hold the camera in both hands, relaxed, and breathe.", seconds: 4, best: "any",
      prompt: "A subtle handheld feel: the framing breathes with tiny, slow, natural drifts and no deliberate move, the composition held steady on the subject. Keep the motion small and calm. Smooth gimbal motion, no cuts." },
    real: { camera: [
      { p: 0, scale: 1.06, x: 0.4, y: -0.5, ease: "linear" }, { p: 0.16, scale: 1.06, x: -0.9, y: 0.6, ease: "in-out" }, { p: 0.33, scale: 1.06, x: 0.7, y: -0.8, ease: "in-out" },
      { p: 0.5, scale: 1.06, x: -0.5, y: 0.9, ease: "in-out" }, { p: 0.66, scale: 1.06, x: 1, y: -0.4, ease: "in-out" }, { p: 0.83, scale: 1.06, x: -0.6, y: 0.7, ease: "in-out" },
      { p: 1, scale: 1.06, x: 0.3, y: -0.3, ease: "in-out" },
    ] },
  },
  // ── Locked off ──
  {
    id: "static", label: "Static", group: "locked", blurb: "Locked off: only the light and the water move.",
    ai: { lens: "24–70 mm on a tripod", hands: "Hands off. Let the water, light or curtains move.", seconds: 4, best: "any", locked: true,
      prompt: "Camera locked off on a tripod, perfectly still, 24–70 mm. Nothing moves but the scene itself: water, curtains, leaves, light. Hold the exact composition for the whole take, no camera motion at all, no cuts." },
    real: { camera: null, holdMotion: true },
  },
  {
    id: "timelapse", label: "Timelapse", group: "locked", blurb: "Locked off while the light moves across the day.",
    ai: { lens: "24 mm on a tripod", hands: "Tripod, intervalometer, patience.", seconds: 8, best: "any", locked: true,
      prompt: "Camera locked off on a tripod in an unmoving composition. Time passes: sunlight and shadows travel across the scene, clouds drift, windows glow as the light changes. Hold the exact composition for the whole take, no camera motion at all, no cuts." },
    real: null, aiOnly: "The light has to change, and footage already shot has one light.",
    sketch: [{ p: 0, scale: 1, x: 0, y: 0, ease: "linear" }, { p: 1, scale: 1, x: 0, y: 0, ease: "linear" }],
  },
  // ── Whips ──
  {
    id: "whip-pan-right", label: "Whip pan right", group: "whip", blurb: "A fast pan right with streaks, into this shot.",
    ai: { lens: "24 mm", hands: "Snap the camera to the right in one fast pan, the frame smearing.", seconds: 4, best: "any",
      prompt: "The camera whips fast to the right in one quick pan, the frame smearing into horizontal motion-blur streaks, and settles sharp on a new view of the same space. Smooth gimbal motion for the settle, no cuts." },
    real: { cutIn: { direction: "right", peak: 5, blur: 0.9, push: 0, durationMs: 300 } },
  },
  {
    id: "whip-pan-left", label: "Whip pan left", group: "whip", blurb: "A fast pan left with streaks, into this shot.",
    ai: { lens: "24 mm", hands: "Snap the camera to the left in one fast pan, the frame smearing.", seconds: 4, best: "any",
      prompt: "The camera whips fast to the left in one quick pan, the frame smearing into horizontal motion-blur streaks, and settles sharp on a new view of the same space. Smooth gimbal motion for the settle, no cuts." },
    real: { cutIn: { direction: "left", peak: 5, blur: 0.9, push: 0, durationMs: 300 } },
  },
  // ── AI only: perspective, rotation, depth ──
  {
    id: "dolly-zoom", label: "Dolly zoom (vertigo)", group: "push", blurb: "Pulls back while zooming in: the room stretches around the subject.",
    ai: { lens: "zoom, 24 to 70 mm", hands: "Walk backwards while zooming in, matching the two so the subject keeps its size.", seconds: 4, best: "interior",
      prompt: "A dolly zoom, the vertigo effect: the camera moves slowly backwards while the lens zooms in at the matching rate, so the main subject keeps the same size in the frame while the room behind it stretches and the walls seem to close in. Smooth gimbal motion, no cuts." },
    real: null, aiOnly: "A dolly zoom changes the perspective of the room against the subject. A crop cannot: it only scales the whole picture.",
    sketch: [{ p: 0, scale: 1, x: 0, y: 0, ease: "linear" }, { p: 1, scale: 1.4, x: 0, y: 0, ease: "in-out" }],
  },
  {
    id: "orbit", label: "Orbit", group: "orbit", blurb: "A slow circle around the subject.",
    ai: { lens: "24–35 mm", hands: "Walk a slow arc around the subject, keeping it centred.", seconds: 4, best: "any",
      prompt: "The camera circles slowly around the main subject at a constant distance and height, the subject centred and the background sliding past with strong parallax, covering a quarter of a full circle. Keep the same layout from every side that comes into view. Smooth gimbal motion, no cuts." },
    real: null, aiOnly: `${NO_PARALLAX} An orbit shows the far side of the subject.`,
    sketch: [{ p: 0, scale: 1.1, x: -7, y: 0, rotate: -4, ease: "linear" }, { p: 1, scale: 1.1, x: 7, y: 0, rotate: 4, ease: "in-out" }],
  },
  {
    id: "top-down-spin", label: "Top-down spin", group: "orbit", blurb: "Looking straight down while the frame rotates.",
    ai: { lens: "16–24 mm, overhead", hands: "Hold the camera overhead pointing straight down and turn the whole body slowly.", seconds: 4, best: "any",
      prompt: "A top-down overhead shot looking straight down at the floor plan of the space, the camera slowly rotating around its vertical axis so the whole room turns beneath it at a steady rate, furniture and layout staying exactly in place. Smooth gimbal motion, no cuts." },
    real: null, aiOnly: "The frame has to rotate, and a clip's camera only scales and shifts.",
    sketch: [{ p: 0, scale: 1.2, x: 0, y: 0, rotate: 0, ease: "linear" }, { p: 1, scale: 1.2, x: 0, y: 0, rotate: 90, ease: "in-out" }],
  },
  {
    id: "hyperlapse-walk", label: "Hyperlapse walk", group: "fly", blurb: "A fast walk through the space, time running ahead.",
    ai: { lens: "12–24 mm, wide", hands: "Walk steadily with the camera at chest height; footage is sped up.", seconds: 4, best: "any",
      prompt: "A hyperlapse: the camera walks steadily forward through the space at chest height, time running fast so people and light move quickly while the walk itself stays smooth and straight, the space unfolding ahead. Smooth gimbal motion, constant pace, no cuts." },
    real: null, aiOnly: "A hyperlapse is a walk shot for the purpose. Speeding up a clip that was shot standing still only makes it quick.",
    sketch: [{ p: 0, scale: 1, x: 0, y: 0, ease: "linear" }, { p: 1, scale: 1.6, x: 0, y: 0, ease: "in" }],
  },
  {
    id: "fpv-fly-through", label: "FPV fly-through", group: "fly", blurb: "A fast drone-style flight through the space.",
    ai: { lens: "12–16 mm, ultra-wide", hands: "An FPV drone flown through the rooms: banking, diving, threading openings.", seconds: 8, best: "any",
      prompt: "A sweeping first-person-view drone flight through the property: a dramatic approach, flowing passes through visible doorways and openings, gentle banking through the turns and a smooth deceleration into the final room. Keep believable scale and a continuous space; fly through openings, never through solid walls. Smooth gimbal motion, one continuous flight, no cuts." },
    real: null, aiOnly: "It needs a path through rooms the footage never shows.",
    sketch: [{ p: 0, scale: 1, x: -4, y: 2, rotate: -6, ease: "linear" }, { p: 0.5, scale: 1.4, x: 4, y: -2, rotate: 6, ease: "in-out" }, { p: 1, scale: 1.9, x: 0, y: 0, rotate: 0, ease: "in-out" }],
  },
  {
    id: "cathedral", label: "Cathedral", group: "orbit", blurb: "Wide, tilted up, walking across the room as it arcs.",
    ai: { lens: "12–24 mm, wide", hands: "Lens tilted up. Walk across the space while twisting slowly so the camera arcs around the room.", seconds: 4, best: "interior",
      prompt: "Ultra-wide lens tilted up toward the ceiling and upper walls. The camera walks sideways across the room while slowly rotating, so the architecture arcs past: a slow lateral arc that keeps the ceiling, cornices and tall openings in frame. Smooth gimbal motion, constant slow speed, no shake, no cuts." },
    real: null, aiOnly: "The room has to arc past the lens, which needs rotation and parallax.",
    sketch: [{ p: 0, scale: 1.2, x: -6, y: 6, rotate: -5, ease: "linear" }, { p: 1, scale: 1.2, x: 6, y: 6, rotate: 5, ease: "in-out" }],
  },
  {
    id: "twist", label: "Twist", group: "orbit", blurb: "Opens on the sky and lowers onto the facade as the frame rolls level.",
    ai: { lens: "12–24 mm, wide · opening shots", hands: "Lens pointed at the sky. Lower it to the facade while twisting the wrist left.", seconds: 4, best: "exterior",
      prompt: "Opening move: the ultra-wide lens starts pointed at the sky above the building, then lowers smoothly onto the facade while the frame rolls gently to level, a slow wrist twist that straightens as the house settles into the composition. Smooth gimbal motion, one continuous move, no cuts." },
    real: null, aiOnly: "The frame has to roll, and a clip's camera only scales and shifts.",
    sketch: [{ p: 0, scale: 1.2, x: 0, y: -8, rotate: -12, ease: "linear" }, { p: 1, scale: 1, x: 0, y: 0, rotate: 0, ease: "out" }],
  },
  {
    id: "wide-walk", label: "Wide walk", group: "push", blurb: "Locked level, a straight slow walk forward.",
    ai: { lens: "12–24 mm, wide", hands: "Camera locked straight. Walk forward.", seconds: 4, best: "interior",
      prompt: "Ultra-wide lens locked level and straight ahead. The camera walks slowly forward through the room at a constant pace with no pan or tilt, a clean straight push. Smooth gimbal motion, no shake, no cuts." },
    real: null, aiOnly: "A walk through a room parallaxes. A digital push (Slow push) scales the picture and looks flat beside it.",
    sketch: [{ p: 0, scale: 1, x: 0, y: 0, ease: "linear" }, { p: 1, scale: 1.3, x: 0, y: 0, ease: "linear" }],
  },
  {
    id: "detail-orbit", label: "Detail orbit", group: "orbit", blurb: "Creeps in on a close detail while circling it.",
    ai: { lens: "24–70 mm", hands: "Body creeps forward; the wrist twists slowly to orbit the detail.", seconds: 4, best: "any",
      prompt: "24–70 mm lens on a close detail: a tap, a handle, a light, a texture. The camera creeps forward very slowly while twisting around the detail, a tight partial orbit that keeps the detail centred and shallow focus on it. Smooth gimbal motion, no cuts." },
    real: null, aiOnly: `${NO_PARALLAX} Circling a detail shows the sides of it.`,
    sketch: [{ p: 0, scale: 1.3, x: -4, y: 0, rotate: -3, ease: "linear" }, { p: 1, scale: 1.5, x: 4, y: 0, rotate: 3, ease: "in-out" }],
  },
];

const BY_ID = new Map<MoveId, Move>(MOVES.map((move) => [move.id, move]));
export function moveById(id: MoveId): Move {
  const move = BY_ID.get(id);
  if (!move) throw new Error(`There is no camera move called ${String(id)}.`);
  return move;
}
export const isAiOnly = (move: Move) => move.real === null;
export const aiOnlyMoves = (): Move[] => MOVES.filter(isAiOnly);
export const realMoves = (): Move[] => MOVES.filter((move) => !isAiOnly(move));

/**
 * The Veo prompt for a move: the move's words, the clause that keeps the take
 * one continuous shot, and what must not change. `extra` is the studio's own
 * line about the shot, which comes last.
 */
export function movePrompt(id: MoveId, extra = ""): string {
  const move = moveById(id);
  return [move.ai.prompt, MOVE_KEEP_CLAUSE, extra.trim()].filter(Boolean).join(" ");
}

/** The camera a real move writes: a preset's own, or the move's keys as a custom move. */
export function moveCamera(real: RealMove): Camera | null | undefined {
  if (real.camera === undefined) return undefined;
  if (real.camera === null) return null;
  return typeof real.camera === "string" ? cameraPreset(real.camera) : customCamera(real.camera.map((key) => ({ ...key })));
}

/** The pose of a move at `p`, for its card's loop. A real move reads the clip's own camera maths; an AI-only one, its sketch. */
export type LoopPose = { scale: number; x: number; y: number; rotate: number };
export function moveLoopAt(id: MoveId, p: number): LoopPose {
  const move = moveById(id);
  const camera = move.real ? moveCamera(move.real) : null;
  if (camera) return { ...cameraKeysAt(camera, p), rotate: 0 };
  const keys = move.sketch;
  if (!keys) return { scale: 1, x: 0, y: 0, rotate: 0 };
  const t = Math.max(0, Math.min(1, p));
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t <= b.p) {
      const mix = b.p <= a.p ? 1 : easeValue(b.ease ?? "in-out", (t - a.p) / (b.p - a.p));
      return { scale: a.scale + (b.scale - a.scale) * mix, x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix, rotate: (a.rotate ?? 0) + ((b.rotate ?? 0) - (a.rotate ?? 0)) * mix };
    }
  }
  const last = keys[keys.length - 1];
  return { scale: last.scale, x: last.x, y: last.y, rotate: last.rotate ?? 0 };
}

/** A whole-second-or-less loop as `steps + 1` poses, from the first frame to the last. A move with no motion is a single still. */
export function moveLoop(id: MoveId, steps = 24): LoopPose[] {
  return Array.from({ length: steps + 1 }, (_, i) => moveLoopAt(id, i / steps));
}

/**
 * A real move written onto a clip. `applyMove` is the one function behind the
 * `applyMove` command, so the Moves sheet and an agent send the same thing and
 * it lands as one undo step.
 *
 * - The clip gets the move's camera (or has it cleared), its speed ramp (video
 *   only) and, for a move that carries one, a speed-ramp transition into it.
 * - A move that ends on a cut (a push through a doorway) also turns the next
 *   shot's transition into the zoom blur that carries it through.
 * - A cut-in move on the first shot has no cut to land on and is refused, as a
 *   transition is; a move that has a camera simply leaves the transition off.
 * - An AI-only move is refused with the reason, so a batch holding it is all
 *   or nothing.
 */
export function applyMove(timeline: Timeline, clipId: string, id: MoveId): Timeline {
  const move = BY_ID.get(id);
  if (!move) throw new Error(`There is no camera move called ${String(id)}.`);
  const index = timeline.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new Error(`There is no clip called ${clipId} in the reel.`);
  if (!move.real) throw new Error(`${move.label} is AI-only: ${move.aiOnly} Ask for it as an AI shot (move: "${move.id}") instead.`);
  const { real } = move;
  const clip = timeline.clips[index];
  const patch: Parameters<typeof updateClip>[2] = {};
  const camera = moveCamera(real);
  if (moveBlockedAt(id, index)) throw new Error(`${move.label} lands on the cut into a shot, and the first shot has no cut before it.`);
  if (camera !== undefined) patch.camera = camera;
  if (real.holdMotion) patch.motion = "none";
  if (real.ramp && clip.kind === "VIDEO") patch.ramp = rampPreset(real.ramp);
  if (real.cutIn && index > 0) {
    patch.transitionIn = "speedRamp";
    patch.speedRamp = speedRampSchema.parse({ ...clip.speedRamp, ...real.cutIn, auto: undefined });
  }
  let next = updateClip(timeline, clipId, patch);
  const following = next.clips[index + 1];
  if (real.cutOut && following) {
    next = updateClip(next, following.id, { transitionIn: "speedRamp", speedRamp: speedRampSchema.parse({ ...following.speedRamp, ...real.cutOut, auto: undefined }) });
  }
  return next;
}

/** Why a real move cannot go on the shot at `index`, or null: a move that is only a cut (a whip) has no cut to land on at the first shot. */
export function moveBlockedAt(id: MoveId, index: number): string | null {
  const real = moveById(id).real;
  if (!real) return null;
  return real.camera === undefined && real.ramp === undefined && !real.holdMotion && index === 0 ? "The first shot has no cut before it." : null;
}

/** The real move whose camera is on this clip, for the sheet to mark; null when the clip's camera is not one of the table's. */
export function moveOnClip(clip: Pick<Clip, "camera">): MoveId | null {
  if (!clip.camera) return null;
  const same = (a: Camera, b: Camera) => a.keys.length === b.keys.length && a.keys.every((key, i) => key.p === b.keys[i].p && key.scale === b.keys[i].scale && key.x === b.keys[i].x && key.y === b.keys[i].y && (i === 0 || key.ease === b.keys[i].ease));
  for (const move of MOVES) {
    if (!move.real || move.real.camera === undefined || move.real.camera === null) continue;
    const camera = moveCamera(move.real);
    if (camera && same(clip.camera, camera)) return move.id;
  }
  return null;
}

/** Furthest a real move may shift the picture at a scale without exposing the frame's edge (percent). */
export const shiftRoom = (scale: number) => Math.min(CAMERA_SHIFT_MAX, (scale - 1) * 50);
