import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addRoomLabels,
  DEFAULT_PANO,
  normalizePlan,
  roomTitle,
  timelineSchema,
  type Clip,
  type Plan,
  type Spot,
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
};
type ZindData = {
  merger: Record<string, Record<string, Record<string, Record<string, ZindPano>>>>;
  redraw: Record<string, Record<string, { vertices: Point[]; doors: [Point, Point][] }>>;
};

/** Rooms worth a shot in a walkthrough, in the order a viewing would go. */
const WALK_ORDER = ["living room", "dining room", "kitchen", "hallway", "bedroom", "bathroom", "bonus room", "garage"];

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

async function importTour(dir: string, name: string, workspaceId: string, workdir: string): Promise<void> {
  const data = JSON.parse(await readFile(path.join(dir, "zind_data.json"), "utf8")) as ZindData;
  const floorId = Object.keys(data.redraw)[0];
  const rooms = Object.values(data.redraw[floorId]);
  const { plan, toPlan } = normalizePlan(
    rooms.map((room) => room.vertices),
    rooms.flatMap((room) => room.doors),
  );

  const tourId = `zind-${name}`;
  await prisma.tour.upsert({
    where: { id: tourId },
    update: { plan },
    create: { id: tourId, workspaceId, name: `Zillow sample home ${name}`, plan, sourceUrl: SOURCE_URL, license: LICENSE, attribution: ATTRIBUTION },
  });

  // One photo per room: the "primary" one, which the annotators used for the room's shape.
  const panos = Object.values(data.merger[floorId] ?? {})
    .flatMap((complete) => Object.values(complete))
    .flatMap((partial) => Object.values(partial))
    .filter((pano) => pano.is_primary && pano.is_inside);

  const seen: Record<string, number> = {};
  const shots: { assetId: string; room: string; spot: Spot }[] = [];
  let imported = 0;
  for (const pano of panos) {
    const file = path.join(dir, pano.image_path);
    if (!existsSync(file)) continue;
    const [x, y] = toPlan(...pano.floor_plan_transformation.translation);
    const spot: Spot = { x, y, heading: headingFor(pano.floor_plan_transformation.rotation) };
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
    }
    shots.push({ assetId: asset.id, room: pano.label, spot });
  }
  console.log(`${name}: ${plan.rooms.length} rooms on the plan, ${shots.length} located 360 photos (${imported} new)`);

  await createSampleReel(tourId, name, workspaceId, plan, shots);
}

/** A walkthrough in viewing order, with the floor plan marker and room names. */
async function createSampleReel(
  tourId: string,
  name: string,
  workspaceId: string,
  plan: Plan,
  shots: { assetId: string; room: string; spot: Spot }[],
): Promise<void> {
  const id = `sample-${tourId}`;
  // Never overwrite: you may have edited it.
  if (await prisma.reel.count({ where: { id } })) return;

  const route = shots
    .filter((shot) => WALK_ORDER.includes(shot.room))
    .sort((a, b) => WALK_ORDER.indexOf(a.room) - WALK_ORDER.indexOf(b.room))
    .slice(0, 9);
  if (route.length < 3) return;

  const clips: Clip[] = route.map((shot, index) => ({
    id: `clip-${index}`,
    assetId: shot.assetId,
    kind: "IMAGE",
    sourceStartMs: 0,
    sourceEndMs: 4000,
    speed: 1,
    volume: 1,
    fit: "cover",
    filter: "none",
    motion: "none",
    transitionIn: index === 0 ? "cut" : "fade",
    pano: { ...DEFAULT_PANO, yawStart: -50, yawEnd: 50 },
    spot: shot.spot,
    room: shot.room,
  }));
  const timeline = addRoomLabels(
    timelineSchema.parse({ version: 1, clips, texts: [], music: null, plan: { geometry: plan, corner: "top-left", visible: true } }),
  );

  await prisma.reel.create({
    data: {
      id,
      workspaceId,
      title: `Floor plan walkthrough (ZInD ${name})`,
      caption: "Local test reel made from the Zillow Indoor Dataset sample tour. Not for posting: ZInD is licensed for academic use only.",
      timeline,
    },
  });
  console.log(`${name}: sample reel created with ${clips.length} rooms`);
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
