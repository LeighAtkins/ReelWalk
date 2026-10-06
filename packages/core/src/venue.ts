import { z } from "zod";
import { snapCutsToBeats } from "./beats";
import {
  DETAILS_CARD_MS,
  MIN_CLIP_MS,
  textSchema,
  timelineDurationMs,
  timelineSchema,
  type Clip,
  type Filter,
  type ListingDetails,
  type Music,
  type TextOverlay,
  type TextStyle,
  type Timeline,
} from "./timeline";

/**
 * Reels for places that serve people: restaurants, cafés, bars, bakeries.
 * The input is a handful of clips (your own or stock), the dishes with their
 * prices, and a vibe. The output is an ordinary timeline: a hook, quick cuts
 * on the beat, a dish name and price over each clip, and a card at the end
 * with how to find the place.
 */

export type VenueVibe = {
  id: string;
  name: string;
  /** What it feels like, in one line, shown when choosing. */
  mood: string;
  /** Library song, by its key in the sample library ("bossa-antigua"). */
  song: string;
  filter: Filter;
  /** Target length of each clip before cuts snap to the beat. */
  cutMs: number;
  /** The line over the first seconds. {name} is the venue's name. */
  hook: string;
  hookStyle: TextStyle;
  hookColor: string;
  /** How a dish label reads. {dish} and {price} are filled in. */
  dishStyle: TextStyle;
  dishColor: string;
  /** The last line on the details card. {handle} is the venue's Instagram handle when given. */
  callToAction: string;
  /** Opening lines of the caption. {name} is filled in. */
  captionLead: string;
  hashtags: string;
};

export const VENUE_VIBES: VenueVibe[] = [
  {
    id: "golden-hour",
    name: "Golden hour",
    mood: "Warm, slow, patio light: the place you want to stay at",
    song: "bossa-antigua",
    filter: "warm",
    cutMs: 2600,
    hook: "Dinner at {name}\nstarts like this",
    hookStyle: "headline",
    hookColor: "#ffffff",
    dishStyle: "box",
    dishColor: "#ffffff",
    callToAction: "Book a table · {handle}",
    captionLead: "The light at {name} does half the work. The kitchen does the rest.",
    hashtags: "#goldenhour #dinnerdate #foodie #eatlocal #patioseason",
  },
  {
    id: "brunch-club",
    name: "Brunch club",
    mood: "Bright, cheerful, fast: weekend energy",
    song: "life-of-riley",
    filter: "vivid",
    cutMs: 1800,
    hook: "Weekend plans:\n{name}",
    hookStyle: "box",
    hookColor: "#ffd23f",
    dishStyle: "box",
    dishColor: "#ffd23f",
    callToAction: "Walk-ins welcome · {handle}",
    captionLead: "Brunch at {name}: come hungry, leave in a good mood.",
    hashtags: "#brunch #weekendvibes #coffee #brunchtime #foodie",
  },
  {
    id: "late-night",
    name: "Late night",
    mood: "Dark, moody, cool tones: cocktails and the last table",
    song: "fretless",
    filter: "cool",
    cutMs: 2200,
    hook: "{name}\nafter dark",
    hookStyle: "outline",
    hookColor: "#ffffff",
    dishStyle: "outline",
    dishColor: "#ffffff",
    callToAction: "Open late · {handle}",
    captionLead: "The kitchen at {name} stays open while the city winds down.",
    hashtags: "#latenight #cocktails #nightout #datenight #barlife",
  },
  {
    id: "chefs-table",
    name: "Chef's table",
    mood: "Quiet, considered, close-ups: let the food speak",
    song: "wallpaper",
    filter: "fade",
    cutMs: 3000,
    hook: "Three courses.\nOne table.",
    hookStyle: "plain",
    hookColor: "#ffffff",
    dishStyle: "plain",
    dishColor: "#ffffff",
    callToAction: "Reservations · {handle}",
    captionLead: "A short menu at {name}, cooked with attention.",
    hashtags: "#chefstable #tastingmenu #finedining #foodphotography #seasonal",
  },
  {
    id: "street-food",
    name: "Street food",
    mood: "Loud, fast, saturated: the queue is worth it",
    song: "funkorama",
    filter: "vivid",
    cutMs: 1400,
    hook: "Worth the queue:\n{name}",
    hookStyle: "box",
    hookColor: "#ff5a5f",
    dishStyle: "box",
    dishColor: "#ff5a5f",
    callToAction: "Find the truck · {handle}",
    captionLead: "Hot, fast and messy in the best way. {name} is open.",
    hashtags: "#streetfood #foodtruck #eatlocal #foodporn #lunchbreak",
  },
];

export function venueVibeById(id: string | null | undefined): VenueVibe | undefined {
  return VENUE_VIBES.find((vibe) => vibe.id === id);
}

export const dishSchema = z.object({
  name: z.string().trim().min(1).max(40),
  price: z.string().trim().max(12).default(""),
});
export type Dish = z.infer<typeof dishSchema>;

export const venueDetailsSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** "Neapolitan pizza", "Specialty coffee": goes in the caption. */
  cuisine: z.string().trim().max(40).default(""),
  /** The lowest price worth saying, "from $12". Shown large on the card. */
  priceFrom: z.string().trim().max(16).default(""),
  address: z.string().trim().max(80).default(""),
  /** Instagram handle, with or without the @. */
  handle: z.string().trim().max(40).default(""),
  dishes: z.array(dishSchema).max(12).default([]),
});
export type VenueDetails = z.infer<typeof venueDetailsSchema>;

export type VenueClip = {
  assetId: string;
  kind: "VIDEO" | "IMAGE";
  /** Length of a video source. Null for photos or when unknown. */
  durationMs: number | null;
};

