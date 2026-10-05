import {
  clipDurationMs,
  clipStartsMs,
  DEFAULT_PANO,
  DEFAULT_PANO_MS,
  listingDetailsSchema,
  snapCutsToBeats,
  timelineSchema,
  type Clip,
  type ListingDetails,
  type Music,
  type TextOverlay,
  type Timeline,
} from "@reelwalk/core";

type AssetRef = { id: string; durationMs: number | null; bpm?: number | null; beatOffsetMs?: number | null };

/** Asset lookup by manifest key: a Poly Haven id, `mixkit-<id>`, or `music-<id>`. */
export type AssetIndex = Record<string, AssetRef | undefined>;

function pano(index: AssetIndex, key: string, sweep: Partial<Clip["pano"] & object> = {}, extra: Partial<Clip> = {}): Clip | null {
  const asset = index[key];
  if (!asset) return null;
  return {
    id: `clip-${key}`,
    assetId: asset.id,
    kind: "IMAGE",
    sourceStartMs: 0,
    sourceEndMs: DEFAULT_PANO_MS,
    speed: 1,
    volume: 1,
    fit: "cover",
    filter: "none",
    motion: "none",
    transitionIn: "cut",
    pano: { ...DEFAULT_PANO, ...sweep },
    spot: null,
    room: null,
    ...extra,
  };
}

function video(index: AssetIndex, key: string, fromMs: number, lengthMs: number, extra: Partial<Clip> = {}): Clip | null {
  const asset = index[key];
  if (!asset) return null;
  const end = Math.min(fromMs + lengthMs, asset.durationMs ?? fromMs + lengthMs);
  if (end - fromMs < 1000) return null;
  return {
    id: `clip-${key}`,
    assetId: asset.id,
    kind: "VIDEO",
    sourceStartMs: fromMs,
    sourceEndMs: end,
    speed: 1,
    // Stock clips carry no useful sound.
    volume: 0,
    fit: "cover",
    filter: "none",
    motion: "none",
    transitionIn: "cut",
    pano: null,
    spot: null,
    room: null,
    ...extra,
  };
}

/**
 * A label tied to a clip rather than to a time, so it stays over its subject
 * when snapping to the beat changes clip lengths. `from` is how far into the
 * clip it appears; it stays until `before` ms from the clip's end.
 */
type Label = { clip: string; text: string; from?: number; before?: number } & Partial<Pick<TextOverlay, "style" | "color" | "size" | "y">>;

function music(index: AssetIndex, key: string): Music | null {
  const asset = index[`music-${key}`];
  if (!asset) return null;
  return { assetId: asset.id, sourceStartMs: 0, volume: 0.7, bpm: asset.bpm ?? null, beatOffsetMs: asset.beatOffsetMs ?? null };
}

function build(input: {
  clips: (Clip | null)[];
  labels: Label[];
  music: Music | null;
  details: ListingDetails;
  durations: Record<string, number | null>;
}): Timeline | null {
  const present = input.clips.filter((clip): clip is Clip => clip !== null);
  // A sample needs most of its clips to make sense.
  if (present.length < 3) return null;

  const timeline = snapCutsToBeats(
    timelineSchema.parse({ version: 1, clips: present, texts: [], music: input.music, plan: null, details: input.details }),
    input.durations,
  );
  const starts = clipStartsMs(timeline);
  const texts = input.labels.flatMap((label, number): TextOverlay[] => {
    const at = timeline.clips.findIndex((clip) => clip.id === `clip-${label.clip}`);
    if (at === -1) return [];
    const startMs = starts[at] + (label.from ?? 400);
    const endMs = starts[at] + clipDurationMs(timeline.clips[at]) - (label.before ?? 200);
    if (endMs - startMs < 500) return [];
    return [
      {
        id: `label-${number}`,
        text: label.text,
        startMs,
        endMs,
        x: 0.5,
        y: label.y ?? 0.3,
        style: label.style ?? "box",
        color: label.color ?? "#ffffff",
        size: label.size ?? 1,
      },
    ];
  });
  return timelineSchema.parse({ ...timeline, texts });
}

export type SampleReel = { id: string; title: string; caption: string; timeline: Timeline };

