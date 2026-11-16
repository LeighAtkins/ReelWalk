import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildListingCampaign, buildReelExportPayload, campaignFactsSchema } from "@reelwalk/core";
const mock = vi.hoisted(() => ({
  tx: { $queryRaw: vi.fn(), listingCampaign: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn() }, reel: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn() }, mediaAsset: { count: vi.fn() }, campaignOutput: { create: vi.fn(), update: vi.fn() }, campaignReview: { updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() }, campaignReviewComment: { count: vi.fn(), findUnique: vi.fn(), create: vi.fn() } },
  queue: vi.fn(),
}));
vi.mock("@reelwalk/db", () => ({ prisma: { $transaction: (work: (tx: typeof mock.tx) => unknown) => work(mock.tx) } }));
vi.mock("./export-reel", () => ({ queueReelExport: mock.queue }));
vi.mock("./render-jobs", () => ({ outputUrls: vi.fn() }));
vi.mock("./media-scope", () => ({ mediaScope: (workspaceId: string) => ({ workspaceId }) }));
import { createListingCampaign, respondCampaignReview, reviewCurrent, updateListingCampaign } from "./listing-campaigns";
const user = { id: "user", workspaceId: "workspace" };
const facts = campaignFactsSchema.parse({ address: "Demo address", openHome: "Demo time", disclosure: "Demo source / AI disclosure" });
const source = { version: 1, clips: [{ id: "c1", assetId: "a1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 }], texts: [], music: null };
const cuts = buildListingCampaign(source, facts);
const campaign = () => ({ id: "campaign", workspaceId: "workspace", revision: 0, facts, lastRequestKey: null, lastRequestHash: null, outputs: cuts.map((cut, index) => ({ id: `o${index}`, reelId: `r${index}`, role: cut.role, boundCaption: cut.caption, reel: { id: `r${index}`, workspaceId: "workspace", revision: 2, timeline: cut.timeline, caption: cut.caption } })) });
const update = { revision: 0, requestKey: "efbd0000-0000-4000-8000-000000000001", reels: { r0: 2, r1: 2, r2: 2 }, facts: { ...facts, price: "Demo new price" } };
const payload = buildReelExportPayload(cuts[0].timeline, [{ id: "a1", kind: "VIDEO", objectKey: "private/a1.mp4" }]);
const review = () => ({ revokedAt: null, expiresAt: new Date("2099-01-01"), reelRevision: 2, factRevision: 0, caption: cuts[0].caption, export: { workspaceId: "workspace", reelId: "r0", kind: "REEL", status: "SUCCEEDED", caption: cuts[0].caption, payload }, output: { reelId: "r0", campaign: { workspaceId: "workspace", revision: 0 }, reel: { workspaceId: "workspace", revision: 2, caption: cuts[0].caption, timeline: cuts[0].timeline } } });
beforeEach(() => { vi.clearAllMocks(); mock.tx.$queryRaw.mockResolvedValue([{ id: "locked" }]); mock.tx.listingCampaign.findUniqueOrThrow.mockResolvedValue(campaign()); });

describe("campaign update failure boundaries", () => {
  it("refuses another workspace before touching any reel", async () => {
    mock.tx.$queryRaw.mockResolvedValue([]);
    await expect(updateListingCampaign(user, "foreign", update)).rejects.toThrow(/unavailable/);
    expect(mock.tx.reel.update).not.toHaveBeenCalled();
  });
  it("rechecks reel revision after obtaining locks and never overwrites another tab", async () => {
    const latest = campaign(); latest.outputs[0].reel.revision = 3;
    mock.tx.listingCampaign.findUniqueOrThrow.mockResolvedValueOnce(campaign()).mockResolvedValueOnce(latest);
    await expect(updateListingCampaign(user, "campaign", update)).rejects.toThrow(/another tab/);
    expect(mock.tx.reel.update).not.toHaveBeenCalled();
  });
  it("refuses separately edited copy rather than overwriting it", async () => {
    const latest = campaign(); latest.outputs[0].reel.caption = "Customer caption";
    mock.tx.listingCampaign.findUniqueOrThrow.mockResolvedValue(latest);
    await expect(updateListingCampaign(user, "campaign", update)).rejects.toThrow(/caption was edited separately/);
    expect(mock.tx.reel.update).not.toHaveBeenCalled();
  });
  it("applies all shared facts while preserving source windows and revokes prior reviews", async () => {
    await updateListingCampaign(user, "campaign", update);
    expect(mock.tx.reel.update).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 3; index++) {
      const saved = mock.tx.reel.update.mock.calls[index][0].data;
      expect(saved.timeline.clips).toEqual(cuts[index].timeline.clips);
      expect(saved.timeline.details.price).toBe("Demo new price");
    }
    expect(mock.tx.campaignReview.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { revokedAt: expect.any(Date) } }));
    const savedHash = mock.tx.listingCampaign.update.mock.calls[0][0].data.lastRequestHash;
    mock.tx.listingCampaign.findUniqueOrThrow.mockResolvedValue({ ...campaign(), revision: 1, lastRequestKey: update.requestKey, lastRequestHash: savedHash });
    mock.tx.reel.update.mockClear();
    await updateListingCampaign(user, "campaign", update);
    expect(mock.tx.reel.update).not.toHaveBeenCalled();
    await expect(updateListingCampaign(user, "campaign", { ...update, facts: { ...facts, price: "Different" } })).rejects.toThrow(/already used/);
  });
  it("creates only media-reusing cuts and replays creation without reading changed source", async () => {
    mock.tx.listingCampaign.findUnique.mockResolvedValue(null);
    mock.tx.reel.findFirst.mockResolvedValue({ id: "source", revision: 1, timeline: source });
    mock.tx.mediaAsset.count.mockResolvedValue(1);
    mock.tx.listingCampaign.create.mockResolvedValue({ id: "new-campaign" });
    mock.tx.reel.create.mockResolvedValue({ id: "new-reel" });
    const input = { sourceReelId: "source", sourceRevision: 1, title: "Demo campaign", requestKey: update.requestKey, facts };
    await expect(createListingCampaign(user, input)).resolves.toBe("new-campaign");
    expect(mock.tx.reel.create).toHaveBeenCalledTimes(3);
    expect(mock.queue).not.toHaveBeenCalled();
    const savedHash = mock.tx.listingCampaign.create.mock.calls[0][0].data.creationHash;
    mock.tx.listingCampaign.findUnique.mockResolvedValue({ id: "new-campaign", creationHash: savedHash });
    mock.tx.reel.findFirst.mockClear();
    await expect(createListingCampaign(user, input)).resolves.toBe("new-campaign");
    expect(mock.tx.reel.findFirst).not.toHaveBeenCalled();
    await expect(createListingCampaign(user, { ...input, title: "different" })).rejects.toThrow(/already used/);
  });
});