const HOOK_MS = 2600;
/** Dish labels sit in the lower third, inside Instagram's safe area. */
const DISH_Y = 0.72;
/** Longest reel the builder makes; viewers drop off after this. */
const MAX_CLIPS = 10;

function fill(template: string, details: VenueDetails): string {
  const handle = details.handle ? (details.handle.startsWith("@") ? details.handle : `@${details.handle}`) : "";
  return template
    .replaceAll("{name}", details.name)
    .replaceAll("{handle}", handle)
    .replace(/\s*·\s*$/, "")
    .trim();
}

export function dishLabel(dish: Dish): string {
  return dish.price ? `${dish.name} · ${dish.price}` : dish.name;
}

/** The venue's facts as the details card understands them: the price large, the address, the call to action. */
export function venueCardDetails(details: VenueDetails, vibe: VenueVibe): ListingDetails {
  return {
    price: details.priceFrom ? (/^from/i.test(details.priceFrom) ? details.priceFrom : `from ${details.priceFrom}`) : details.name,
    beds: "",
    baths: "",
    area: "",
    address: details.address,
    contact: fill(vibe.callToAction, details),
    placement: "end",
  };
}

/**
 * A first draft of a venue reel. Clips keep the order given, which is the
 * order the user tapped them in; a video plays from its start for the vibe's
 * cut length, a photo gets a slow zoom. Dish labels go over the clips after
 * the hook, one dish per clip, in the order given.
 */
export function buildVenueReel(input: {
  clips: VenueClip[];
  details: VenueDetails;
  vibe: VenueVibe;
  music?: Music | null;
}): Timeline | null {
  const { vibe, details } = input;
  const picked = input.clips.slice(0, MAX_CLIPS);
  if (picked.length < 2) return null;

  const clips: Clip[] = picked.map((clip, index) => {
    const wanted = clip.kind === "IMAGE" ? Math.max(vibe.cutMs, 1800) : vibe.cutMs;
    const available = clip.kind === "VIDEO" && clip.durationMs ? clip.durationMs : Infinity;
    const length = Math.max(MIN_CLIP_MS, Math.min(wanted, available));
    return {
      id: `venue-${index}`,
      assetId: clip.assetId,
      kind: clip.kind,
      sourceStartMs: 0,
      sourceEndMs: Math.round(length),
      speed: 1,
      // The song carries the reel; kitchen noise stays low under it.
      volume: input.music ? 0.15 : 1,
      fit: "cover",
      filter: vibe.filter,
      motion: clip.kind === "IMAGE" ? (index % 2 === 0 ? "zoom-in" : "pan") : "none",
      pano: null,
      spot: null,
      room: null,
      transitionIn: index === 0 ? "cut" : vibe.cutMs >= 2500 ? "fade" : "cut",
    };
  });

  const durations = Object.fromEntries(picked.filter((clip) => clip.kind === "VIDEO").map((clip) => [clip.assetId, clip.durationMs]));
  let timeline: Timeline = timelineSchema.parse({
    version: 1,
    clips,
    texts: [],
    music: input.music ?? null,
    plan: null,
    details: venueCardDetails(details, vibe),
  });
  timeline = snapCutsToBeats(timeline, durations);

  // Texts are placed after the snap, on the final clip boundaries.
  const total = timelineDurationMs(timeline);
  const hookEnd = Math.min(HOOK_MS, Math.floor(total / 3));
  const texts: TextOverlay[] = [
    textSchema.parse({ id: "hook", text: fill(vibe.hook, details), startMs: 200, endMs: hookEnd, x: 0.5, y: 0.42, style: vibe.hookStyle, color: vibe.hookColor, size: 1.15 }),
  ];
  // Labels stop before the closing card, unless the reel is so short that the card would swallow them all.
  const cardStart = total >= 10_000 ? Math.max(hookEnd, total - DETAILS_CARD_MS) : total;
  let start = 0;
  let dish = 0;
  timeline.clips.forEach((clip, index) => {
    const end = start + (clip.sourceEndMs - clip.sourceStartMs) / (clip.kind === "IMAGE" ? 1 : clip.speed);
    const from = index === 0 ? hookEnd + 150 : start + 150;
    const to = Math.min(end - 100, cardStart);
    if (dish < details.dishes.length && to - from >= 600) {
      texts.push(
        textSchema.parse({
          id: `dish-${dish}`,
          text: dishLabel(details.dishes[dish]!),
          startMs: Math.round(from),
          endMs: Math.round(to),
          x: 0.5,
          y: DISH_Y,
          style: vibe.dishStyle,
          color: vibe.dishColor,
          size: 0.95,
        }),
      );
      dish += 1;
    }
    start = end;
  });

  return { ...timeline, texts };
}

/** The caption: the vibe's opening line, the menu with prices, where to find it, hashtags and the music credit. */
export function captionForVenue(vibe: VenueVibe, details: VenueDetails, musicCredit?: string | null): string {
  const menu = details.dishes.map((dish) => `• ${dishLabel(dish)}`).join("\n");
  const where = [details.address, details.handle ? (details.handle.startsWith("@") ? details.handle : `@${details.handle}`) : ""]
    .filter(Boolean)
    .join(" · ");
  return [
    fill(vibe.captionLead, details),
    details.cuisine ? `${details.cuisine}${details.priceFrom ? `, ${/^from/i.test(details.priceFrom) ? details.priceFrom : `from ${details.priceFrom}`}` : ""}` : "",
    menu,
    where,
    vibe.hashtags,
    musicCredit ? `Music: ${musicCredit}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n\n");
}
