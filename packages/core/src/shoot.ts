import { z } from "zod";

/**
 * Shoot assist (ADR 0063): a short, ordered shot list for the phone, made
 * before anything is filmed, from the kind of property and the rooms the
 * agent will film (or the listing text). The model answers in strict JSON
 * (`SHOT_LIST_JSON_SCHEMA`); `standardShotList` is the same list made
 * without a model, used when asking is not available or did not work.
 * Uploads are matched back to the shots by the order they were filmed in.
 */

export const MAX_SHOTS = 12;

export const PROPERTY_TYPES = ["house", "apartment", "townhouse", "villa", "cabin", "commercial"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/** How the phone moves during a shot. */
export const SHOT_MOVES = ["walk-in", "pan-left", "pan-right", "push-in", "pull-out", "tilt-up", "tilt-down", "static"] as const;
export type ShotMove = (typeof SHOT_MOVES)[number];

export const SHOT_MOVE_LABELS: Record<ShotMove, string> = {
  "walk-in": "Walk in",
  "pan-left": "Pan left",
  "pan-right": "Pan right",
  "push-in": "Push in",
  "pull-out": "Pull out",
  "tilt-up": "Tilt up",
  "tilt-down": "Tilt down",
  static: "Hold still",
};

const roomName = z.string().trim().toLowerCase().min(1).max(40);

/** What the agent tells us before filming. */
export const shootRequestSchema = z
  .object({
    propertyType: z.enum(PROPERTY_TYPES).default("house"),
    rooms: z.array(roomName).max(20).default([]),
    listing: z.string().trim().max(1500).default(""),
  })
  .refine((request) => request.rooms.length > 0 || request.listing.length >= 20, { message: "Pick the rooms you will film, or paste the listing." });
export type ShootRequest = z.infer<typeof shootRequestSchema>;

const clampHold = (value: number) => Math.min(8, Math.max(1, Math.round(value)));

export const shotSchema = z.object({
  room: roomName,
  /** Short, for the checkbox: "Front door". */
  title: z.string().trim().min(1).max(60),
  /** How to film it, in one or two plain sentences. */
  how: z.string().trim().min(1).max(220),
  move: z.enum(SHOT_MOVES),
  /** Seconds to hold at the end (or film for, when static). */
  holdS: z.number().finite().transform(clampHold),
});
export type Shot = z.infer<typeof shotSchema>;

/** A model's answer, validated. More than `MAX_SHOTS` shots are cut to the first twelve; none is an error. */
export const shotListSchema = z.object({
  note: z.string().trim().max(240).default(""),
  shots: z.array(shotSchema).min(1).transform((shots) => shots.slice(0, MAX_SHOTS)),
});
export type ShotList = z.infer<typeof shotListSchema>;

/** Strict structured-output schema: every field required, no extras. Ranges are in the descriptions; Zod enforces them. */
export const SHOT_LIST_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["note", "shots"],
  properties: {
    note: { type: "string", description: "One short sentence for the agent before they start, e.g. the light or the order. May be empty." },
    shots: {
      type: "array",
      description: `In filming order, at most ${MAX_SHOTS}`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["room", "title", "how", "move", "holdS"],
        properties: {
          room: { type: "string", description: "The room or place, lower case: exterior, front door, kitchen, living room, primary bedroom, pool, view" },
          title: { type: "string", description: "Two to four words for a checkbox" },
          how: { type: "string", description: "How to film it, under 200 characters: where to stand, phone height, the move, what to hold on" },
          move: { type: "string", enum: [...SHOT_MOVES] },
          holdS: { type: "number", description: "Seconds to hold at the end, 1 to 8" },
        },
      },
    },
  },
} as const;

export const SHOT_LIST_SYSTEM_PROMPT = [
  "You plan the filming of a short vertical real-estate reel (Instagram, 9:16) that an agent will shoot on a phone, alone, in one visit.",
  `Return an ordered shot list of at most ${MAX_SHOTS} shots, in the order the agent walks the property: arrival and exterior first, the front door, the main living spaces, the kitchen, bedrooms and bathrooms, then outdoor spaces, ending on the best view or the hero exterior.`,
  "Only include rooms the agent says they will film, or that the listing text mentions; add the exterior and the front door when the property has them. Combine minor rooms rather than exceed the limit.",
  "Each shot is one continuous clip of 3 to 6 seconds. Say how to film it in plain words: where to stand, phone height (chest height, counter height, low), one slow move, and what to hold on and for how long. Example: 'Walk through the front door slowly, phone at chest height, hold 3 s on the view.'",
  "Moves are slow and steady; no fast turns, no zooming with the camera app. Phone upright (vertical).",
  "Write for a busy agent: short, concrete, no jargon. Do not invent features the agent did not mention.",
].join("\n");

