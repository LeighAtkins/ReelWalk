import { beforeEach, describe, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", async original => {
  const actual = await original<typeof import("@aws-sdk/client-s3")>();
  return { ...actual, S3Client: class { send = send; } };
});
import { deleteObjects, keyframeObjectKeys } from "./storage";
beforeEach(() => vi.resetAllMocks());
describe("private keyframe deletion inventory", () => {
  it("collects every page, including orphan writes and unaccepted images, only under exact deleted workspace prefixes", async () => {
    send.mockResolvedValueOnce({ IsTruncated: true, NextContinuationToken: "next", Contents: [{ Key: "private/keyframes/owned/request/source.png" }, { Key: "private/keyframes/owned/receipts/job.json" }] })
      .mockResolvedValueOnce({ Contents: [{ Key: "private/keyframes/owned/candidates/unaccepted.jpg" }, { Key: "private/keyframes/owned/failed-write/request.json" }, { Key: "private/keyframes/owned-other/photo.png" }, { Key: "shared/original.png" }] })
      .mockResolvedValueOnce({ Contents: [] });
    expect(await keyframeObjectKeys(["owned", "empty"])).toEqual(["private/keyframes/owned/request/source.png", "private/keyframes/owned/receipts/job.json", "private/keyframes/owned/candidates/unaccepted.jpg", "private/keyframes/owned/failed-write/request.json"]);
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      expect.objectContaining({ Prefix: "private/keyframes/owned/", ContinuationToken: undefined }),
      expect.objectContaining({ Prefix: "private/keyframes/owned/", ContinuationToken: "next" }),
      expect.objectContaining({ Prefix: "private/keyframes/empty/" }),
    ]);
  });
  it("fails rather than accepting an incomplete inventory", async () => {
    send.mockResolvedValueOnce({ IsTruncated: true });
    await expect(keyframeObjectKeys(["owned"])).rejects.toThrow("enumerate all");
    send.mockRejectedValueOnce(Error("storage unavailable"));
    await expect(keyframeObjectKeys(["owned"])).rejects.toThrow("storage unavailable");
  });
  it("rejects partial storage deletion errors instead of reporting success", async () => {
    send.mockResolvedValue({ Errors: [{ Key: "private/keyframes/owned/source.png", Code: "AccessDenied" }] });
    await expect(deleteObjects(["private/keyframes/owned/source.png"])).rejects.toThrow("delete every");
  });
});