/** Ready-made reels that show what the editor does. Built only from imported media. */
export function sampleReels(index: AssetIndex): SampleReel[] {
  const durations = Object.fromEntries(Object.values(index).map((asset) => [asset!.id, asset!.durationMs]));

  // Sweep angles were chosen by looking at each 360 photo: 0 is the centre of
  // the image, negative is to its left. Each sweep ends on the room's subject.
  const reels: (Omit<SampleReel, "timeline"> & { timeline: Timeline | null })[] = [
    {
      id: "sample-country-house",
      title: "Country house tour",
      caption:
        "Just listed: a light-filled country house with a garden lounge, open fire and veranda.\n\nBook a viewing through the link in bio.\n\n#justlisted #housetour #countryhome #realestate #dreamhome",
      timeline: build({
        durations,
        music: music(index, "carefree"),
        details: listingDetailsSchema.parse({
          price: "£1,250,000",
          beds: "4",
          baths: "3",
          area: "310 m²",
          address: "Lythwood, Midlands",
          contact: "Viewings this weekend",
          placement: "end",
        }),
        clips: [
          video(index, "mixkit-8603", 2000, 3000),
          // Stone-wall sofa corner, round to the garden doors.
          pano(index, "lythwood_lounge", { yawStart: -25, yawEnd: 55 }, { transitionIn: "fade" }),
          // Sofa and painting, settling on the fire.
          pano(index, "fireplace", { yawStart: 75, yawEnd: 18 }, { filter: "warm" }),
          // Garden window, round to the bedroom's own fireplace.
          pano(index, "lythwood_room", { yawStart: 25, yawEnd: 110 }),
          // Across the veranda to the garden.
          pano(index, "veranda", { yawStart: -45, yawEnd: 10 }, { transitionIn: "fade" }),
        ],
        labels: [
          { clip: "mixkit-8603", text: "Just listed", style: "headline", y: 0.4, from: 300, before: 0 },
          { clip: "lythwood_lounge", text: "Garden lounge", color: "#ffd23f", from: 600 },
          // The fire comes into view about a third of the way through the sweep.
          { clip: "fireplace", text: "Open fireplace", color: "#ffd23f", from: 1800 },
          { clip: "lythwood_room", text: "Bedroom suite", color: "#ffd23f", from: 600 },
        ],
      }),
    },
    {
      id: "sample-city-apartment",
      title: "City apartment",
      caption:
        "A modern apartment with a chef's kitchen, a calm bedroom, a spa bathroom and its own terrace.\n\n#apartmenttour #modernliving #cityapartment #newlisting",
      timeline: build({
        durations,
        music: music(index, "bossa-antigua"),
        details: listingDetailsSchema.parse({
          price: "¥98,000,000",
          beds: "2",
          baths: "1",
          area: "74 m²",
          address: "Kanda, Chiyoda, Tokyo",
          contact: "@demo_realty",
          placement: "end",
        }),
        clips: [
          video(index, "mixkit-43033", 0, 4000),
          video(index, "mixkit-4198", 0, 3500, { transitionIn: "fade" }),
          // The pan arrives on the bed from the window.
          video(index, "mixkit-4196", 9000, 4000),
          // Shower, round to the bath under the skylight.
          pano(index, "modern_bathroom", { yawStart: -70, yawEnd: 20, fov: 95 }, { filter: "cool", transitionIn: "fade" }),
          // The last part of this clip walks out onto the terrace.
          video(index, "mixkit-4029", 36000, 4000),
        ],
        labels: [
          { clip: "mixkit-43033", text: "City apartment", style: "headline", y: 0.36, from: 300 },
          { clip: "mixkit-43033", text: "Chef's kitchen", style: "outline", y: 0.5, size: 0.8, from: 700 },
          { clip: "mixkit-4198", text: "Living area", color: "#4da3ff" },
          { clip: "mixkit-4196", text: "Bedroom", color: "#4da3ff" },
          { clip: "modern_bathroom", text: "Spa bathroom", color: "#4da3ff", from: 1100 },
          { clip: "mixkit-4029", text: "Private terrace", color: "#4da3ff", y: 0.26 },
        ],
      }),
    },
    {
      id: "sample-sea-view",
      title: "Sea-view retreat (360)",
      caption: "Wake up to the sea. Four rooms, one deck, all in 360.\n\n#seaview #holidayhome #360tour #coastalliving",
      timeline: build({
        durations,
        music: music(index, "inspired"),
        details: listingDetailsSchema.parse({
          price: "R2,400 a night",
          beds: "1",
          baths: "1",
          area: "",
          address: "Wild Coast, South Africa",
          contact: "Book direct: link in bio",
          placement: "end",
        }),
        clips: [
          // From the bed to the balcony doors and the sea.
          pano(index, "relax_inn_seaview_suite", { yawStart: 110, yawEnd: 35 }),
          // Basin, across the back of the room, to the shower.
          pano(index, "en_suite", { yawStart: 150, yawEnd: 285, fov: 95 }, { transitionIn: "fade" }),
          // Dining table, round to the sea through the glass doors.
          pano(index, "cayley_interior", { yawStart: -110, yawEnd: 5 }),
          // Along the open side of the deck.
          pano(index, "sundowner_deck", { yawStart: -40, yawEnd: 35 }, { transitionIn: "fade" }),
        ],
        labels: [
          { clip: "relax_inn_seaview_suite", text: "Sea-view retreat", style: "headline", y: 0.38, from: 300, before: 600 },
          { clip: "en_suite", text: "En suite", color: "#ff5a5f", from: 800 },
          { clip: "cayley_interior", text: "Dining with a sea view", color: "#ff5a5f", from: 1200 },
          { clip: "sundowner_deck", text: "Sundowner deck", color: "#ff5a5f", y: 0.26, from: 600 },
        ],
      }),
    },
  ];
  return reels.filter((reel): reel is SampleReel => reel.timeline !== null);
}
