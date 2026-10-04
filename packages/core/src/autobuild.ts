import type { Plan, Spot } from "./plan";
import { addRoomLabels, DEFAULT_PANO, timelineSchema, type Clip, type ListingDetails, type Music, type Timeline } from "./timeline";
import { snapCutsToBeats } from "./beats";
import { doorRoute, routeLength, shortestTurn, walkInto } from "./walk";

/**
 * Builds a first draft of a walkthrough reel from a home tour: rooms in the
 * order a viewing would go, each 360 photo sweeping towards its window, the
 * floor plan marker, room names, and optionally music with cuts on the beat.
 * The result is an ordinary timeline, so everything can be changed afterwards.
 */

export type TourShot = {
  assetId: string;
  room: string | null;
  spot: Spot | null;
  /** True for 360 photos. Flat photos get a slow zoom instead of a sweep. */
  isPano: boolean;
  /**
   * True for an extra photo of a room that already has a main one. A walk
   * never stops at these, but passes them when they are on the way.
   */
  passing?: boolean;
};

/** Rooms worth a shot, in viewing order. Closets, pantries and laundry rooms are left out. */
export const WALK_ORDER = ["living room", "dining room", "kitchen", "hallway", "bedroom", "bathroom", "bonus room", "garage"];

const CLIP_MS = 4000;
/** Time a room gets after the camera has walked into it. */
const DWELL_MS = 2400;
/** The sweep of a room the camera walked into: not a twitch, not a spin. */
const MIN_TURN = 45;
const MAX_TURN = 150;
/** Time at a photo the walk only passes: enough to turn towards the way out. */
const PASSING_MS = 700;
/** How much longer than the direct way a leg may get by passing through another photo. */
const MAX_DETOUR = 1.35;
/** Reels much longer than this lose viewers; a draft stays under it. */
const MAX_CLIPS = 9;
/** How far the camera turns before it settles on the room's window. */
const SWEEP_DEGREES = 75;

function distance(a: Spot, b: Spot): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Orders shots as a viewing would: room types in WALK_ORDER, and within a
 * type the shot nearest to where the walk currently is.
 */
export function walkOrder(shots: TourShot[]): TourShot[] {
  const remaining = shots.filter((shot) => !shot.passing && shot.room !== null && WALK_ORDER.includes(shot.room));
  const route: TourShot[] = [];
  let here: Spot | null = null;
  for (const room of WALK_ORDER) {
    const inRoom = remaining.filter((shot) => shot.room === room);
    while (inRoom.length > 0) {
      const from = here;
      inRoom.sort((a, b) => (from && a.spot && b.spot ? distance(a.spot, from) - distance(b.spot, from) : 0));
      const next = inRoom.shift()!;
      route.push(next);
      here = next.spot ?? here;
    }
  }
  return route.slice(0, MAX_CLIPS);
}

const hop = (plan: Plan, from: TourShot, to: TourShot) => doorRoute(plan, [from.spot!.x, from.spot!.y], [to.spot!.x, to.spot!.y]);

/**
 * Orders shots as one continuous walk: start in the main room and visit every
 * room by the shortest way round, measured through the doorways. On a leg
 * that crosses another room (two bedrooms joined by a hallway), the walk
 * passes a photo taken in that room if there is one, so the camera always
 * has a photo of the space it is moving through.
 */
export function flyOrder(shots: TourShot[], plan: Plan): TourShot[] {
  const located = shots.filter((shot) => shot.isPano && shot.spot);
  // One stop per main photo of a room worth showing; other photos can only be passed on the way.
  const stops = walkOrder(located.filter((shot) => !shot.passing));
  if (stops.length < 2) return stops;

  const distance = stops.map((from) => stops.map((to) => (from === to ? 0 : routeLength(hop(plan, from, to), plan.aspect))));
  // Every order of the remaining stops: at most 8! = 40,320, each a handful of additions.
  let best: number[] = [];
  let bestLength = Infinity;
  const visit = (order: number[], total: number) => {
    if (total >= bestLength) return;
    if (order.length === stops.length) {
      best = order;
      bestLength = total;
      return;
    }
    for (let next = 1; next < stops.length; next++) {
      if (!order.includes(next)) visit([...order, next], total + distance[order[order.length - 1]][next]);
    }
  };
  visit([0], 0);

  const used = new Set(stops);
  const route: TourShot[] = [];
  /** Adds the way from one stop to the next, through a photo of the room in between when that helps. */
  const connect = (from: TourShot, to: TourShot, depth: number) => {
    const direct = hop(plan, from, to);
    if (depth > 0 && direct.length >= 4) {
      const directLength = routeLength(direct, plan.aspect);
      let via: TourShot | null = null;
      let viaLength = directLength * MAX_DETOUR;
      for (const shot of located) {
        if (used.has(shot)) continue;
        const [first, second] = [hop(plan, from, shot), hop(plan, shot, to)];
        // Worth it only if each half crosses fewer doors than going direct.
        if (first.length >= direct.length || second.length >= direct.length) continue;
        const total = routeLength(first, plan.aspect) + routeLength(second, plan.aspect);
        if (total < viaLength) {
          via = shot;
          viaLength = total;
        }
      }
      if (via) {
        used.add(via);
        connect(from, via, depth - 1);
        route.push({ ...via, passing: true });
        connect(via, to, depth - 1);
        return;
      }
    }
  };
  best.forEach((index, position) => {
    if (position > 0) connect(stops[best[position - 1]], stops[index], 2);
    route.push({ ...stops[index], passing: false });
  });
  return route;
}

