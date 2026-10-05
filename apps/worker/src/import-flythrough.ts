import { readdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listingDetailsSchema, parseTimeline, timelineSchema, type TextOverlay } from "@reelwalk/core";
import { DEFAULT_USER_EMAIL, prisma } from "@reelwalk/db";
import { probe, run, upload } from "./library/tools";

/**
 * Adds flythrough videos rendered from Gaussian splats (see
 * infra/splat/reconstruct.sh) to the media library, where they are ordinary
 * video clips, and creates a sample reel from each. Safe to run again: a
 * flythrough already imported is replaced only when REPLACE=1, and a sample
 * reel only when RESET_SAMPLES=1.
 *
 *   docker compose run --rm import-flythrough
 */

const SOURCE_DIR = process.env.SPLAT_DIR ?? "/data/splat";
const SUFFIX = "-reel.mp4";

type Source = { sourceUrl: string; license: string; attribution: string };

/**
 * Where each scene's photos come from. Both are research data, so the
 * flythroughs are for local testing and not for posting.
 */
const HOUSE_SOURCE: Source = {
  sourceUrl: "https://github.com/zillow/zind",
  license: "ZInD Terms of Use (academic, non-commercial)",
  attribution: "Zillow Indoor Dataset",
};
const ROOM_SOURCE: Source = {
  sourceUrl: "https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/",
  license: "Research dataset: testing only",
  attribution: "Scene photos: Deep Blending (Hedman et al. 2018), via the 3D Gaussian Splatting dataset",
};
const sourceFor = (scene: string): Source => (scene === "house" ? HOUSE_SOURCE : ROOM_SOURCE);

/**
 * The house flythrough follows the camera route of this reel frame for
 * frame (see infra/splat/house.sh), so that reel's room names fit it as they are.
 */
const HOUSE_ROUTE_REEL = "sample-zind-000";

function title(scene: string): string {
  return `${scene.charAt(0).toUpperCase()}${scene.slice(1)} flythrough`;
}

/** One continuous move through the room, with a title, music and the listing details. */
async function createSampleReel(scene: string, workspaceId: string, assetId: string, durationMs: number): Promise<void> {
  const id = `sample-flythrough-${scene}`;
  if (process.env.RESET_SAMPLES === "1") await prisma.reel.deleteMany({ where: { id, workspaceId } });
  // Otherwise never overwrite: you may have edited it.
  if (await prisma.reel.count({ where: { id } })) return;

  // Music from the open library, if it has been imported.
  const song =
    (await prisma.mediaAsset.findUnique({ where: { objectKey: "library/music/life-of-riley.mp3" } })) ??
    (await prisma.mediaAsset.findFirst({ where: { workspaceId, kind: "AUDIO", bpm: { not: null } }, orderBy: { fileName: "asc" } }));
  // The house was filmed along a tour reel's route: reuse that reel's room names and details.
  const route = scene === "house" ? await prisma.reel.findUnique({ where: { id: HOUSE_ROUTE_REEL } }) : null;
  const routeTimeline = route ? parseTimeline(route.timeline) : null;
  const texts: TextOverlay[] = routeTimeline
    ? routeTimeline.texts.filter((text) => text.endMs <= durationMs + 100).map((text) => ({ ...text, endMs: Math.min(text.endMs, durationMs) }))
    : [{ id: "title", text: "Step inside", startMs: 400, endMs: 3400, style: "headline", color: "#ffffff", size: 1, x: 0.5, y: 0.22 }];
  const timeline = timelineSchema.parse({
    version: 1,
    clips: [
      {
        id: `clip-flythrough-${scene}`,
        assetId,
        kind: "VIDEO",
        sourceStartMs: 0,
        sourceEndMs: durationMs,
        speed: 1,
        volume: 0,
        fit: "cover",
        filter: "none",
        motion: "none",
        transitionIn: "fade",
        pano: null,
        spot: null,
        room: null,
      },
    ],
    texts,
    music: song ? { assetId: song.id, sourceStartMs: 0, volume: 0.7, bpm: song.bpm, beatOffsetMs: song.beatOffsetMs } : null,
    plan: null,
    details:
      routeTimeline?.details ??
      listingDetailsSchema.parse({ price: "$512,000", beds: "4", baths: "2", area: "1,910 sq ft", address: "Sample home (3D flythrough)", placement: "end" }),
  });
  await prisma.reel.create({
    data: {
      id,
      workspaceId,
      title: scene === "house" ? "Whole-home splat flythrough (ZInD)" : `3D flythrough (${scene})`,
      caption: `Local test reel: a camera move rendered from a 3D reconstruction of the room. Not for posting: the photos come from a research dataset.${song?.attribution ? `

Music: ${song.attribution}` : ""}`,
      timeline,
    },
  });
  console.log(`sample reel created  ${title(scene)}`);
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email: DEFAULT_USER_EMAIL } });
  if (!user) throw new Error("Demo user missing. Run the migrate service first.");
  const files = (await readdir(SOURCE_DIR).catch(() => [])).filter((file) => file.endsWith(SUFFIX));
  if (files.length === 0) {
    console.log(`No flythroughs in ${SOURCE_DIR}. Render one with infra/splat/reconstruct.sh first.`);
    return;
  }
  const workdir = await mkdtemp(path.join(os.tmpdir(), "reelwalk-flythrough-"));

  for (const file of files) {
    const scene = file.slice(0, -SUFFIX.length);
    const objectKey = `library/flythrough/${scene}.mp4`;
    const thumbKey = `thumbs/library/flythrough/${scene}.jpg`;
    const existing = await prisma.mediaAsset.findUnique({ where: { objectKey } });
    if (existing && process.env.REPLACE !== "1") {
      console.log(`already there  ${title(scene)}`);
      if (existing.durationMs) await createSampleReel(scene, user.workspaceId, existing.id, existing.durationMs);
      continue;
    }

    const media = path.join(workdir, `${scene}.mp4`);
    const thumb = path.join(workdir, `${scene}.jpg`);
    // Re-encoded so the browser can start playing before the whole file arrives.
    await run("ffmpeg", ["-v", "error", "-y", "-i", path.join(SOURCE_DIR, file), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", media]);
    await run("ffmpeg", ["-v", "error", "-y", "-ss", "1", "-i", media, "-frames:v", "1", "-vf", "scale=-2:240", "-q:v", "5", thumb]);
    const { width, height, durationMs } = await probe(media);
    const sizeBytes = await upload(objectKey, media, "video/mp4");
    await upload(thumbKey, thumb, "image/jpeg");

    const data = { sizeBytes, durationMs, width, height, ...sourceFor(scene) };
    const asset = await prisma.mediaAsset.upsert({
      where: { objectKey },
      update: data,
      create: { workspaceId: user.workspaceId, kind: "VIDEO", objectKey, thumbKey, contentType: "video/mp4", fileName: title(scene), ...data },
    });
    console.log(`imported  ${title(scene)} (${width}x${height}, ${((durationMs ?? 0) / 1000).toFixed(1)} s)`);
    if (durationMs) await createSampleReel(scene, user.workspaceId, asset.id, durationMs);
  }
  await rm(workdir, { recursive: true, force: true });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
