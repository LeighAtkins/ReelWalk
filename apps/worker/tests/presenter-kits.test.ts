import { beforeEach, describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { PRESENTER_CROP_GAVE_UP } from "@reelwalk/core";
const { db, decode, findFace, execute } = vi.hoisted(() => ({
  db: { presenter: { findFirst: vi.fn(), updateMany: vi.fn() }, mediaAsset: { findFirst: vi.fn() } },
  decode: vi.fn(), findFace: vi.fn(), execute: vi.fn(),
}));
vi.mock("@reelwalk/db", () => ({ prisma: db }));
vi.mock("node:util", () => ({ promisify: () => execute }));
vi.mock("node:crypto", () => ({ randomUUID: () => "claim-1" }));
vi.mock("../src/ai-frames", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai-frames")>()), decodeFrame: decode }));
vi.mock("../src/vertex-images", () => ({ VertexImages: class { findFace = findFace; } }));
import { processPresenterKit } from "../src/presenter-kits";

/** A PNG header with this size. */
function png(width: number, height: number) {
  const bytes = Buffer.alloc(200);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
const s3 = { config: {}, send: vi.fn() } as unknown as S3Client;
const kit = { id: "kit", workspaceId: "w", portraitAssetId: "portrait", faceCropTries: 0, createdAt: new Date() };
const ours = { id: "kit", portraitAssetId: "portrait", leaseToken: "claim-1", faceCropKey: null };
const updates = () => db.presenter.updateMany.mock.calls.map(([args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  db.presenter.findFirst.mockResolvedValue(kit); db.presenter.updateMany.mockResolvedValue({ count: 1 });
  db.mediaAsset.findFirst.mockResolvedValue({ objectKey: "uploads/w/portrait.png" });
  decode.mockResolvedValue(png(941, 1672));
  execute.mockResolvedValue({ stdout: png(768, 768) });
});

describe("presenter kit face crop (ADR 0056)", () => {
  it("claims the kit for its current portrait, and publishes a never-overwritten key only under that claim", async () => {
    findFace.mockResolvedValue({ box: [355, 480, 415, 560], locate: [] });
    expect(await processPresenterKit(s3, "media")).toBe(true);
    const claim = updates().find(args => args.data.leaseToken === "claim-1")!;
    expect(claim.where).toMatchObject({ id: "kit", portraitAssetId: "portrait", faceCropKey: null, faceCropTries: 0 });
    expect(db.mediaAsset.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "portrait", workspaceId: "w", kind: "IMAGE" } }));
    expect(decode).toHaveBeenCalledWith(s3, "media", "uploads/w/portrait.png", 0, "reference-png");
    expect(execute.mock.calls[0][1].join(" ")).toContain("scale=768:768");
    const put = (s3.send as ReturnType<typeof vi.fn>).mock.calls[0][0].input;
    // Per kit, per portrait, per claim: replacing a portrait never changes bytes a queued generation snapshotted.
    expect(put).toMatchObject({ Key: "workspaces/w/presenters/kit/portrait/claim-1.png", ContentType: "image/png" });
    expect(updates().at(-1)).toEqual({ where: ours, data: { faceCropKey: "workspaces/w/presenters/kit/portrait/claim-1.png", faceHeightPx: 100, leaseToken: null, leaseUntil: null } });
  });
  it("a portrait replaced mid-crop keeps the new portrait: the old crop is not published", async () => {
    findFace.mockResolvedValue({ box: [355, 480, 415, 560], locate: [] });
    // Settle, claim, then the publish finds the claim gone (PATCH cleared the token and changed the portrait).
    db.presenter.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await processPresenterKit(s3, "media");
    expect(updates().at(-1)!.where).toEqual(ours);
    expect(updates().filter(args => args.data.faceCropKey)).toHaveLength(1); // only the conditional attempt
  });
  it("says so when the portrait has no clear face, under its claim, without retrying", async () => {
    findFace.mockResolvedValue({ box: null, locate: [] });
    await processPresenterKit(s3, "media");
    expect(s3.send).not.toHaveBeenCalled();
    expect(updates().at(-1)).toEqual({ where: ours, data: { faceCropError: expect.stringContaining("No clear face"), leaseToken: null, leaseUntil: null } });
  });
  it("does nothing when another worker holds the claim, and nothing is waiting", async () => {
    db.presenter.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });
    expect(await processPresenterKit(s3, "media")).toBe(true);
    expect(decode).not.toHaveBeenCalled();
    db.presenter.updateMany.mockResolvedValueOnce({ count: 0 });
    db.presenter.findFirst.mockResolvedValueOnce(null);
    expect(await processPresenterKit(s3, "media")).toBe(false);
  });
  it("gives up with a message after the third failed try", async () => {
    db.presenter.findFirst.mockResolvedValue({ ...kit, faceCropTries: 2 });
    findFace.mockRejectedValue(new Error("HTTP 503"));
    await processPresenterKit(s3, "media");
    expect(updates().at(-1)).toEqual({ where: ours, data: { faceCropError: PRESENTER_CROP_GAVE_UP, leaseToken: null, leaseUntil: null } });
  });
  it("settles a kit whose worker died on the last try, so it never says Preparing forever", async () => {
    db.presenter.findFirst.mockResolvedValueOnce(null);
    await processPresenterKit(s3, "media");
    expect(updates()[0]).toEqual({
      where: { faceCropKey: null, faceCropError: null, faceCropTries: { gte: 3 }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: expect.any(Date) } }] },
      data: { faceCropError: PRESENTER_CROP_GAVE_UP, leaseToken: null, leaseUntil: null },
    });
  });
});
