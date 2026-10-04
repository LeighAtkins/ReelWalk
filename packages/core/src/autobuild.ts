import type { Plan, Spot } from "./plan";
import { addRoomLabels, DEFAULT_PANO, timelineSchema, type Clip, type ListingDetails, type Music, type Timeline } from "./timeline";
import { snapCutsToBeats } from "./beats";

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
};

/** Rooms worth a shot, in viewing order. Closets, pantries and laundry rooms are left out. */
export const WALK_ORDER = ["living room", "dining room", "kitchen", "hallway", "bedroom", "bathroom", "bonus room", "garage"];

const CLIP_MS = 4000;
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
  const remaining = shots.filter((shot) => shot.room !== null && WALK_ORDER.includes(shot.room));
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

export function buildTourReel(input: {
  shots: TourShot[];
  plan: Plan | null;
  details?: ListingDetails | null;
  music?: Music | null;
}): Timeline | null {
  const route = walkOrder(input.shots);
  if (route.length < 2) return null;

  const clips: Clip[] = route.map((shot, index) => {
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
