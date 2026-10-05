import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildTourReel,
  captionForVibe,
  listingDetailsSchema,
  MAX_SHELL_POINTS,
  normalizePlan,
  roomTitle,
  type Plan,
  type Shell,
  type Spot,
  type TourShot,
  VIBES,
} from "@reelwalk/core";
import { DEFAULT_USER_EMAIL, prisma } from "@reelwalk/db";
import { panoThumbnail, probe, upload } from "./library/tools";

/**
 * Imports home tours in the Zillow Indoor Dataset (ZInD) format: 360 photos
 * of every room, plus the floor plan and where each photo was taken on it.
 * Each tour becomes a Tour (the plan), located 360 photos in the library, and
 * a sample reel with the floor plan marker.
 *
 * ZInD data is licensed by Zillow for academic, non-commercial use only. It is
 * read from a local folder that is not part of this repository, and reels
 * made from it are for local testing, not for posting.
 *
 *   docker compose run --rm import-zind
 */

const TOURS_DIR = process.env.ZIND_DIR ?? "/data/zind/sample_tour";
const LICENSE = "ZInD Terms of Use (academic, non-commercial)";
const ATTRIBUTION = "Zillow Indoor Dataset";
const SOURCE_URL = "https://github.com/zillow/zind";

type Point = [number, number];
type ZindPano = {
  label: string;
  is_primary: boolean;
  is_inside: boolean;
  image_path: string;
  floor_plan_transformation: { translation: Point; rotation: number; scale: number };
  camera_height: number;
  ceiling_height: number;
  layout_raw?: { vertices?: Point[]; windows?: Point[] };
  /** The whole space the photo is in, where an open-plan area was annotated in parts. */
  layout_complete?: { vertices?: Point[] };
};
type ZindData = {
  merger: Record<string, Record<string, Record<string, Record<string, ZindPano>>>>;
  redraw: Record<string, Record<string, { vertices: Point[]; doors: [Point, Point][] }>>;
};

/**
 * Where the room's widest window is, as a camera yaw from the centre of the
 * photo. ZInD lists each window as three points in the room's own
 * coordinates, with the camera at the origin: left edge, right edge, and a
 * (bottom, top) pair. In ZInD's convention a point (x, y) is seen at
 * atan2(-x, y) from the centre of the photo, positive to the right.
 */
function windowAim(pano: ZindPano): number | undefined {
  const points = pano.layout_raw?.windows ?? [];
  let best: { width: number; yaw: number } | undefined;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const [left, right] = [points[i], points[i + 1]];
    const width = Math.hypot(right[0] - left[0], right[1] - left[1]);
    const mid: Point = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
    if (!best || width > best.width) best = { width, yaw: Math.round((Math.atan2(-mid[0], mid[1]) * 180) / Math.PI) };
  }
  return best?.yaw;
}

/**
 * ZInD gives each photo's rotation on the plan in degrees. The centre of the
 * photo looks along the room's local +y axis, which that rotation turns
 * counter-clockwise; the plan's y axis points down the page. Heading here is
 * degrees clockwise from the top of the plan. (Checked against the sample
 * tour: the garage photo faces the garage door, the living room one its bay window.)
 */