/** Compass direction from one plan point to another, in degrees clockwise from the top of the plan. */
function bearing(from: readonly [number, number], to: readonly [number, number], aspect: number): number {
  return (Math.atan2((to[0] - from[0]) * aspect, -(to[1] - from[1])) * 180) / Math.PI;
}

/**
 * A tour as one continuous camera move: the camera walks from each 360 photo
 * to the next through the doorways, arrives looking the way it was going,
 * and turns to the room's window. A photo that is only passed on the way
 * gets a short turn towards where the walk goes next.
 */
function flyClips(route: TourShot[], plan: Plan): Clip[] {
  const clips: Clip[] = [];
  route.forEach((shot, index) => {
    const spot = shot.spot!;
    const base = {
      id: `auto-${index}`,
      assetId: shot.assetId,
      kind: "IMAGE" as const,
      sourceStartMs: 0,
      speed: 1,
      volume: 1,
      fit: "cover" as const,
      filter: "none" as const,
      motion: "none" as const,
      spot,
      // Only rooms the walk stops in are named.
      room: shot.passing ? null : shot.room,
    };
    if (index === 0) {
      const aim = spot.aim ?? 50;
      clips.push({ ...base, sourceEndMs: CLIP_MS, transitionIn: "cut", pano: { ...DEFAULT_PANO, yawStart: aim - SWEEP_DEGREES, yawEnd: aim } });
      return;
    }
    const way = hop(plan, route[index - 1], shot);
    // Arrive looking the way the camera came in: the direction of the last leg.
    const yawStart = shortestTurn(0, bearing(way[way.length - 2], way[way.length - 1], plan.aspect) - spot.heading);
    let turn: number;
    if (shot.passing && route[index + 1]) {
      // Passing through: turn towards the way out, however small that turn is.
      const onward = hop(plan, shot, route[index + 1]);
      turn = shortestTurn(yawStart, bearing(onward[0], onward[1], plan.aspect) - spot.heading);
    } else {
      turn = spot.aim === undefined ? 70 : shortestTurn(yawStart, spot.aim);
      turn = (turn < 0 ? -1 : 1) * Math.min(MAX_TURN, Math.max(MIN_TURN, Math.abs(turn)));
    }
    const clip: Clip = { ...base, sourceEndMs: 10_000, transitionIn: "walk", pano: { ...DEFAULT_PANO, yawStart, yawEnd: yawStart + turn } };
    const walk = walkInto(plan, clips[index - 1], clip, 10_000);
    clips.push({ ...clip, sourceEndMs: (walk?.durationMs ?? 1500) + (shot.passing ? PASSING_MS : DWELL_MS) });
  });
  return clips;
}

export function buildTourReel(input: {
  shots: TourShot[];
  plan: Plan | null;
  details?: ListingDetails | null;
  music?: Music | null;
}): Timeline | null {
  // Located 360 photos on a plan become one continuous walk; anything else is a sequence of shots.
  const usable = input.shots.filter((shot) => !shot.passing && shot.room !== null && WALK_ORDER.includes(shot.room));
  const fly = input.plan !== null && usable.length >= 2 && usable.every((shot) => shot.isPano && shot.spot);
  const route = fly ? flyOrder(input.shots, input.plan!) : walkOrder(input.shots);
  if (route.length < 2) return null;

  const clips: Clip[] = fly ? flyClips(route, input.plan!) : route.map((shot, index) => {
    // End the sweep on the window when the tour data says where it is.
    const aim = shot.spot?.aim;
    const pano = shot.isPano
      ? aim === undefined
        ? { ...DEFAULT_PANO, yawStart: -50, yawEnd: 50 }
        : { ...DEFAULT_PANO, yawStart: aim - SWEEP_DEGREES, yawEnd: aim }
      : null;
    return {
      id: `auto-${index}`,
      assetId: shot.assetId,
      kind: "IMAGE",
      sourceStartMs: 0,
      sourceEndMs: CLIP_MS,
      speed: 1,
      volume: 1,
      fit: "cover",
      filter: "none",
      motion: shot.isPano ? "none" : "zoom-in",
      transitionIn: index === 0 ? "cut" : "fade",
      pano,
      spot: shot.spot,
      room: shot.room,
    };
  });

  let timeline: Timeline = timelineSchema.parse({
    version: 1,
    clips,
    texts: [],
    music: input.music ?? null,
    plan: input.plan ? { geometry: input.plan, corner: "top-left", visible: true } : null,
    details: input.details ?? null,
  });
  timeline = snapCutsToBeats(timeline);
  return addRoomLabels(timeline);
}
