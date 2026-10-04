import { roomIndexAt, type Plan, type Spot } from "./plan";
import { panoYawAt, type Clip } from "./timeline";

/**
 * A "walk" transition: instead of cutting from one 360 photo to the next, the
 * camera travels across the floor plan from where the first was taken to
 * where the second was, going through doorways, while the picture changes
 * from one photo to the other. This file works out the route and where the
 * camera is at each moment; the renderer draws it.
 *
 * Positions are in plan coordinates (fractions of the plan's box). Distances
 * are measured with x scaled by the plan's aspect, so they are proportional
 * to real ones.
 */

type Point = readonly [number, number];

export type Walk = {
  /** Time the move takes, at the start of the incoming clip. */
  durationMs: number;
  /** Start, any doorways on the way, and end. */
  waypoints: Point[];
  /**
   * Directions the camera faces, in degrees clockwise from the top of the
   * plan: as it leaves, part-way (looking where it is going), and on arrival.
   */
  facing: [number, number, number];
  /**
   * How far along the route the picture changes from one photo to the other:
   * at the doorway, where each photo stops being a good view of what is ahead.
   */
  changeAt: number;
};

export type CameraPose = {
  x: number;
  y: number;
  /** Direction the camera faces, in degrees clockwise from the top of the plan. */
  heading: number;
  pitch: number;
  fov: number;
  /** How much of the picture comes from the previous photo: 1 at the start of a walk, 0 once it has arrived. */
  previous: number;
};

/** Height of a 360 camera on its tripod, used to turn plan distances into metres. */
const EYE_METRES = 1.5;
/** A brisk gliding pace: fast enough for a reel, slow enough to follow. */
const METRES_PER_SECOND = 2.4;
const MIN_WALK_MS = 1300;
const MAX_WALK_MS = 4200;
/** Time allowed per degree of turning, which keeps the fastest part of a turn near 110 degrees a second. */
const MS_PER_DEGREE = 17;
/** A walk never takes more than this share of its clip, so the room still gets its sweep. */
const MAX_SHARE = 0.6;
/** The sweep of the new room begins before the walk has finished, so the camera never stops dead. */
const SWEEP_STARTS_AT = 0.5;

/** Share of the route over which one photo dissolves into the next. */
const CHANGE_SPAN = 0.4;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
/** Eases in and out with no sudden change of speed at either end. */
const glide = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** The signed smallest turn from one direction to another, in degrees. */
export function shortestTurn(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function length(a: Point, b: Point, aspect: number): number {
  return Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]);
}

/**
 * The way from one spot to another through doorways: the shortest chain of
 * doors where each step stays inside one room. Falls back to a straight line
 * when the rooms are not connected by doors on the plan.
 */
export function doorRoute(plan: Plan | null, from: Point, to: Point): Point[] {
  if (!plan) return [from, to];
  const startRoom = roomIndexAt(plan, { x: from[0], y: from[1] });
  const endRoom = roomIndexAt(plan, { x: to[0], y: to[1] });
  if (startRoom === -1 || endRoom === -1 || startRoom === endRoom) return [from, to];

  // Which two rooms each door joins: look a short step to either side of it.
  const doors = plan.doors.flatMap(([a, b]) => {
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const dx = (b[0] - a[0]) * plan.aspect;
    const dy = b[1] - a[1];
    const size = Math.hypot(dx, dy) || 1;
    for (const step of [0.012, 0.03]) {
      // A normal to the door, converted back from real proportions to plan coordinates.
      const nx = ((-dy / size) * step) / plan.aspect;
      const ny = (dx / size) * step;
      const one = roomIndexAt(plan, { x: mid[0] + nx, y: mid[1] + ny });
      const other = roomIndexAt(plan, { x: mid[0] - nx, y: mid[1] - ny });
      if (one !== -1 && other !== -1 && one !== other) return [{ mid, rooms: [one, other] }];
    }
    return [];
  });

  // Dijkstra over: start, each door, end.
  const start = doors.length;
  const end = doors.length + 1;
  const position = (node: number): Point => (node === start ? from : node === end ? to : doors[node].mid);
  const roomsOf = (node: number): number[] => (node === start ? [startRoom] : node === end ? [endRoom] : doors[node].rooms);
  const cost = new Array<number>(doors.length + 2).fill(Infinity);
  const via = new Array<number>(doors.length + 2).fill(-1);
  const done = new Set<number>();
  cost[start] = 0;
  for (;;) {
    let node = -1;
    for (let i = 0; i < cost.length; i++) if (!done.has(i) && cost[i] < Infinity && (node === -1 || cost[i] < cost[node])) node = i;
    if (node === -1 || node === end) break;
    done.add(node);
    for (let next = 0; next < cost.length; next++) {
      if (done.has(next) || next === start) continue;
      if (!roomsOf(node).some((room) => roomsOf(next).includes(room))) continue;
      const total = cost[node] + length(position(node), position(next), plan.aspect);
      if (total < cost[next]) {
        cost[next] = total;
        via[next] = node;
      }
    }
  }
  if (cost[end] === Infinity) return [from, to];
  const route: Point[] = [];
  for (let node = end; node !== -1; node = via[node]) route.unshift(position(node));
  return route;
}