function headingFor(rotation: number): number {
  const r = (rotation * Math.PI) / 180;
  const dx = -Math.sin(r);
  const dy = Math.cos(r);
  return Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/**
 * The room around a photo, as an outline on the plan. ZInD gives the walls in
 * the photo's own coordinates (camera at the origin, one unit = the camera's
 * height); its plan transformation turns them counter-clockwise, scales and
 * shifts them onto the plan. (Checked against the sample tour: the outlines
 * land on the plan's room corners to within a centimetre or two.)
 */
function shellFor(pano: ZindPano, toPlan: (x: number, y: number) => [number, number], planHeight: number): Shell | undefined {
  const complete = pano.layout_complete?.vertices ?? [];
  const vertices = complete.length >= 3 && complete.length <= MAX_SHELL_POINTS ? complete : (pano.layout_raw?.vertices ?? []);
  if (vertices.length < 3 || vertices.length > MAX_SHELL_POINTS || !(pano.camera_height > 0)) return undefined;
  const { translation, rotation, scale } = pano.floor_plan_transformation;
  const r = (rotation * Math.PI) / 180;
  return {
    points: vertices.map(([x, y]) =>
      toPlan((x * Math.cos(r) - y * Math.sin(r)) * scale + translation[0], (x * Math.sin(r) + y * Math.cos(r)) * scale + translation[1]),
    ),
    eye: (scale * pano.camera_height) / planHeight,
    ceiling: Math.min(6, Math.max(1.05, pano.ceiling_height / pano.camera_height)),
  };
}

async function importTour(dir: string, name: string, workspaceId: string, workdir: string): Promise<void> {
  const data = JSON.parse(await readFile(path.join(dir, "zind_data.json"), "utf8")) as ZindData;
  const floorId = Object.keys(data.redraw)[0];
  const rooms = Object.values(data.redraw[floorId]);
  const { plan, toPlan, height } = normalizePlan(
    rooms.map((room) => room.vertices),
    rooms.flatMap((room) => room.doors),
  );

  const tourId = `zind-${name}`;
  await prisma.tour.upsert({
    where: { id: tourId },
    update: { plan },
    create: { id: tourId, workspaceId, name: `Zillow sample home ${name}`, plan, sourceUrl: SOURCE_URL, license: LICENSE, attribution: ATTRIBUTION },
  });

  // Every photo taken indoors. The "primary" one of each room is the one a reel stops at;
  // the others are passed on the way, so a walk always has a photo of where it is.
  const panos = Object.values(data.merger[floorId] ?? {})
    .flatMap((complete) => Object.values(complete))
    .flatMap((partial) => Object.values(partial))
    .filter((pano) => pano.is_inside)
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary));

  const seen: Record<string, number> = {};
  const shots: TourShot[] = [];
  let imported = 0;
  for (const pano of panos) {
    const file = path.join(dir, pano.image_path);
    if (!existsSync(file)) continue;
    const [x, y] = toPlan(...pano.floor_plan_transformation.translation);
    const aim = windowAim(pano);
    const shell = shellFor(pano, toPlan, height);
    const spot: Spot = {
      x,
      y,
      heading: headingFor(pano.floor_plan_transformation.rotation),
      ...(aim === undefined ? {} : { aim }),
      ...(pano.is_primary ? {} : { primary: false }),
      ...(shell ? { shell } : {}),
    };
    seen[pano.label] = (seen[pano.label] ?? 0) + 1;
    const title = `${roomTitle(pano.label)}${seen[pano.label] > 1 ? ` ${seen[pano.label]}` : ""} (360)`;
    const objectKey = `library/zind/${name}/${path.basename(pano.image_path)}`;

    let asset = await prisma.mediaAsset.findUnique({ where: { objectKey } });
    if (!asset) {
      const thumb = path.join(workdir, `${path.basename(pano.image_path, ".jpg")}-thumb.jpg`);
      await panoThumbnail(file, thumb);
      const { width, height } = await probe(file);
      const sizeBytes = await upload(objectKey, file, "image/jpeg");
      const thumbKey = `thumbs/${objectKey}`;
      await upload(thumbKey, thumb, "image/jpeg");
      asset = await prisma.mediaAsset.create({
        data: {
          workspaceId,
          kind: "IMAGE",
          objectKey,
          thumbKey,
          contentType: "image/jpeg",
          fileName: title,
          sizeBytes,
          width,
          height,
          sourceUrl: SOURCE_URL,
          license: LICENSE,
          attribution: ATTRIBUTION,
          tourId,
          spot,
          room: pano.label,
        },
      });
      imported++;
    } else {
      // Keep positions and window aims current for photos imported earlier.
      await prisma.mediaAsset.update({ where: { id: asset.id }, data: { spot, room: pano.label } });
    }
    shots.push({ assetId: asset.id, room: pano.label, spot, isPano: true, passing: !pano.is_primary });
  }
  console.log(`${name}: ${plan.rooms.length} rooms on the plan, ${shots.length} located 360 photos (${imported} new)`);

  await createSampleReel(tourId, name, workspaceId, plan, shots);
  await createVibeReels(tourId, name, workspaceId, plan, shots);
}

