import { beforeEach, describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
const { db, decode, findFace, execute } = vi.hoisted(() => ({
  db: { presenter: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() }, mediaAsset: { findFirst: vi.fn() } },
  decode: vi.fn(), findFace: vi.fn(), execute: vi.fn(),
}));
vi.mock("@reelwalk/db", () => ({ prisma: db }));
vi.mock("node:util", () => ({ promisify: () => execute }));
vi.mock("../src/ai-frames", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai-frames")>()), decodeFrame: decode }));
vi.mock("../src/vertex-images", () => ({ VertexImages: class { findFace = findFace; } }));
import { processPresenterKit } from "../src/presenter-kits";

/** A PNG header for a 941×1672 image. */
function png(width: number, height: number) {
  const bytes = Buffer.alloc(200);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
const s3 = { config: {}, send: vi.fn() } as unknown as S3Client;
const kit = { id: "kit", workspaceId: "w", portraitAssetId: "portrait", faceCropTries: 0, createdAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  db.presenter.findFirst.mockResolvedValue(kit); db.presenter.updateMany.mockResolvedValue({ count: 1 });
  db.mediaAsset.findFirst.mockResolvedValue({ objectKey: "uploads/w/portrait.png" });
  decode.mockResolvedValue(png(941, 1672));
  execute.mockResolvedValue({ stdout: png(768, 768) });
});

describe("presenter kit face crop (ADR 0056)", () => {
  it("finds her face in the owned portrait and stores a 768×768 PNG beside the kit", async () => {
    findFace.mockResolvedValue([355, 480, 415, 560]);
    expect(await processPresenterKit(s3, "media")).toBe(true);
    expect(db.mediaAsset.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "portrait", workspaceId: "w", kind: "IMAGE" } }));
    expect(decode).toHaveBeenCalledWith(s3, "media", "uploads/w/portrait.png", 0, "reference-png");
    expect(execute.mock.calls[0][1].join(" ")).toContain("scale=768:768");
    const put = (s3.send as ReturnType<typeof vi.fn>).mock.calls[0][0].input;
    expect(put).toMatchObject({ Key: "workspaces/w/presenters/kit/face.png", ContentType: "image/png" });
    expect(db.presenter.update).toHaveBeenCalledWith({ where: { id: "kit" }, data: { faceCropKey: "workspaces/w/presenters/kit/face.png", faceHeightPx: 100, leaseUntil: null } });
  });
  it("says so when the portrait has no clear face, without retrying", async () => {
    findFace.mockResolvedValue(null);
    await processPresenterKit(s3, "media");
    expect(s3.send).not.toHaveBeenCalled();
    expect(db.presenter.update).toHaveBeenCalledWith({ where: { id: "kit" }, data: expect.objectContaining({ faceCropError: expect.stringContaining("No clear face") }) });
  });
  it("does nothing when another worker holds the lease, and nothing is waiting", async () => {
    db.presenter.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await processPresenterKit(s3, "media")).toBe(true);
    expect(decode).not.toHaveBeenCalled();
    db.presenter.findFirst.mockResolvedValueOnce(null);
    expect(await processPresenterKit(s3, "media")).toBe(false);
  });
  it("gives up with a message after the third failed try", async () => {
    db.presenter.findFirst.mockResolvedValue({ ...kit, faceCropTries: 2 });
    findFace.mockRejectedValue(new Error("HTTP 503"));
    await processPresenterKit(s3, "media");
    expect(db.presenter.update).toHaveBeenCalledWith({ where: { id: "kit" }, data: { leaseUntil: null, faceCropError: expect.stringContaining("could not be made") } });
  });
});
