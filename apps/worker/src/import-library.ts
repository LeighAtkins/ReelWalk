import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DEFAULT_USER_EMAIL, prisma } from "@reelwalk/db";
import { LIBRARY, MIXKIT, POLY_HAVEN, type LibraryItem } from "./library/manifest";
import { sampleReels, type AssetIndex } from "./library/sample-reels";
import { panoThumbnail, probe, run, upload } from "./library/tools";

/**
 * Fills the workspace's media library with openly licensed 360 photos and
 * home videos, and creates sample reels from them. Safe to run again: files
 * already imported are skipped, and existing sample reels are left as they are.
 *
 *   docker compose run --rm import-library
 *
 * To replace the sample reels with the current definitions (this discards
 * edits to them and their exports):
 *
 *   docker compose run --rm -e RESET_SAMPLES=1 import-library
 */

/** Width 360 photos are stored at. 4096 is what the renderer uses and what phones can load. */
const PANO_WIDTH = 4096;

function describe(item: LibraryItem) {
  if (item.kind === "pano") {
    return {
      key: item.id,
      objectKey: `library/pano/${item.id}.jpg`,
      thumbKey: `thumbs/library/pano/${item.id}.jpg`,
      downloadUrl: POLY_HAVEN.fileUrl(item.id),
      sourceUrl: POLY_HAVEN.pageUrl(item.id),
      license: POLY_HAVEN.license,
      attribution: POLY_HAVEN.attribution,
      contentType: "image/jpeg",
      extension: "jpg",
    };
  }
  return {
    key: `mixkit-${item.id}`,
    objectKey: `library/video/mixkit-${item.id}.mp4`,
    thumbKey: `thumbs/library/video/mixkit-${item.id}.jpg`,
    downloadUrl: MIXKIT.fileUrl(item.id, item.quality),
    sourceUrl: MIXKIT.pageUrl(item.slug, item.id),
    license: MIXKIT.license,
    attribution: MIXKIT.attribution,
    contentType: "video/mp4",
    extension: "mp4",
  };
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { headers: { "user-agent": "ReelWalk library importer (local development)" } });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
}

async function importItem(item: LibraryItem, workspaceId: string, workdir: string) {
  const info = describe(item);
  const existing = await prisma.mediaAsset.findUnique({ where: { objectKey: info.objectKey } });
  if (existing) return { key: info.key, asset: existing, imported: false };

  const original = path.join(workdir, `${info.key}-original.${info.extension}`);
  const media = path.join(workdir, `${info.key}.${info.extension}`);
  const thumb = path.join(workdir, `${info.key}-thumb.jpg`);
  await download(info.downloadUrl, original);

  if (item.kind === "pano") {
    await run("ffmpeg", ["-v", "error", "-y", "-i", original, "-vf", `scale=${PANO_WIDTH}:${PANO_WIDTH / 2}:flags=lanczos`, "-q:v", "3", media]);
    await panoThumbnail(media, thumb);
  } else {
    await run("ffmpeg", ["-v", "error", "-y", "-i", original, "-c", "copy", "-movflags", "+faststart", media]);
    await run("ffmpeg", ["-v", "error", "-y", "-ss", "1", "-i", media, "-frames:v", "1", "-vf", "scale=-2:240", "-q:v", "5", thumb]);
  }

  const { width, height, durationMs } = await probe(media);
  const sizeBytes = await upload(info.objectKey, media, info.contentType);
  await upload(info.thumbKey, thumb, "image/jpeg");

  const asset = await prisma.mediaAsset.create({
    data: {
      workspaceId,
      kind: item.kind === "pano" ? "IMAGE" : "VIDEO",
      objectKey: info.objectKey,
      thumbKey: info.thumbKey,
      contentType: info.contentType,
      fileName: item.title,
      sizeBytes,
      durationMs: item.kind === "pano" ? null : durationMs,
      width,
      height,
      sourceUrl: info.sourceUrl,
      license: info.license,
      attribution: info.attribution,
    },
  });
  await Promise.all([original, media, thumb].map((file) => rm(file, { force: true })));
  return { key: info.key, asset, imported: true };
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email: DEFAULT_USER_EMAIL } });
  if (!user) throw new Error("Demo user missing. Run the migrate service first.");
  const workdir = await mkdtemp(path.join(os.tmpdir(), "reelwalk-library-"));

  const index: AssetIndex = {};
  let imported = 0;
  let failed = 0;
  // Three at a time: polite to the sources, and quick enough.
  const queue = [...LIBRARY];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          const result = await importItem(item, user.workspaceId, workdir);
          index[result.key] = { id: result.asset.id, durationMs: result.asset.durationMs };
          if (result.imported) imported++;
          console.log(`${result.imported ? "imported" : "already there"}  ${item.title}`);
        } catch (error) {
          failed++;
          console.warn(`skipped  ${item.title}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }),
  );
  await rm(workdir, { recursive: true, force: true });

  let reels = 0;
  const reset = process.env.RESET_SAMPLES === "1";
  for (const sample of sampleReels(index)) {
    if (reset) await prisma.reel.deleteMany({ where: { id: sample.id, workspaceId: user.workspaceId } });
    // Otherwise never overwrite: you may have edited a sample.
    const exists = await prisma.reel.count({ where: { id: sample.id } });
    if (exists) continue;
    await prisma.reel.create({
      data: { id: sample.id, workspaceId: user.workspaceId, title: sample.title, caption: sample.caption, timeline: sample.timeline },
    });
    reels++;
  }

  console.log(`\nLibrary: ${imported} imported, ${LIBRARY.length - imported - failed} already there, ${failed} skipped. Sample reels created: ${reels}.`);
  await prisma.$disconnect();
  if (failed === LIBRARY.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
