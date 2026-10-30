import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@reelwalk/db";
import type { JobStore } from "../src/handler";
import { createJobStore } from "../src/store";

// The render JobStore's fences against a migrated Postgres (ADR 0094): what a run that lost its job may
// still write. Skipped without DATABASE_URL, like the other database tests.
describe.skipIf(!process.env.DATABASE_URL)("render job store (Postgres)", () => {
  let prisma: PrismaClient;
  let store: JobStore;
  let workspaceId: string;
  const staleBefore = () => new Date(Date.now() - 60_000);

  async function previewJob() {
    const asset = await prisma.mediaAsset.create({
      data: { workspaceId, kind: "VIDEO", objectKey: `uploads/${workspaceId}/${crypto.randomUUID()}.mp4`, contentType: "video/mp4", fileName: "a.mp4", sizeBytes: 1n },
    });
    const job = await prisma.renderJob.create({ data: { workspaceId, kind: "PREVIEW", mediaAssetId: asset.id, route: "local" } });
    return { asset, job };
  }

  beforeAll(async () => {
    ({ prisma } = await import("@reelwalk/db"));
    store = createJobStore(prisma);
    workspaceId = (await prisma.workspace.create({ data: { slug: `render-store-${Date.now()}`, name: "Render store test" } })).id;
  });
  afterAll(async () => {
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("gives each run its own preview key, so a run that lost the job never overwrites the current run's file", async () => {
    const { asset, job } = await previewJob();
    const claimed = await store.claim({ jobId: job.id, generation: 1 }, staleBefore());
    expect(claimed?.previewKey).toBe(`previews/${workspaceId}/${asset.id}-${job.id}-g1a1.mp4`);
  });

  it("publishes a preview's asset update with the success, and not at all once the job has moved", async () => {
    const { asset, job } = await previewJob();
    const claimed = (await store.claim({ jobId: job.id, generation: 1 }, staleBefore()))!;
    const lease = { jobId: job.id, generation: 1, attempt: claimed.attempt };
    // The fallback moves the job to the cloud while this (PC) run is still rendering.
    await prisma.renderJob.update({ where: { id: job.id }, data: { route: "cloud", status: "QUEUED", generation: 2, heartbeatAt: null } });
    expect(await store.heartbeat(lease, 50)).toBe(false);
    const update = { id: asset.id, previewKey: claimed.previewKey!, thumbKey: "thumbs/x-frame-run.jpg", transcript: null };
    expect(await store.succeed(lease, { objectKey: claimed.previewKey!, contentType: "video/mp4", sizeBytes: 10, asset: update })).toBe(false);
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({ previewKey: null, thumbKey: null });

    // The cloud run wins and its keys are the ones published.
    const cloud = (await store.claim({ jobId: job.id, generation: 2 }, staleBefore()))!;
    const cloudLease = { jobId: job.id, generation: 2, attempt: cloud.attempt };
    expect(await store.heartbeat(cloudLease)).toBe(true);
    expect(await store.succeed(cloudLease, { objectKey: cloud.previewKey!, contentType: "video/mp4", sizeBytes: 10, asset: { id: asset.id, previewKey: cloud.previewKey!, thumbKey: "thumbs/cloud.jpg" } })).toBe(true);
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({ previewKey: cloud.previewKey, thumbKey: "thumbs/cloud.jpg" });
    expect(cloud.previewKey).not.toBe(claimed.previewKey);
  });

  it("counts interruptions, which the next claim reports", async () => {
    const job = await prisma.renderJob.create({ data: { workspaceId, kind: "REEL" } });
    for (let i = 1; i <= 2; i++) {
      const claimed = (await store.claim({ jobId: job.id, generation: 1 }, staleBefore()))!;
      expect(claimed.interruptions).toBe(i - 1);
      await store.interrupt({ jobId: job.id, generation: 1, attempt: claimed.attempt }, "stopped");
    }
    expect(await prisma.renderJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "QUEUED", interruptions: 2 });
  });
});
