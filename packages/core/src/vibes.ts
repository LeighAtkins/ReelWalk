import type { Filter, TextStyle } from "./timeline";

/**
 * A vibe is a complete treatment of a tour reel for one kind of buyer: the
 * song, the look, the pace, which rooms it lingers in, the opening line, how
 * rooms are named and what the caption says. The same home can be cut five
 * ways and posted to five audiences.
 *
 * Vibes speak to what a buyer wants to do with a home (buy a first one, rent
 * it out, work from it, host in it, renovate it). They never describe who the
 * buyer is: housing ads may not state a preference for people by age, family,
 * origin, religion or similar, and Instagram restricts targeting of housing
 * ads the same way.
 */
export type Vibe = {
  id: string;
  name: string;
  /** Who it speaks to, in one line, shown when choosing a vibe. */
  audience: string;
  /** Library song, by its key in the sample library ("carefree"). */
  song: string;
  filter: Filter;
  /** Rooms the walk stops in, most important first. The walk starts in the first one the tour has. */
  rooms: string[];
  maxStops: number;
  /** Time each room gets once the camera has walked in. Shorter is punchier. */
  dwellMs: number;
  /** The line over the first seconds: the reason to keep watching. */
  hook: string;
  hookStyle: TextStyle;
  /** Room names as shown, by room. Rooms not listed keep their plain name. Null shows no names. */
  roomNames: Record<string, string> | null;
  /** Whether the floor plan with its marker is shown. */
  plan: boolean;
  /** The call to action on the details card. */
  callToAction: string;
  /** Opening lines of the caption, before the facts. */
  captionLead: string;
  hashtags: string;
};

export const VIBES: Vibe[] = [
  {
    id: "first-keys",
    name: "First keys",
    audience: "First-time buyers: friendly, bright, shows everything",
    song: "carefree",
    filter: "warm",
    rooms: ["living room", "dining room", "kitchen", "bedroom", "bathroom", "bonus room"],
    maxStops: 8,
    dwellMs: 2200,
    hook: "Your first set\nof keys?",
    hookStyle: "headline",
    roomNames: {},
    plan: true,
    callToAction: "DM “KEYS” for the buyer guide",
    captionLead: "Stop scrolling rentals. Three bedrooms, a bonus room and a kitchen that gets the morning sun, for less than you think.",
    hashtags: "#firsthome #firsttimebuyer #househunting #starterhome #justlisted",
  },
  {
    id: "numbers",
    name: "The numbers",
    audience: "Investors: fast, factual, floor plan on screen",
    song: "funkorama",
    filter: "none",
    rooms: ["living room", "kitchen", "bedroom", "bathroom", "bonus room", "dining room"],
    maxStops: 8,
    dwellMs: 1300,
    hook: "3 bed · 2 bath\n1,640 sq ft",
    hookStyle: "box",
    roomNames: { "bonus room": "4th bedroom potential" },
    plan: true,
    callToAction: "DM “COMPS” for rent estimates",
    captionLead: "Three bedrooms plus a bonus room on one level. Vacant, clean and ready for a tenant.",
    hashtags: "#realestateinvesting #rentalproperty #investmentproperty #cashflow #buyandhold",
  },
  {
    id: "work-from-home",
    name: "Work from home",
    audience: "Remote workers: calm, cool light, the spare room as an office",
    song: "fretless",
    filter: "cool",
    rooms: ["living room", "bonus room", "kitchen", "bedroom"],
    maxStops: 5,
    dwellMs: 2800,
    hook: "Commute:\n12 steps.",
    hookStyle: "headline",
    roomNames: { "bonus room": "Your office, with a door", kitchen: "Coffee, 12 steps away", "living room": "Logged off" },
    plan: true,
    callToAction: "DM “TOUR” to see it this week",
    captionLead: "A room with a door for the 9 to 5, and a living room that is nowhere near your desk.",
    hashtags: "#workfromhome #homeoffice #remotework #wfhlife #housetour",
  },
  {
    id: "host",
    name: "Made for hosting",
    audience: "People who entertain: living, dining and kitchen only, warm and lively",
    song: "bossa-antigua",
    filter: "vivid",
    rooms: ["living room", "dining room", "kitchen", "bonus room"],
    maxStops: 4,
    dwellMs: 2600,
    hook: "Dinner for eight?\nEasy.",
    hookStyle: "headline",
    roomNames: { "living room": "Drinks here", "dining room": "Dinner here", kitchen: "Everyone ends up here", "bonus room": "Games room?" },
    plan: false,
    callToAction: "DM “HOST” for a private viewing",
    captionLead: "Living room, dining room and kitchen in one easy loop. Your friends will not want to leave.",
    hashtags: "#dinnerparty #entertaining #openplanliving #kitcheninspo #housetour",
  },
  {
    id: "blank-canvas",
    name: "Blank canvas",
    audience: "Renovators and design lovers: slow, black and white, no labels",
    song: "inspired",
    filter: "mono",
    rooms: ["living room", "kitchen", "bedroom", "bathroom"],
    maxStops: 5,
    dwellMs: 3200,
    hook: "A blank canvas.",
    hookStyle: "outline",
    roomNames: null,
    plan: false,
    callToAction: "DM “PLANS” for the floor plan",
    captionLead: "Good bones, good light, nothing to undo. Bring your own palette.",
    hashtags: "#renovation #fixerupper #interiordesign #beforeandafter #homeproject",
  },
];

export function vibeById(id: string | null | undefined): Vibe | undefined {
  return VIBES.find((vibe) => vibe.id === id);
}
