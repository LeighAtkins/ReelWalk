import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactCompanions, prisma, recordRenderArtifact, renderArtifactKeys, sweepRenderArtifacts } from "../src/index";

describe("artifactCompanions", () => {
  it("brings an export's checks and audio trace with it", () => {
    expect(artifactCompanions("local/ws/renders/job.mp4")).toEqual(["local/ws/renders/job.mp4", "local/ws/renders/job.checks.json", "local/ws/renders/job.mp4.audio.json"]);
    expect(artifactCompanions("previews/ws/a-job-g1a1.jpg")).toEqual(["previews/ws/a-job-g1a1.jpg"]);
    expect(artifactCompanions("local/ws/previews/ws/a-job-g1a1.mp4")).toEqual(["local/ws/previews/ws/a-job-g1a1.mp4"]);
    expect(artifactCompanions("renders/job-2.mp4")).toHaveLength(3);
  });
});

// The sweep decides from rows (who references a key), so it runs against a migrated Postgres.
describe.skipIf(!process.env.DATABASE_URL)("render artifacts (Postgres)", () => {
  const tag = randomUUID().slice(0, 8);
  let workspaceId: string;
  const grace = 24 * 3_600_000;
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  const key = (name: string) => `local/${tag}/${name}`;
  const age = (k: string, hours: number) => prisma.renderArtifact.update({ where: { key: k }, data: { createdAt: hoursAgo(hours) } });

  beforeAll(async () => {
    workspaceId = (await prisma.workspace.create({ data: { slug: `test-artifacts-${tag}`, name: "Artifacts" } })).id;
  });
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.$disconnect();
  });

  it("deletes the files of a preview run that lost its job once the grace has passed, and keeps the winner's", async () => {
    const asset = await prisma.mediaAsset.create({ data: { workspaceId, kind: "VIDEO", objectKey: key("upload.mp4"), contentType: "video/mp4", fileName: "a.mp4", sizeBytes: 1n } });
    const job = await prisma.renderJob.create({ data: { workspaceId, kind: "PREVIEW", mediaAssetId: asset.id } });
    // Two runs of the same job, each with keys of its own: the PC run lost (moved to the cloud), the cloud run won.
    const [lostPreview, lostThumb, wonPreview, wonThumb] = ["p-g1a1.mp4", "t-g1a1.jpg", "p-g2a1.mp4", "t-g2a1.jpg"].map(key);
    for (const k of [lostPreview!, lostThumb!, wonPreview!, wonThumb!]) await recordRenderArtifact(prisma, { key: k, workspaceId, jobId: job.id });
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { previewKey: wonPreview, thumbKey: wonThumb } });

    const deleteObjects = vi.fn(async () => undefined);
    // Within the grace nothing goes: a run may still be writing or publishing.
    expect(await sweepRenderArtifacts(prisma, { graceMs: grace, deleteObjects })).toEqual([]);
    expect(deleteObjects).not.toHaveBeenCalled();

    for (const k of [lostPreview!, lostThumb!, wonPreview!, wonThumb!]) await age(k, 25);
    expect(new Set(await sweepRenderArtifacts(prisma, { graceMs: grace, deleteObjects }))).toEqual(new Set([lostPreview, lostThumb]));
    expect(new Set(deleteObjects.mock.calls.flat(2))).toEqual(new Set([lostPreview, lostThumb]));
    // Every record is settled: the losers' files are gone, the winner's belong to the asset now.
    expect(await prisma.renderArtifact.count({ where: { key: { startsWith: `local/${tag}/` } } })).toBe(0);
  });

  it("deletes a dead run's export with its checks and audio, and keeps an export a job published", async () => {
    const job = await prisma.renderJob.create({ data: { workspaceId, kind: "REEL" } });
    const [dead, published] = [key("renders/dead.mp4"), key("renders/published.mp4")];
    await recordRenderArtifact(prisma, { key: dead, workspaceId, jobId: job.id });
    await recordRenderArtifact(prisma, { key: published, workspaceId, jobId: job.id });
    await prisma.renderOutput.create({ data: { jobId: job.id, objectKey: published, contentType: "video/mp4", sizeBytes: 1 } });
    await age(dead, 30);
    await age(published, 30);
    const deleteObjects = vi.fn(async () => undefined);
    expect(await sweepRenderArtifacts(prisma, { graceMs: grace, deleteObjects })).toEqual([dead]);
    expect(deleteObjects).toHaveBeenCalledWith(artifactCompanions(dead));
  });

  it("never deletes a key a retry has just recorded again, even if the old record was due", async () => {
    const job = await prisma.renderJob.create({ data: { workspaceId, kind: "REEL" } });
    const reused = key("renders/retried.mp4"); // an export key repeats after a manual retry (attempt restarts at 1)
    await recordRenderArtifact(prisma, { key: reused, workspaceId, jobId: job.id });
    await age(reused, 48);
    // The retry starts writing the same key: recording it again makes it new.
    await recordRenderArtifact(prisma, { key: reused, workspaceId, jobId: job.id });
    const deleteObjects = vi.fn(async () => undefined);
    expect(await sweepRenderArtifacts(prisma, { graceMs: grace, deleteObjects })).toEqual([]);
    expect(deleteObjects).not.toHaveBeenCalled();
    expect(await prisma.renderArtifact.count({ where: { key: reused } })).toBe(1);
  });

  it("keeps cached render sources until the workspace goes, and lists every recorded file for account deletion", async () => {
    const job = await prisma.renderJob.create({ data: { workspaceId, kind: "REEL" } });
    const cache = key("render-sources/asset.mp4");
    const orphan = key("renders/orphan.mp4");
    await recordRenderArtifact(prisma, { key: cache, kind: "cache", workspaceId, jobId: job.id });
    await recordRenderArtifact(prisma, { key: orphan, workspaceId, jobId: job.id });
    await age(cache, 100);
    expect(await sweepRenderArtifacts(prisma, { graceMs: grace, deleteObjects: async () => undefined })).not.toContain(cache);
    expect(await renderArtifactKeys(prisma, [workspaceId])).toEqual(expect.arrayContaining([cache, ...artifactCompanions(orphan)]));
    expect(await renderArtifactKeys(prisma, [])).toEqual([]);
  });
});
