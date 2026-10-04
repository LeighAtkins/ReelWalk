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
  return timelineSchema.parse({ version: 1, clips: present, texts, music: null });
}

export type SampleReel = { id: string; title: string; caption: string; timeline: Timeline };

/** Ready-made reels that show what the editor does. Built only from imported media. */
export function sampleReels(index: AssetIndex): SampleReel[] {
  const reels: (Omit<SampleReel, "timeline"> & { timeline: Timeline | null })[] = [
    {
      id: "sample-country-house",
      title: "Country house tour",
      caption:
        "Just listed: a light-filled country house with a garden lounge, open fire and veranda.\n\nBook a viewing through the link in bio.\n\n#justlisted #housetour #countryhome #realestate #dreamhome",
      timeline: build(
        [
          video(index, "mixkit-8603", 2000, 3000),
          pano(index, "lythwood_lounge", { yawStart: -70, yawEnd: 60 }, { transitionIn: "fade" }),
          pano(index, "fireplace", { yawStart: -40, yawEnd: 50 }, { filter: "warm" }),
          pano(index, "lythwood_room", { yawStart: 20, yawEnd: 110 }),
          pano(index, "veranda", { yawStart: -60, yawEnd: 30 }, { transitionIn: "fade" }),
        ],
        [
          text("t-title", "Just listed", 300, 3000, { style: "headline", y: 0.4 }),
          text("t-lounge", "Garden lounge", 3400, 7600, { style: "box", color: "#ffd23f", y: 0.3 }),
          text("t-fire", "Open fireplace", 8400, 12600, { style: "box", color: "#ffd23f", y: 0.3 }),
          text("t-cta", "Viewings this weekend", 18400, 23000, { style: "headline", size: 0.8, y: 0.45 }),
        ],
      ),
    },
    {
      id: "sample-city-apartment",
      title: "City apartment",
      caption:
        "A modern apartment with a chef's kitchen, a studio living space and a spa bathroom.\n\n#apartmenttour #modernliving #cityapartment #newlisting",
      timeline: build(
        [
          video(index, "mixkit-43033", 0, 4000),
          pano(index, "glasshouse_interior", { yawStart: -80, yawEnd: 40 }),
          video(index, "mixkit-3111", 0, 3500, { transitionIn: "fade" }),
          pano(index, "modern_bathroom", { yawStart: -30, yawEnd: 60, fov: 95 }, { filter: "cool" }),
          video(index, "mixkit-3112", 0, 3500),
        ],
        [
          text("t-title", "City apartment", 300, 3600, { style: "headline", y: 0.38 }),
          text("t-kitchen", "Chef's kitchen", 600, 3800, { style: "outline", y: 0.52, size: 0.8 }),
          text("t-bath", "Spa bathroom", 13000, 17000, { style: "box", color: "#4da3ff", y: 0.3 }),
        ],
      ),
    },
    {
      id: "sample-sea-view",
      title: "Sea-view retreat (360)",
      caption: "Wake up to the sea. Four rooms, one deck, all in 360.\n\n#seaview #holidayhome #360tour #coastalliving",
      timeline: build(
        [
          pano(index, "relax_inn_seaview_suite", { yawStart: -90, yawEnd: 20 }),
          pano(index, "en_suite", { yawStart: -40, yawEnd: 40, fov: 95 }, { transitionIn: "fade" }),
          pano(index, "cayley_interior", { yawStart: 0, yawEnd: 100 }),
          pano(index, "sundowner_deck", { yawStart: -60, yawEnd: 60 }, { filter: "vivid", transitionIn: "fade" }),
        ],
        [
          text("t-title", "Sea-view retreat", 300, 4200, { style: "headline", y: 0.4 }),
          text("t-deck", "Sundowner deck", 15600, 19600, { style: "box", color: "#ff5a5f", y: 0.3 }),
        ],
      ),
    },
  ];
  return reels.filter((reel): reel is SampleReel => reel.timeline !== null);
}