describe("version-bound client review", () => {
  it("accepts only exact current video, workspace, caption, fact revision and unexpired link", () => {
    expect(reviewCurrent(review())).toBe(true);
    for (const change of [
      (r: ReturnType<typeof review>) => { r.output.reel.revision++; },
      (r: ReturnType<typeof review>) => { r.output.campaign.revision++; },
      (r: ReturnType<typeof review>) => { r.output.reel.caption = "Changed caption"; },
      (r: ReturnType<typeof review>) => { r.export.workspaceId = "other"; },
      (r: ReturnType<typeof review>) => { r.export.reelId = "other"; },
      (r: ReturnType<typeof review>) => { r.export.kind = "PREVIEW"; },
      (r: ReturnType<typeof review>) => { r.export.status = "FAILED"; },
      (r: ReturnType<typeof review>) => { r.expiresAt = new Date(0); },
    ]) { const value = review(); change(value); expect(reviewCurrent(value)).toBe(false); }
  });
  it("rejects stale review responses before writing approval/comments", async () => {
    mock.tx.campaignReview.findUnique.mockResolvedValue({ id: "review", output: { campaign: { workspaceId: "workspace" }, campaignId: "campaign", reelId: "r0" } });
    mock.tx.campaignReview.findUniqueOrThrow.mockResolvedValue({ ...review(), factRevision: 99 });
    await expect(respondCampaignReview("x".repeat(32), { requestKey: update.requestKey, name: "Test reviewer", message: "", approve: true })).rejects.toThrow(/changed/);
    expect(mock.tx.campaignReview.update).not.toHaveBeenCalled();
    expect(mock.tx.campaignReviewComment.create).not.toHaveBeenCalled();
  });
});

describe("review responses", () => {
  it("records approval on this export and an idempotent replay does not write twice", async () => {
    mock.tx.campaignReview.findUnique.mockResolvedValue({ id: "review", output: { campaign: { workspaceId: "workspace" }, campaignId: "campaign", reelId: "r0" } });
    mock.tx.campaignReview.findUniqueOrThrow.mockResolvedValue({ ...review(), id: "review" });
    mock.tx.campaignReviewComment.count.mockResolvedValue(0);
    mock.tx.campaignReviewComment.findUnique.mockResolvedValue(null);
    const input = { requestKey: update.requestKey, name: "Test reviewer", message: "Looks good", approve: true };
    await respondCampaignReview("x".repeat(32), input);
    expect(mock.tx.campaignReview.update).toHaveBeenCalledWith({ where: { id: "review" }, data: { approvedAt: expect.any(Date), reviewerName: "Test reviewer" } });
    mock.tx.campaignReviewComment.findUnique.mockResolvedValue({ name: "Test reviewer", message: "[Approved this version] Looks good" });
    await respondCampaignReview("x".repeat(32), input);
    expect(mock.tx.campaignReviewComment.create).toHaveBeenCalledTimes(1);
    expect(mock.tx.campaignReview.update).toHaveBeenCalledTimes(1);
  });
  it("a new change request withdraws approval and malformed export state fails closed", async () => {
    mock.tx.campaignReview.findUnique.mockResolvedValue({ id: "review", output: { campaign: { workspaceId: "workspace" }, campaignId: "campaign", reelId: "r0" } });
    mock.tx.campaignReview.findUniqueOrThrow.mockResolvedValue({ ...review(), id: "review" });
    mock.tx.campaignReviewComment.count.mockResolvedValue(1);
    mock.tx.campaignReviewComment.findUnique.mockResolvedValue(null);
    await respondCampaignReview("x".repeat(32), { requestKey: update.requestKey, name: "Test reviewer", message: "Change the price", approve: false });
    expect(mock.tx.campaignReview.update).toHaveBeenCalledWith({ where: { id: "review" }, data: { approvedAt: null, reviewerName: null } });
    expect(reviewCurrent({ ...review(), export: { ...review().export, payload: {} } })).toBe(false);
    expect(reviewCurrent({ ...review(), revokedAt: new Date() })).toBe(false);
  });
});