/** The text the model sees: the property, the rooms and the listing. */
export function describeShootRequest(request: ShootRequest): string {
  return [
    `Property: ${request.propertyType}.`,
    request.rooms.length ? `Rooms the agent will film: ${request.rooms.join(", ")}.` : "The agent did not list rooms; use the listing.",
    request.listing ? `Listing text:\n${request.listing}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The order a walk-through visits places in. Unknown rooms sit with the living spaces. */
const WALK_ORDER = [
  "aerial", "exterior", "front door", "entry", "living room", "family room", "dining room", "kitchen", "office",
  "hallway", "stairs", "primary bedroom", "bedroom", "bathroom", "laundry", "garage", "patio", "balcony", "garden", "pool", "view",
];
const walkRank = (room: string) => {
  const at = WALK_ORDER.indexOf(room);
  return at === -1 ? WALK_ORDER.indexOf("office") + 0.5 : at;
};

const HOW: Record<string, Omit<Shot, "room">> = {
  aerial: { title: "From above", how: "If you fly a drone: rise slowly over the roof towards the best view. Skip this shot otherwise.", move: "tilt-down", holdS: 3 },
  exterior: { title: "Arrival", how: "From across the street, phone upright at chest height. Walk slowly towards the house and hold 3 s on the front.", move: "push-in", holdS: 3 },
  "front door": { title: "Front door", how: "Walk through the front door slowly, phone at chest height, and hold 3 s on the first view inside.", move: "walk-in", holdS: 3 },
  entry: { title: "Entry", how: "Step in and hold 2 s, then turn slowly towards the main room.", move: "pan-right", holdS: 2 },
  "living room": { title: "Living room", how: "From a corner, slow pan right across the room to the windows. Hold 3 s on the light.", move: "pan-right", holdS: 3 },
  "family room": { title: "Family room", how: "From the doorway, slow pan across the seating to the windows. Hold 2 s.", move: "pan-right", holdS: 2 },
  "dining room": { title: "Dining", how: "Phone at table height, push in slowly towards the table. Hold 2 s.", move: "push-in", holdS: 2 },
  kitchen: { title: "Kitchen", how: "Phone at counter height, slow pan left across the kitchen island. Hold 3 s at the end.", move: "pan-left", holdS: 3 },
  office: { title: "Office", how: "From the doorway, slow pan from the desk to the window. Hold 2 s.", move: "pan-right", holdS: 2 },
  hallway: { title: "Hallway", how: "Walk slowly down the hall, phone level at chest height, no turning.", move: "walk-in", holdS: 2 },
  stairs: { title: "Stairs", how: "Walk up slowly, phone level at chest height, and hold 2 s at the top.", move: "walk-in", holdS: 2 },
  "primary bedroom": { title: "Primary bedroom", how: "From the doorway, walk slowly to the foot of the bed and hold 3 s on the window.", move: "walk-in", holdS: 3 },
  bedroom: { title: "Bedroom", how: "From the doorway, slow pan across the bed to the window. Hold 2 s.", move: "pan-left", holdS: 2 },
  bathroom: { title: "Bathroom", how: "Stand in the doorway; tilt slowly down from the mirror to the vanity. Hold 2 s.", move: "tilt-down", holdS: 2 },
  laundry: { title: "Laundry", how: "One still shot from the doorway, 2 s.", move: "static", holdS: 2 },
  garage: { title: "Garage", how: "From the door, slow pan across the space. Hold 2 s.", move: "pan-right", holdS: 2 },
  patio: { title: "Patio", how: "Walk out through the door onto the patio and hold 3 s on the view.", move: "walk-in", holdS: 3 },
  balcony: { title: "Balcony", how: "Walk out to the rail and hold 3 s on the view.", move: "walk-in", holdS: 3 },
  garden: { title: "Garden", how: "From the back door, slow pan left across the garden. Hold 2 s.", move: "pan-left", holdS: 2 },
  pool: { title: "Pool", how: "Low at the water's edge, push in slowly towards the view. Hold 3 s.", move: "push-in", holdS: 3 },
  view: { title: "The view", how: "Hold the phone still on the best view for 4 s. Last shot of the reel.", move: "static", holdS: 4 },
};

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Rooms named in a listing ("open-plan kitchen", "3 bedrooms", "ensuite"), in the words the shot list uses. */
export function roomsFromListing(listing: string): string[] {
  const text = listing.toLowerCase();
  const found: string[] = [];
  const add = (room: string, ...patterns: RegExp[]) => {
    if (patterns.some((pattern) => pattern.test(text)) && !found.includes(room)) found.push(room);
  };
  add("exterior", /\bfa[cç]ade\b/, /\bcurb appeal\b/, /\bexterior\b/);
  add("entry", /\bentry\b/, /\bfoyer\b/, /\bentrance hall\b/);
  add("living room", /\bliving\b/, /\blounge\b/, /\bsitting room\b/);
  add("family room", /\bfamily room\b/, /\bden\b/, /\brumpus\b/);
  add("dining room", /\bdining\b/);
  add("kitchen", /\bkitchen\b/, /\bisland\b/);
  add("office", /\boffice\b/, /\bstudy\b/);
  add("stairs", /\bstair(case|s)?\b/);
  add("primary bedroom", /\b(primary|master|main) (bed|suite|bedroom)\b/);
  add("bedroom", /\bbed(room)?s?\b/);
  add("bathroom", /\bbath(room)?s?\b/, /\bensuite\b/, /\bshower\b/);
  add("laundry", /\blaundry\b/);
  add("garage", /\bgarage\b/, /\bcarport\b/);
  add("patio", /\bpatio\b/, /\bdeck\b/, /\bterrace\b/, /\bveranda\b/);
  add("balcony", /\bbalcon(y|ies)\b/);
  add("garden", /\bgarden\b/, /\byard\b/, /\blawn\b/);
  add("pool", /\bpool\b/);
  add("view", /\bviews?\b/, /\bocean\b/, /\bwaterfront\b/, /\bskyline\b/);
  return found;
}

/**
 * The shot list without a model: the rooms in walk order, each with the
 * house way of filming it, arrival and the front door first (not for an
 * apartment's exterior), at most twelve. The same request always gives the
 * same list.
 */
export function standardShotList(request: ShootRequest): ShotList {
  const asked = request.rooms.length ? request.rooms : roomsFromListing(request.listing);
  const rooms = [...asked];
  if (!rooms.includes("front door")) rooms.unshift("front door");
  if (request.propertyType !== "apartment" && !rooms.includes("exterior")) rooms.unshift("exterior");
  // A stable sort: repeated rooms ("bedroom", "bedroom") keep their order and are numbered.
  const ordered = rooms.map((room, index) => ({ room, index })).sort((a, b) => walkRank(a.room) - walkRank(b.room) || a.index - b.index);
  const seen = new Map<string, number>();
  const shots: Shot[] = ordered.map(({ room }) => {
    const count = (seen.get(room) ?? 0) + 1;
    seen.set(room, count);
    const base = HOW[room] ?? { title: capital(room), how: `From the doorway, slow pan across the ${room}. Hold 3 s on its best feature.`, move: "pan-right" as const, holdS: 3 };
    return { room, ...base, title: count > 1 ? `${base.title} ${count}`.slice(0, 60) : base.title.slice(0, 60) };
  });
  // Over the limit, the last places in the walk are dropped, but the view (the ending) is kept.
  let kept = shots;
  if (shots.length > MAX_SHOTS) {
    const ending = shots.at(-1)!.room === "view" ? [shots.at(-1)!] : [];
    kept = [...shots.slice(0, MAX_SHOTS - ending.length), ...ending];
  }
  return { note: "Film in this order, phone upright, slow and steady. Tick each shot as you go.", shots: kept };
}

/** A file picked after filming: its name and when it was made (File.lastModified, which phones set to the capture time). */
export type FilmedFile = { name: string; lastModified: number };

/**
 * Uploads matched to shots by the order they were filmed in. Files are put in
 * capture order (time, then name); the n-th file is the n-th shot that was
 * ticked (every shot, when none was). Files beyond the list keep no room.
 * Returns the files in reel order with the room each one is.
 */
export function matchUploadsToShots(files: FilmedFile[], shots: Shot[], ticked: boolean[] = []): { file: number; room: string | null; shot: number | null }[] {
  const targets = shots.map((_, index) => index).filter((index) => !ticked.some(Boolean) || ticked[index]);
  return files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => a.file.lastModified - b.file.lastModified || a.file.name.localeCompare(b.file.name) || a.index - b.index)
    .map(({ index }, order) => {
      const shot = targets[order] ?? null;
      return { file: index, shot, room: shot === null ? null : shots[shot].room };
    });
}
