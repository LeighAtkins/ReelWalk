/**
 * Openly licensed sample media for the editor's library. Nothing here is
 * stored in the repository: the importer downloads each file from its source
 * and records where it came from and under which licence.
 *
 * - 360 photos: Poly Haven, CC0 (public domain). https://polyhaven.com/license
 * - Videos: Mixkit, Mixkit Stock Video Free License (free for commercial and
 *   non-commercial projects, including social media posts; not for
 *   redistribution as stock). https://mixkit.co/license/#videoFree
 * - Music: FreePD, which published its catalogue as CC0 (public domain). The
 *   site closed; the catalogue is mirrored on the Internet Archive.
 */

export type LibraryPano = { kind: "pano"; id: string; title: string };
export type LibraryVideo = { kind: "video"; id: number; slug: string; title: string; quality: 720 | 1080 };
export type LibraryMusic = { kind: "music"; id: string; file: string; title: string };
export type LibraryItem = LibraryPano | LibraryVideo | LibraryMusic;

export const POLY_HAVEN = {
  license: "CC0 1.0",
  attribution: "Poly Haven",
  fileUrl: (id: string) => `https://dl.polyhaven.org/file/ph-assets/HDRIs/extra/Tonemapped%20JPG/${id}.jpg`,
  pageUrl: (id: string) => `https://polyhaven.com/a/${id}`,
};

export const MIXKIT = {
  license: "Mixkit Stock Video Free License",
  attribution: "Mixkit",
  fileUrl: (id: number, quality: number) => `https://assets.mixkit.co/videos/${id}/${id}-${quality}.mp4`,
  pageUrl: (slug: string, id: number) => `https://mixkit.co/free-stock-video/${slug}-${id}/`,
};

export const FREEPD = {
  license: "CC0 1.0",
  attribution: "FreePD",
  fileUrl: (file: string) => `https://archive.org/download/freepd/${file.split("/").map(encodeURIComponent).join("/")}`,
  pageUrl: "https://archive.org/details/freepd",
};

export const LIBRARY: LibraryItem[] = [
  // 360 photos of real homes and rooms.
  { kind: "pano", id: "lythwood_lounge", title: "Lounge with garden doors (360)" },
  { kind: "pano", id: "lythwood_room", title: "Bedroom with sitting area (360)" },
  { kind: "pano", id: "fireplace", title: "Fireside lounge (360)" },
  { kind: "pano", id: "anniversary_lounge", title: "Family lounge (360)" },
  { kind: "pano", id: "wooden_lounge", title: "Timber lounge (360)" },
  { kind: "pano", id: "reading_room", title: "Reading room (360)" },
  { kind: "pano", id: "combination_room", title: "Period sitting room (360)" },
  { kind: "pano", id: "glasshouse_interior", title: "Glasshouse studio flat (360)" },
  { kind: "pano", id: "kiara_interior", title: "Open-plan kitchen (360)" },
  { kind: "pano", id: "blinds", title: "Kitchen with window light (360)" },
  { kind: "pano", id: "lebombo", title: "House entrance and lounge (360)" },
  { kind: "pano", id: "small_empty_house", title: "Empty house, ready to stage (360)" },
  { kind: "pano", id: "cayley_interior", title: "Dining room with balcony view (360)" },
  { kind: "pano", id: "modern_bathroom", title: "Modern bathroom (360)" },
  { kind: "pano", id: "en_suite", title: "En suite bathroom (360)" },
  { kind: "pano", id: "bathroom", title: "Family bathroom (360)" },
  { kind: "pano", id: "hotel_room", title: "Guest bedroom (360)" },
  { kind: "pano", id: "relax_inn_seaview_suite", title: "Sea-view bedroom suite (360)" },
  { kind: "pano", id: "pine_attic", title: "Pine attic room (360)" },
  { kind: "pano", id: "veranda", title: "Veranda (360)" },
  { kind: "pano", id: "lapa", title: "Thatched garden lapa (360)" },
  { kind: "pano", id: "sundowner_deck", title: "Sundowner deck (360)" },

  // Interior and exterior video.
  { kind: "video", id: 43033, slug: "interior-view-of-a-spacious-modern-kitchen", title: "Spacious modern kitchen", quality: 1080 },
  { kind: "video", id: 3111, slug: "master-bedroom-and-window", title: "Master bedroom and window", quality: 1080 },
  { kind: "video", id: 3112, slug: "interior-of-a-department-room", title: "Apartment living room", quality: 1080 },
  { kind: "video", id: 4029, slug: "interior-of-a-room-with-terrace", title: "Room with terrace", quality: 720 },
  { kind: "video", id: 4196, slug: "luxury-hotel-room-panning-shot", title: "Luxury suite, panning shot", quality: 1080 },
  { kind: "video", id: 4198, slug: "pan-shot-of-the-interior-of-a-hotel-room", title: "Bedroom suite, pan", quality: 1080 },
  { kind: "video", id: 8603, slug: "aerial-view-of-manor-house-in-a-hilly-orchard", title: "Manor house from the air", quality: 720 },
  { kind: "video", id: 15064, slug: "house-keys-on-a-table", title: "House keys on a table", quality: 720 },

  // Music. Tempo is detected at import, so cuts can snap to the beat.
  { kind: "music", id: "acoustic-shifter", file: "Page2/Acoustic Shifter.mp3", title: "Acoustic Shifter" },
  { kind: "music", id: "chill-beat", file: "Page2/Chill Beat.mp3", title: "Chill Beat" },
  { kind: "music", id: "brighter-sun", file: "Page2/Brighter Sun.mp3", title: "Brighter Sun" },
  { kind: "music", id: "electro-chill-b", file: "Page2/Electro Chill B.mp3", title: "Electro Chill B" },
];