/** The same home cut for five audiences: one sample reel per vibe. */
async function createVibeReels(tourId: string, name: string, workspaceId: string, plan: Plan, shots: TourShot[]): Promise<void> {
  const details = listingDetailsSchema.parse({ price: "$485,000", beds: "3", baths: "2", area: "1,640 sq ft", address: "Sample home (ZInD)", placement: "end" });
  for (const vibe of VIBES) {
    const id = `sample-${tourId}-${vibe.id}`;
    if (process.env.RESET_SAMPLES === "1") await prisma.reel.deleteMany({ where: { id, workspaceId } });
    if (await prisma.reel.count({ where: { id } })) continue;

    const song = await prisma.mediaAsset.findUnique({ where: { objectKey: `library/music/${vibe.song}.mp3` } });
    const timeline = buildTourReel({
      shots,
      plan,
      details,
      music: song ? { assetId: song.id, sourceStartMs: 0, volume: 0.8, bpm: song.bpm, beatOffsetMs: song.beatOffsetMs } : null,
      vibe,
    });
    if (!timeline) continue;
    await prisma.reel.create({
      data: {
        id,
        workspaceId,
        title: `${vibe.name} (ZInD ${name})`,
        caption: `${captionForVibe(vibe, details, song?.attribution)}\n\nLocal test reel: ZInD is licensed for academic use only, so this is not for posting.`,
        timeline,
      },
    });
    console.log(`${name}: "${vibe.name}" reel created with ${timeline.clips.filter((clip) => clip.room).length} rooms`);
  }
}

/** A first draft from the auto-builder: viewing order, sweeps to the windows, plan, room names, music. */
async function createSampleReel(tourId: string, name: string, workspaceId: string, plan: Plan, shots: TourShot[]): Promise<void> {
  const id = `sample-${tourId}`;
  if (process.env.RESET_SAMPLES === "1") await prisma.reel.deleteMany({ where: { id, workspaceId } });
  // Otherwise never overwrite: you may have edited it.
  if (await prisma.reel.count({ where: { id } })) return;

  // Music from the open library, if it has been imported.
  const song =
    (await prisma.mediaAsset.findUnique({ where: { objectKey: "library/music/wallpaper.mp3" } })) ??
    (await prisma.mediaAsset.findFirst({ where: { workspaceId, kind: "AUDIO", bpm: { not: null } }, orderBy: { fileName: "asc" } }));
  const timeline = buildTourReel({
    shots,
    plan,
    music: song ? { assetId: song.id, sourceStartMs: 0, volume: 0.7, bpm: song.bpm, beatOffsetMs: song.beatOffsetMs } : null,
    details: listingDetailsSchema.parse({ price: "$485,000", beds: "3", baths: "2", area: "1,640 sq ft", address: "Sample home (ZInD)", placement: "end" }),
  });
  if (!timeline) return;

  await prisma.reel.create({
    data: {
      id,
      workspaceId,
      title: `Floor plan walkthrough (ZInD ${name})`,
      caption: `Local test reel made from the Zillow Indoor Dataset sample tour. Not for posting: ZInD is licensed for academic use only.${song?.attribution ? `

Music: ${song.attribution}` : ""}`,
      timeline,
    },
  });
  console.log(`${name}: sample reel created with ${timeline.clips.length} rooms${song ? `, music at ${song.bpm} bpm` : ""}`);
}

async function main() {
  if (!existsSync(TOURS_DIR)) {
    console.error(`No ZInD tours found at ${TOURS_DIR}. Copy a ZInD tour folder (for example sample_tour from the zind repository) to data/zind/.`);
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email: DEFAULT_USER_EMAIL } });
  if (!user) throw new Error("Demo user missing. Run the migrate service first.");

  const workdir = await mkdtemp(path.join(os.tmpdir(), "reelwalk-zind-"));
  const tours = (await readdir(TOURS_DIR, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && existsSync(path.join(TOURS_DIR, entry.name, "zind_data.json")),
  );
  for (const tour of tours) await importTour(path.join(TOURS_DIR, tour.name), tour.name, user.workspaceId, workdir);
  await rm(workdir, { recursive: true, force: true });
  console.log(`Imported ${tours.length} tour(s).`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