/** Length of a route, in the plan's real proportions. */
export function routeLength(route: readonly Point[], aspect: number): number {
  let total = 0;
  for (let i = 1; i < route.length; i++) total += length(route[i - 1], route[i], aspect);
  return total;
}

/** True when the camera can travel from the previous clip into this one. */
export function canWalk(previous: Clip | undefined, clip: Clip): previous is Clip & { spot: Spot; pano: NonNullable<Clip["pano"]> } {
  return !!previous && !!previous.pano && !!previous.spot && !!clip.pano && !!clip.spot && previous.kind === "IMAGE" && clip.kind === "IMAGE";
}

/**
 * The walk into a clip, or null when it enters some other way (a cut, a
 * fade, or clips that do not know where they were shot).
 */
export function walkInto(plan: Plan | null, previous: Clip | undefined, clip: Clip, clipMs: number): Walk | null {
  if (clip.transitionIn !== "walk" || !canWalk(previous, clip) || !clip.spot) return null;
  const aspect = plan?.aspect ?? 1;
  const waypoints = doorRoute(plan, [previous.spot.x, previous.spot.y], [clip.spot.x, clip.spot.y]);
  const distance = routeLength(waypoints, aspect);
  const eye = clip.spot.shell?.eye ?? previous.spot.shell?.eye;
  const metres = eye ? (distance / eye) * EYE_METRES : 3;
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  const bearing = (Math.atan2((last[0] - first[0]) * aspect, -(last[1] - first[1])) * 180) / Math.PI;

  // Turn from where the last clip was looking, through the way we are going, to where this clip starts.
  const leaving = previous.spot.heading + previous.pano.yawEnd;
  const arriving = clip.spot.heading + clip.pano!.yawStart;
  let ahead = leaving + shortestTurn(leaving, bearing);
  let end = ahead + shortestTurn(ahead, arriving);
  if (Math.abs(ahead - leaving) + Math.abs(end - ahead) > 200) {
    // Looking ahead would mean spinning most of the way round: turn directly instead.
    end = leaving + shortestTurn(leaving, arriving);
    ahead = (leaving + end) / 2;
  }
  const turned = Math.abs(ahead - leaving) + Math.abs(end - ahead);

  const wanted = Math.min(MAX_WALK_MS, Math.max(MIN_WALK_MS, 500 + (metres / METRES_PER_SECOND) * 1000, turned * MS_PER_DEGREE));
  // The doorway nearest the middle of the route, kept away from the ends so the change is never abrupt.
  // Leaning early: the camera looks where it is going, and the photo ahead shows that best.
  let changeAt = 0.5;
  if (distance > 0 && waypoints.length > 2) {
    const doors = waypoints.slice(1, -1).map((_, index) => routeLength(waypoints.slice(0, index + 2), aspect) / distance);
    changeAt = doors.reduce((best, at) => (Math.abs(at - 0.5) < Math.abs(best - 0.5) ? at : best));
    changeAt = Math.min(0.6, Math.max(0.25, changeAt));
  }
  return { durationMs: Math.round(Math.min(wanted, clipMs * MAX_SHARE)), waypoints, facing: [leaving, ahead, end], changeAt };
}

