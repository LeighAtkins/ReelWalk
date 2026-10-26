/**
 * Measures the shot analysis (ADR 0086) of videos that already have a 720p preview but no analysis: run once after
 * the shot-analysis migration, for the uploads made before it. Reads each preview from storage, analyses it in this
 * process and writes `MediaAsset.shotAnalysis`. Pass asset ids to do only those.
 *
 *   DATABASE_URL=... MEDIA_BUCKET=... AWS_PROFILE=reelwalk SHOT_MODEL_DIR=<models> pnpm --filter @reelwalk/worker exec tsx scripts/backfill-shot-analysis.ts [assetId ...]
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Prisma, prisma } from "@reelwalk/db";
import { analyseShot } from "../src/shot-analysis";

const bucket = process.env.MEDIA_BUCKET;
if (!bucket) throw new Error("MEDIA_BUCKET is required");
const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-2" });
const ids = process.argv.slice(2);
const assets = await prisma.mediaAsset.findMany({
  where: { kind: "VIDEO", previewKey: { not: null }, ...(ids.length ? { id: { in: ids } } : { shotAnalysis: { equals: Prisma.DbNull } }) },
  select: { id: true, fileName: true, previewKey: true, width: true, height: true, durationMs: true },
});
const dir = await mkdtemp(path.join(tmpdir(), "shot-backfill-"));
try {
  for (const asset of assets) {
    if (!asset.width || !asset.height) { console.log(`skip ${asset.id} (${asset.fileName}): no size recorded`); continue; }
    const file = path.join(dir, `${asset.id}.mp4`);
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: asset.previewKey! }));
    await pipeline(object.Body as Readable, createWriteStream(file));
    const analysis = await analyseShot({ input: file, durationMs: asset.durationMs ?? 0, width: asset.width, height: asset.height });
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { shotAnalysis: analysis as never } });
    await rm(file, { force: true });
    console.log(`analysed ${asset.id} (${asset.fileName}): ${analysis.samples.length} samples, ${analysis.cost?.cpuMs} ms cpu`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
}
