import { DEFAULT_PANO, DEFAULT_PANO_MS, timelineSchema, type Clip, type TextOverlay, type Timeline } from "@reelwalk/core";

type AssetRef = { id: string; durationMs: number | null };

/** Asset lookup by manifest key: a Poly Haven id, or `mixkit-<id>`. */
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

function text(id: string, value: string, startMs: number, endMs: number, extra: Partial<TextOverlay> = {}): TextOverlay {
  return { id, text: value, startMs, endMs, x: 0.5, y: 0.42, style: "plain", color: "#ffffff", size: 1, ...extra };
}

function build(clips: (Clip | null)[], texts: TextOverlay[]): Timeline | null {
  const present = clips.filter((clip): clip is Clip => clip !== null);
  // A sample needs most of its clips to make sense.
  if (present.length < 3) return null;
  return timelineSchema.parse({ version: 1, clips: present, texts, music: null, plan: null });
}

export type SampleReel = { id: string; title: string; caption: string; timeline: Timeline };

/** Ready-made reels that show what the editor does. Built only from imported media. */
export function sampleReels(index: AssetIndex): SampleReel[] {
  // Sweep angles were chosen by looking at each 360 photo: 0 is the centre of
  // the image, negative is to its left. Each sweep ends on the room's subject,
  // and its label is on screen while that subject is in view.
  const reels: (Omit<SampleReel, "timeline"> & { timeline: Timeline | null })[] = [
    {
      id: "sample-country-house",
      title: "Country house tour",
      caption:
        "Just listed: a light-filled country house with a garden lounge, open fire and veranda.\n\nBook a viewing through the link in bio.\n\n#justlisted #housetour #countryhome #realestate #dreamhome",
      timeline: build(
        [
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
        [
          text("t-title", "Just listed", 300, 3000, { style: "headline", y: 0.4 }),
          text("t-lounge", "Garden lounge", 3600, 7800, { style: "box", color: "#ffd23f", y: 0.3 }),
          text("t-fire", "Open fireplace", 9800, 12800, { style: "box", color: "#ffd23f", y: 0.3 }),
          text("t-suite", "Bedroom suite", 13600, 17800, { style: "box", color: "#ffd23f", y: 0.3 }),
          text("t-cta", "Viewings this weekend", 18600, 23000, { style: "headline", size: 0.8, y: 0.45 }),
        ],
      ),
    },
    {
      id: "sample-city-apartment",
      title: "City apartment",
      caption:
        "A modern apartment with a chef's kitchen, a calm bedroom, a spa bathroom and its own terrace.\n\n#apartmenttour #modernliving #cityapartment #newlisting",
      timeline: build(
        [
          video(index, "mixkit-43033", 0, 4000),
          video(index, "mixkit-4198", 0, 3500, { transitionIn: "fade" }),
          // The pan arrives on the bed from the window.
          video(index, "mixkit-4196", 9000, 4000),
          // Shower, round to the bath under the skylight.
          pano(index, "modern_bathroom", { yawStart: -70, yawEnd: 20, fov: 95 }, { filter: "cool", transitionIn: "fade" }),
          // The last part of this clip walks out onto the terrace.
          video(index, "mixkit-4029", 36000, 4000),
        ],
        [
          text("t-title", "City apartment", 300, 3700, { style: "headline", y: 0.36 }),
          text("t-kitchen", "Chef's kitchen", 700, 3700, { style: "outline", y: 0.5, size: 0.8 }),
          text("t-living", "Living area", 4400, 7300, { style: "box", color: "#4da3ff", y: 0.3 }),
          text("t-bed", "Bedroom", 7900, 11300, { style: "box", color: "#4da3ff", y: 0.3 }),
          text("t-bath", "Spa bathroom", 12600, 16300, { style: "box", color: "#4da3ff", y: 0.3 }),
          text("t-terrace", "Private terrace", 17000, 20300, { style: "headline", size: 0.8, y: 0.42 }),
        ],
      ),
    },
    {
      id: "sample-sea-view",
      title: "Sea-view retreat (360)",
      caption: "Wake up to the sea. Four rooms, one deck, all in 360.\n\n#seaview #holidayhome #360tour #coastalliving",
      timeline: build(
        [
          // From the bed to the balcony doors and the sea.
          pano(index, "relax_inn_seaview_suite", { yawStart: 110, yawEnd: 35 }),
          // Basin, across the back of the room, to the shower.
          pano(index, "en_suite", { yawStart: 150, yawEnd: 285, fov: 95 }, { transitionIn: "fade" }),
          // Dining table, round to the sea through the glass doors.
          pano(index, "cayley_interior", { yawStart: -110, yawEnd: 5 }),
          // Along the open side of the deck.
          pano(index, "sundowner_deck", { yawStart: -40, yawEnd: 35 }, { transitionIn: "fade" }),
        ],
        [
          text("t-title", "Sea-view retreat", 300, 4400, { style: "headline", y: 0.38 }),
          text("t-bath", "En suite", 5800, 9600, { style: "box", color: "#ff5a5f", y: 0.3 }),
          text("t-dining", "Dining with a sea view", 11200, 14600, { style: "box", color: "#ff5a5f", y: 0.3 }),
          text("t-deck", "Sundowner deck", 15800, 19600, { style: "box", color: "#ff5a5f", y: 0.3 }),
        ],
      ),
    },
  ];
  return reels.filter((reel): reel is SampleReel => reel.timeline !== null);
}
