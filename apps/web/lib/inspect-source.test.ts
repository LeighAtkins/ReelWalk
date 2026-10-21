import { describe, expect, it } from "vitest";
import { inspectOriginalUrl, INSPECT_URL_SECONDS, type InspectSourceDeps } from "./inspect-source";

function deps(assets: { id: string; workspaceId: string | null; shared?: boolean; objectKey: string; kind: string }[]) {
  const presigned: { key: string; seconds: number }[] = [];
  const wheres: Record<string, unknown>[] = [];
  const d: InspectSourceDeps = {
    // A stand-in for prisma.mediaAsset.findFirst that honours the id and the workspace scope it is given.
    findAsset: async (where) => {
      wheres.push(where);
      const or = (where.OR as { workspaceId?: string; shared?: boolean }[]) ?? [];
      const found = assets.find((a) => a.id === where.id && or.some((c) => (c.workspaceId !== undefined && c.workspaceId === a.workspaceId) || (c.shared === true && a.shared)));
      return found ? { objectKey: found.objectKey, kind: found.kind } : null;
    },
    presign: async (key, seconds) => { presigned.push({ key, seconds }); return `https://s3.example/${key}?X-Amz-Expires=${seconds}`; },
  };
  return { d, presigned, wheres };
}

describe("Inspect's original file", () => {
  const assets = [
    { id: "mine", workspaceId: "ws1", objectKey: "ws1/orig.mp4", kind: "VIDEO" },
    { id: "theirs", workspaceId: "ws2", objectKey: "ws2/orig.mp4", kind: "VIDEO" },
    { id: "starter", workspaceId: null, shared: true, objectKey: "library/pool.mp4", kind: "VIDEO" },
    { id: "song", workspaceId: "ws1", objectKey: "ws1/song.mp3", kind: "AUDIO" },
  ];

  it("presigns the studio's own original for 15 minutes, scoped to the workspace", async () => {
    const { d, presigned, wheres } = deps(assets);
    expect(await inspectOriginalUrl(d, "ws1", "mine")).toEqual({ url: "https://s3.example/ws1/orig.mp4?X-Amz-Expires=900", expiresInSeconds: INSPECT_URL_SECONDS });
    expect(presigned).toEqual([{ key: "ws1/orig.mp4", seconds: 900 }]);
    expect(wheres[0]).toEqual({ id: "mine", OR: [{ workspaceId: "ws1" }, { shared: true }] });
  });

  it("refuses another studio's asset, anything not a picture, and malformed ids, without signing", async () => {
    const { d, presigned } = deps(assets);
    expect(await inspectOriginalUrl(d, "ws1", "theirs")).toBeNull();
    expect(await inspectOriginalUrl(d, "ws1", "song")).toBeNull();
    expect(await inspectOriginalUrl(d, "ws1", { id: "mine" })).toBeNull();
    expect(await inspectOriginalUrl(d, "ws1", "")).toBeNull();
    expect(presigned).toEqual([]);
  });

  it("reads the shared starter library like the editor does", async () => {
    const { d } = deps(assets);
    expect((await inspectOriginalUrl(d, "ws1", "starter"))?.url).toContain("library/pool.mp4");
  });
});