/** Points sampled per leg of a route when measuring the rounded path. */
const SAMPLES = 24;

/**
 * A point along a route, by the fraction of its length travelled. Corners at
 * doorways are rounded off with a spline through the waypoints, and the
 * fraction is of the rounded path's own length, so the pace is even from one
 * leg to the next.
 */
function along(route: readonly Point[], aspect: number, fraction: number): Point {
  if (route.length === 2) {
    return [route[0][0] + (route[1][0] - route[0][0]) * fraction, route[0][1] + (route[1][1] - route[0][1]) * fraction];
  }
  // Catmull-Rom through the waypoints, as a chain of short straight pieces.
  const points: Point[] = [route[0]];
  for (let segment = 0; segment < route.length - 1; segment++) {
    const p0 = route[Math.max(0, segment - 1)];
    const p1 = route[segment];
    const p2 = route[segment + 1];
    const p3 = route[Math.min(route.length - 1, segment + 2)];
    for (let step = 1; step <= SAMPLES; step++) {
      const t = step / SAMPLES;
      const spline = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
      points.push([spline(p0[0], p1[0], p2[0], p3[0]), spline(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  let target = clamp01(fraction) * routeLength(points, aspect);
  for (let index = 1; index < points.length; index++) {
    const piece = length(points[index - 1], points[index], aspect);
    if (target <= piece || index === points.length - 1) {
      const t = piece > 0 ? clamp01(target / piece) : 0;
      return [points[index - 1][0] + (points[index][0] - points[index - 1][0]) * t, points[index - 1][1] + (points[index][1] - points[index - 1][1]) * t];
    }
    target -= piece;
  }
  return route[route.length - 1];
}

/**
 * Where the camera is and which way it faces, `ms` into a clip that lasts
 * `clipMs`. With a walk, the camera leaves the previous photo's spot facing
 * the way that clip ended, turns through the direction of travel, and arrives
 * already beginning the new room's sweep.
 */
export function cameraAt(plan: Plan | null, previous: Clip | undefined, clip: Clip, ms: number, clipMs: number): CameraPose {
  const pano = clip.pano ?? { yawStart: 0, yawEnd: 0, pitch: 0, fov: 90 };
  const spot = clip.spot ?? { x: 0, y: 0, heading: 0 };
  const walk = walkInto(plan, previous, clip, clipMs);
  if (!walk || !previous?.spot || !previous.pano) {
    const progress = clipMs > 0 ? clamp01(ms / clipMs) : 0;
    return { x: spot.x, y: spot.y, heading: spot.heading + panoYawAt(pano, progress), pitch: pano.pitch, fov: pano.fov, previous: 0 };
  }

  const travelled = glide(clamp01(ms / walk.durationMs));
  const [x, y] = along(walk.waypoints, plan?.aspect ?? 1, travelled);

  const [leaving, ahead, end] = walk.facing;
  const turn = (1 - travelled) * (1 - travelled) * leaving + 2 * travelled * (1 - travelled) * ahead + travelled * travelled * end;

  const sweepFrom = walk.durationMs * SWEEP_STARTS_AT;
  const sweep = panoYawAt(pano, clamp01((ms - sweepFrom) / Math.max(1, clipMs - sweepFrom))) - pano.yawStart;

  const mix = (a: number, b: number) => a + (b - a) * travelled;
  return {
    x,
    y,
    heading: turn + sweep,
    pitch: mix(previous.pano.pitch, pano.pitch),
    fov: mix(previous.pano.fov, pano.fov),
    previous: 1 - glide(clamp01((travelled - (walk.changeAt - CHANGE_SPAN / 2)) / CHANGE_SPAN)),
  };
}
