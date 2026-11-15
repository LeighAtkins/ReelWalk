import { beforeEach, expect, it, vi } from "vitest";
import { emptyTimeline, insertShotCard, updateShotCard } from "@reelwalk/core";
const db = vi.hoisted(() => ({ reel: { findFirst: vi.fn(), updateMany: vi.fn(), count: vi.fn() }, mediaAsset: { count: vi.fn() } }));
vi.mock("@reelwalk/db", () => ({ prisma: db }));
vi.mock("./workspace", () => ({ mediaScope: (workspaceId: string) => ({ workspaceId }) }));
vi.mock("./save-fence", () => ({ currentSaveFence: () => null, FenceRefused: class extends Error {} }));
import { saveReelFor } from "./save-reel";
beforeEach(() => { vi.resetAllMocks(); db.reel.findFirst.mockResolvedValue({ timeline: emptyTimeline() }); });
it("rejects another workspace's board source before writing the reel", async () => {
  const timeline = updateShotCard(insertShotCard(emptyTimeline(), "card"), "card", card => ({ ...card, sourceAssetId: "foreign" }));
  db.mediaAsset.count.mockResolvedValue(0);
  expect(await saveReelFor({ workspaceId: "owned" }, { id: "reel", revision: 5, timeline })).toMatchObject({ ok: false, reason: "invalid" });
  expect(db.mediaAsset.count).toHaveBeenCalledWith({ where: { id: { in: ["foreign"] }, workspaceId: "owned" } });
  expect(db.reel.updateMany).not.toHaveBeenCalled();
});
it("saves blank cards with the existing revision fence and reports a two-tab conflict", async () => {
  const timeline = insertShotCard(emptyTimeline(), "blank");
  db.reel.updateMany.mockResolvedValue({ count: 0 }); db.reel.count.mockResolvedValue(1);
  expect(await saveReelFor({ workspaceId: "owned" }, { id: "reel", revision: 5, timeline })).toMatchObject({ ok: false, reason: "conflict" });
  expect(db.reel.updateMany).toHaveBeenCalledWith({ where: { id: "reel", workspaceId: "owned", revision: 5 }, data: { timeline, revision: { increment: 1 } } });
});
